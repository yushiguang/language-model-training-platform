import {DEFAULT_TENANT, DocFieldValue, type AddSourceFileRequest, type CreateDataSourceRequest, type DataSource, type DataSourceDetail, type DataSourceSummary, type DatasetSourceLine, type Example, type Job, type JobControl, type JobOutcome, type SourceChunk, type SourceCut, type SourceFile, type SourcePick, type SourceUploadResult} from '@yushiguang/sprint-contracts';
import {hashString, newId, readItemIdFile, seededShuffle} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';

/**
 * Data sources (#29, #30): a tenant's files of item ids, shared by its projects.
 *
 * A source has no versions: every file uploaded to it counts, and each file's new items are
 * shuffled once (with a recorded seed) and appended to the source's one order. A dataset takes a
 * continuous segment of that order from where the last one ended (`DataSource.next`), so two
 * datasets never share an item, and the same cut always gives the same items. A deleted project's
 * segments are retired and never handed out again.
 *
 * Writes to one source's order and to its `next` run under a lock on the source, so two imports or
 * two cuts never take the same positions.
 */

/** Ids per stored chunk of a source's order. */
const CHUNK = 1000;
const BUILT_IN_SEED = 'built-in';

/** The caller's tenant; `DEFAULT_TENANT` when the context names none (the browser build). */
export const tenantOf = (w: Scope) => w.ctx.tenantId ?? DEFAULT_TENANT;

/** Runs `fn` holding the lock `name`, waiting while someone else holds it. */
async function withLock<T>(w: Scope, name: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 1200; i++) {
    const r = await w.locks.run(name, async () => ({value: await fn()}));
    if (r) return r.value;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('The data source is busy. Try again in a minute.');
}

/** The caller's tenant's source, or an error a page can show. */
async function ownSource(w: Scope, sourceId: string): Promise<DataSource> {
  const src = await w.catalog.get('data_sources', sourceId);
  if (!src || src.tenantId !== tenantOf(w)) throw new Error('This data source does not exist.');
  return src;
}

/**
 * The sample data that ships with the platform, as a built-in source of the tenant (made the first
 * time the tenant's sources are read). Without `ExampleSource.builtIn` there is none.
 */
async function ensureBuiltIn(w: Scope): Promise<void> {
  if (!w.examples.builtIn) return;
  const tenantId = tenantOf(w);
  const id = `src_builtin_${hashString(tenantId)}`;
  if (await w.catalog.get('data_sources', id)) return;
  await withLock(w, `source:${id}`, async () => {
    if (await w.catalog.get('data_sources', id)) return;
    const {name, ids} = await w.examples.builtIn!();
    const at = now();
    const fileId = `sf_builtin_${hashString(tenantId)}`;
    const order = seededShuffle([...new Set(ids)], BUILT_IN_SEED);
    const file: SourceFile = {id: fileId, sourceId: id, tenantId, name, rows: ids.length, bad: 0, repeats: ids.length - order.length, items: order.length, seed: BUILT_IN_SEED, start: 0, state: 'done', done: order.length, uploadedAt: at, uploadedBy: 'Sprint'};
    await w.catalog.insertMany('source_chunks', chunksOf(id, fileId, 0, order));
    await w.catalog.insert('source_files', file);
    // The source goes last: one cut short is made again from the start next time.
    await w.catalog.insert('data_sources', {id, tenantId, name, builtIn: true, items: order.length, files: 1, next: 0, createdAt: at, createdBy: 'Sprint', updatedAt: at});
  });
}

function chunksOf(sourceId: string, fileId: string, start: number, ids: string[], staged = false): SourceChunk[] {
  const out: SourceChunk[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push({id: newId('sc'), sourceId, fileId, start: start + i, ids: ids.slice(i, i + CHUNK), ...(staged ? {staged: true} : {})});
  return out;
}

/** The files with their positions, taking a reservation not yet copied to its file from the source. */
function placed(src: DataSource, files: SourceFile[]): SourceFile[] {
  const r = src.reserved;
  return files.map(f => (f.start == null && r?.fileId === f.id ? {...f, start: r.start, items: r.items} : f));
}

/**
 * Reserved positions with no item written: the rest of each importing or failed file's positions
 * (a file is written in order from its start). `failed`: never written, so a cut skips them.
 */
function holes(src: DataSource, files: SourceFile[]): {from: number; to: number; failed: boolean}[] {
  return placed(src, files)
    .filter(f => f.state !== 'done' && f.start != null && f.done < f.items)
    .map(f => ({from: f.start! + f.done, to: f.start! + f.items, failed: f.state === 'failed'}));
}

function summary(src: DataSource, files: SourceFile[]): DataSourceSummary {
  const importing = placed(src, files).filter(f => f.state === 'importing');
  // `src.items` counts reserved positions; ones not written are not items anyone can take.
  const hs = holes(src, files);
  const items = src.items - hs.reduce((n, h) => n + h.to - h.from, 0);
  const unusedHoles = hs.reduce((n, h) => n + Math.max(0, h.to - Math.max(src.next, h.from)), 0);
  return {
    id: src.id,
    name: src.name,
    builtIn: !!src.builtIn,
    files: files.length,
    items,
    notUsed: Math.max(0, src.items - src.next - unusedHoles),
    createdBy: src.createdBy,
    updatedAt: src.updatedAt,
    // Before its positions are reserved, a file's size is its rows less the bad ones and repeats.
    importing: importing.length ? {done: importing.reduce((n, f) => n + f.done, 0), total: importing.reduce((n, f) => n + (f.start == null ? f.rows - f.bad - f.repeats : f.items), 0)} : null,
  };
}

/** How long an import may wait for its job before a page treats it as stopped. */
const STUCK_MS = 2 * 60_000;

/**
 * Marks imports whose job has ended without them as failed: a job the job module gave up on (its
 * runner died too often) never reaches `runIngest`'s own failure handling.
 */
async function settleStuck(w: Scope, files: SourceFile[]): Promise<boolean> {
  const old = files.filter(f => f.state === 'importing' && Date.now() - Date.parse(f.uploadedAt) > STUCK_MS);
  if (!old.length) return false;
  const active = new Set((await w.jobs.list(w.ctx, {kinds: ['source.ingest'], states: ['queued', 'running']})).map(j => String(j.args.fileId)));
  const stuck = old.filter(f => !active.has(f.id));
  for (const f of stuck) await markFailed(w, f.id, 'The import stopped. Upload the file again.').catch(() => undefined);
  return stuck.length > 0;
}

export async function listDataSources(w: Scope): Promise<DataSourceSummary[]> {
  await ensureBuiltIn(w);
  const tenantId = tenantOf(w);
  const read = () => Promise.all([w.catalog.find('data_sources', {tenantId}), w.catalog.find('source_files', {tenantId})]);
  let [sources, files] = await read();
  if (await settleStuck(w, files)) [sources, files] = await read();
  return sources
    .sort((a, b) => Number(!!a.builtIn) - Number(!!b.builtIn) || b.updatedAt.localeCompare(a.updatedAt))
    .map(s => summary(s, files.filter(f => f.sourceId === s.id)));
}

export async function getDataSource(w: Scope, sourceId: string): Promise<DataSourceDetail | null> {
  await ensureBuiltIn(w);
  const src = await w.catalog.get('data_sources', sourceId);
  if (!src || src.tenantId !== tenantOf(w)) return null;
  const read = () => Promise.all([w.catalog.get('data_sources', sourceId), w.catalog.find('source_files', {sourceId}, 'uploadedAt desc'), w.catalog.find('source_cuts', {sourceId})]);
  let [fresh, files, cuts] = await read();
  if (await settleStuck(w, files)) [fresh, files, cuts] = await read();
  const live = cuts.filter(c => !c.retired);
  const source = summary(fresh!, files);
  return {source, files: placed(fresh!, files), taken: source.items - source.notUsed, projects: new Set(live.map(c => c.projectId)).size};
}

export async function createDataSource(w: Scope, req: CreateDataSourceRequest): Promise<SourceUploadResult> {
  const name = req.name.trim();
  if (!name) return {error: 'Give the data source a name.'};
  const read = readItemIdFile(req.fileName, req.text);
  if ('error' in read) return {error: read.error};
  // The built-in source is made first, so its name is taken too.
  await ensureBuiltIn(w);
  const tenantId = tenantOf(w);
  const user = await w.user();
  // The name check and the insert hold the tenant's lock: two creates never make one name twice.
  return withLock(w, `sources:${tenantId}`, async () => {
    if ((await w.catalog.find('data_sources', {tenantId})).some(s => s.name.toLowerCase() === name.toLowerCase())) return {error: 'A data source with this name already exists.'};
    const at = now();
    const src: DataSource = {id: newId('src'), tenantId, name, items: 0, files: 1, next: 0, createdAt: at, createdBy: user.name, createdById: user.id, updatedAt: at};
    // The file is staged first and the source goes last: a create cut short leaves no empty source.
    const file = await stageFile(w, src, req.fileName, read);
    await w.catalog.insert('data_sources', src);
    return queued(w, src, file, read);
  });
}

export async function addSourceFile(w: Scope, req: AddSourceFileRequest): Promise<SourceUploadResult> {
  const src = await ownSource(w, req.sourceId);
  if (src.builtIn) return {error: "Files can't be added to the built-in sample data."};
  const read = readItemIdFile(req.fileName, req.text);
  if ('error' in read) return {error: read.error};
  const file = await stageFile(w, src, req.fileName, read);
  await w.catalog.patch('data_sources', src.id, {files: DocFieldValue.increment(1), updatedAt: file.uploadedAt});
  return queued(w, src, file, read);
}

type ReadFile = {ids: string[]; rows: number; bad: number; repeats: number};

/** Saves the file's ids as staged chunks, and the file. */
async function stageFile(w: Scope, src: DataSource, fileName: string, read: ReadFile): Promise<SourceFile> {
  const user = await w.user();
  const file: SourceFile = {id: newId('sf'), sourceId: src.id, tenantId: src.tenantId, name: fileName, rows: read.rows, bad: read.bad, repeats: read.repeats, items: 0, seed: newId('seed'), state: 'importing', done: 0, uploadedAt: now(), uploadedBy: user.name};
  await w.catalog.insertMany('source_chunks', chunksOf(src.id, file.id, 0, read.ids, true));
  await w.catalog.insert('source_files', file);
  return file;
}

/** Queues the file's import (`source.ingest`) once its source is saved. */
async function queued(w: Scope, src: DataSource, file: SourceFile, read: ReadFile): Promise<SourceUploadResult> {
  await w.jobs.enqueue(w.ctx, {kind: 'source.ingest', projectId: null, args: {fileId: file.id}, idempotencyKey: `source.ingest:${file.id}`});
  await w.catalog.audit(null, file.uploadedBy, 'data_source.file_added', {sourceId: src.id, fileId: file.id, rows: read.rows, bad: read.bad, repeats: read.repeats});
  w.tm.event('source_file_uploaded', {rows: read.rows, bad: read.bad, repeats: read.repeats});
  w.emitChange(null);
  const files = await w.catalog.find('source_files', {sourceId: src.id});
  return {source: summary((await w.catalog.get('data_sources', src.id))!, files), file};
}

/** Times a failed import is tried again before its file is marked failed. */
export const INGEST_RETRIES = 2;

/**
 * Copies the source's last reservation to its file when a run stopped between the two writes
 * (the source's is written first, in the same update as `items`).
 */
async function settleReservation(w: Scope, src: DataSource): Promise<void> {
  const r = src.reserved;
  if (!r) return;
  const file = await w.catalog.get('source_files', r.fileId);
  if (file && file.start == null) await w.catalog.patch('source_files', file.id, {start: r.start, items: r.items, repeats: r.repeats});
}

/**
 * The `source.ingest` executor: writes a staged file into its source's order. Under the source's
 * lock it reserves the positions (recorded on the source in the same update as its size, then on
 * the file, so a run cut short goes on with the same ones), leaves out ids already in the source,
 * shuffles the rest with the file's seed and writes them in chunks, with progress. A failure is
 * tried again (`INGEST_RETRIES`); after the last, the file is marked failed, keeping what it wrote.
 */
export async function runIngest(w: Scope, job: Job, ctl: JobControl): Promise<JobOutcome> {
  const fileId = String(job.args.fileId);
  const first = await w.catalog.get('source_files', fileId);
  if (!first || first.state !== 'importing') return {state: 'done'};
  try {
    const stopped = await withLock(w, `source:${first.sourceId}`, async () => {
      await settleReservation(w, (await w.catalog.get('data_sources', first.sourceId))!);
      const [src, file] = await Promise.all([w.catalog.get('data_sources', first.sourceId), w.catalog.get('source_files', fileId)]);
      if (!src || !file || file.state !== 'importing') return false;
      const chunks = await w.catalog.find('source_chunks', {sourceId: file.sourceId});
      const staged = chunks.filter(c => c.staged && c.fileId === fileId).sort((a, b) => a.start - b.start).flatMap(c => c.ids);
      const start = file.start ?? src.items;
      // Only the positions before this file's: the same ids are left out on a run that goes on.
      const there = new Set(chunks.filter(c => !c.staged && c.start < start).flatMap(c => c.ids));
      const order = seededShuffle(staged.filter(id => !there.has(id)), file.seed);
      if (file.start == null) {
        const reserved = {fileId, start, items: order.length, repeats: file.repeats + staged.length - order.length};
        await w.catalog.patch('data_sources', src.id, {items: start + order.length, reserved});
        await w.catalog.patch('source_files', fileId, {start, items: reserved.items, repeats: reserved.repeats});
      }
      const written = new Set(chunks.filter(c => !c.staged && c.fileId === fileId).map(c => c.start));
      let done = 0;
      for (const piece of chunksOf(src.id, fileId, start, order)) {
        if (ctl.signal.aborted) return true;
        if (!written.has(piece.start)) await w.catalog.insert('source_chunks', piece);
        done += piece.ids.length;
        await w.catalog.patch('source_files', fileId, {done});
        await ctl.progress({done, total: order.length});
        w.emitChange(null);
      }
      await w.catalog.patch('source_files', fileId, {state: 'done', done: order.length, error: null});
      await w.catalog.patch('data_sources', src.id, {updatedAt: now()});
      await w.catalog.deleteStagedChunks(fileId);
      return false;
    });
    if (!stopped) return {state: 'done'};
    // A lost lease: the runner that took the job over goes on. A cancel ends the import.
    if (ctl.cancelled()) await markFailed(w, fileId, 'Stopped.');
    return {state: 'cancelled', error: 'Stopped.'};
  } catch (e) {
    if (job.attempts > INGEST_RETRIES) await markFailed(w, fileId, (e as Error).message).catch(() => undefined);
    throw e;
  } finally {
    w.emitChange(null);
  }
}

/**
 * Marks an import failed. The items it wrote stay in the source and can be taken; the rest of its
 * positions are skipped by cuts (`allocate`), and uploading the file again adds the rest.
 */
async function markFailed(w: Scope, fileId: string, error: string): Promise<void> {
  const file = await w.catalog.get('source_files', fileId);
  if (!file) return;
  await withLock(w, `source:${file.sourceId}`, async () => {
    const src = await w.catalog.get('data_sources', file.sourceId);
    if (src) await settleReservation(w, src);
    const latest = await w.catalog.get('source_files', fileId);
    if (!latest || latest.state !== 'importing') return;
    const done = (await w.catalog.find('source_chunks', {fileId})).filter(c => !c.staged).reduce((n, c) => n + c.ids.length, 0);
    await w.catalog.patch('source_files', fileId, {state: 'failed', error, done});
    await w.catalog.deleteStagedChunks(fileId);
  });
  w.emitChange(null);
}

/**
 * Takes the next `count` items of a source for a dataset (#30): a continuous segment from
 * `next`, skipping items already in the dataset (`known`, which it adds to; a skipped item still
 * uses its position, so the segment may give fewer). Records the segment as a cut of the project.
 * Fails, with the counts, when fewer positions are left than asked for.
 */
export async function allocate(w: Scope, projectId: string, pick: SourcePick, known: Set<string>): Promise<{cut: SourceCut; items: {externalId: string; fileId: string}[]}> {
  return withLock(w, `source:${pick.sourceId}`, async () => {
    await settleReservation(w, await ownSource(w, pick.sourceId));
    const src = await ownSource(w, pick.sourceId);
    const [all, files] = await Promise.all([w.catalog.find('source_chunks', {sourceId: src.id}), w.catalog.find('source_files', {sourceId: src.id})]);
    const left = summary(src, files).notUsed;
    if (pick.count > left) throw new Error(`Only ${left} unused items are left in ${src.name}; ${pick.count} were asked for.`);
    const chunks = all.filter(c => !c.staged).sort((a, b) => a.start - b.start);
    const skip = holes(src, files).filter(h => h.failed);
    const items: {externalId: string; fileId: string}[] = [];
    let pos = src.next;
    let k = 0;
    // Positions are read in order. A failed file's unwritten ones are skipped; an import's not
    // written yet end the walk.
    while (items.length < pick.count) {
      while (k < chunks.length && chunks[k].start + chunks[k].ids.length <= pos) k++;
      const c = chunks[k];
      if (c && c.start <= pos) {
        for (let i = pos - c.start; i < c.ids.length && items.length < pick.count; i++, pos++) {
          const id = c.ids[i];
          if (known.has(id)) continue;
          known.add(id);
          items.push({externalId: id, fileId: c.fileId});
        }
        continue;
      }
      const hole = skip.find(h => h.from <= pos && pos < h.to);
      if (!hole) break;
      pos = hole.to;
    }
    const cut: SourceCut = {id: newId('cut'), sourceId: src.id, projectId, start: src.next, end: pos, taken: items.length, createdAt: now(), createdBy: (await w.user()).name};
    await w.catalog.insert('source_cuts', cut);
    await w.catalog.patch('data_sources', src.id, {next: pos});
    return {cut, items};
  });
}

/** How many unused items a source has, for checking a pick before its job is queued. */
export async function checkPicks(w: Scope, picks: SourcePick[]): Promise<{name: string; sourceId: string; count: number}[]> {
  if (!picks.length) throw new Error('Pick at least one data source.');
  const out = [];
  const listed = await listDataSources(w);
  for (const p of picks) {
    if (!Number.isInteger(p.count) || p.count < 1) throw new Error('Enter how many examples to take.');
    const s = listed.find(x => x.id === p.sourceId);
    if (!s) throw new Error('This data source does not exist.');
    if (p.count > s.notUsed) throw new Error(`Only ${s.notUsed} unused items are left in ${s.name}; ${p.count} were asked for.`);
    out.push({name: s.name, sourceId: s.id, count: p.count});
  }
  if (new Set(picks.map(p => p.sourceId)).size !== picks.length) throw new Error('Each data source can be picked once.');
  return out;
}

/** A project's segments are retired when it is deleted (#30): never handed out again. */
export async function retireCuts(w: Scope, projectId: string, only?: string[]): Promise<void> {
  const cuts = only ? await w.catalog.findByIds('source_cuts', only) : await w.catalog.find('source_cuts', {projectId});
  const live = cuts.filter(c => !c.retired && c.projectId === projectId);
  if (live.length) await w.catalog.patchMany('source_cuts', live.map(c => ({id: c.id, patch: {retired: true}})));
}

/**
 * Where the project's eval dataset came from, per data source: its live examples (removed ones
 * leave the count, restored ones come back), with the time the source's last cut was made.
 */
export async function datasetSources(w: Scope, projectId: string, examples: Example[]): Promise<DatasetSourceLine[]> {
  const count = new Map<string, number>();
  for (const e of examples) if (e.sourceId && !e.removed) count.set(e.sourceId, (count.get(e.sourceId) ?? 0) + 1);
  if (!count.size) return [];
  const [sources, cuts] = await Promise.all([w.catalog.findByIds('data_sources', [...count.keys()]), w.catalog.find('source_cuts', {projectId})]);
  const added = new Map<string, string>();
  for (const c of cuts) if (!c.retired && c.createdAt > (added.get(c.sourceId) ?? '')) added.set(c.sourceId, c.createdAt);
  return [...count]
    .map(([sourceId, n]) => {
      const src = sources.find(s => s.id === sourceId);
      return {sourceId, name: src?.name ?? sourceId, ...(src?.builtIn ? {builtIn: true} : {}), examples: n, addedAt: added.get(sourceId) ?? ''};
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

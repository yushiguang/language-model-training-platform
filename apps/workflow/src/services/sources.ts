import type {AddSourceFileRequest, CreateDataSourceRequest, DataSource, DataSourceDetail, DataSourceSummary, DatasetSourceLine, Job, JobOutcome, SourceChunk, SourceCut, SourceFile, SourcePick, SourceUploadResult} from '@yushiguang/sprint-contracts';
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

export const tenantOf = (w: Scope) => w.ctx.tenantId ?? 'default';

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

function summary(src: DataSource, files: SourceFile[]): DataSourceSummary {
  const importing = files.filter(f => f.state === 'importing');
  // `src.items` counts reserved positions; ones not written yet are not items anyone can take.
  const unwritten = importing.reduce((n, f) => n + (f.start == null ? 0 : f.items - f.done), 0);
  const items = src.items - unwritten;
  return {
    id: src.id,
    name: src.name,
    builtIn: !!src.builtIn,
    files: files.length,
    items,
    notUsed: Math.max(0, items - src.next),
    createdBy: src.createdBy,
    updatedAt: src.updatedAt,
    // Before its positions are reserved, a file's size is its rows less the bad ones and repeats.
    importing: importing.length ? {done: importing.reduce((n, f) => n + f.done, 0), total: importing.reduce((n, f) => n + (f.start == null ? f.rows - f.bad - f.repeats : f.items), 0)} : null,
  };
}

export async function listDataSources(w: Scope): Promise<DataSourceSummary[]> {
  await ensureBuiltIn(w);
  const tenantId = tenantOf(w);
  const [sources, files] = await Promise.all([w.catalog.find('data_sources', {tenantId}), w.catalog.find('source_files', {tenantId})]);
  return sources
    .sort((a, b) => Number(!!a.builtIn) - Number(!!b.builtIn) || b.updatedAt.localeCompare(a.updatedAt))
    .map(s => summary(s, files.filter(f => f.sourceId === s.id)));
}

export async function getDataSource(w: Scope, sourceId: string): Promise<DataSourceDetail | null> {
  await ensureBuiltIn(w);
  const src = await w.catalog.get('data_sources', sourceId);
  if (!src || src.tenantId !== tenantOf(w)) return null;
  const [files, cuts] = await Promise.all([w.catalog.find('source_files', {sourceId}, 'uploadedAt desc'), w.catalog.find('source_cuts', {sourceId})]);
  const live = cuts.filter(c => !c.retired);
  return {source: summary(src, files), files, taken: src.next, projects: new Set(live.map(c => c.projectId)).size};
}

export async function createDataSource(w: Scope, req: CreateDataSourceRequest): Promise<SourceUploadResult> {
  const name = req.name.trim();
  if (!name) return {error: 'Give the data source a name.'};
  const tenantId = tenantOf(w);
  if ((await w.catalog.find('data_sources', {tenantId})).some(s => s.name.toLowerCase() === name.toLowerCase())) return {error: 'A data source with this name already exists.'};
  const read = readItemIdFile(req.fileName, req.text);
  if ('error' in read) return {error: read.error};
  const user = await w.user();
  const at = now();
  const src: DataSource = {id: newId('src'), tenantId, name, items: 0, files: 0, next: 0, createdAt: at, createdBy: user.name, createdById: user.id, updatedAt: at};
  await w.catalog.insert('data_sources', src);
  return stageFile(w, src, req.fileName, read);
}

export async function addSourceFile(w: Scope, req: AddSourceFileRequest): Promise<SourceUploadResult> {
  const src = await ownSource(w, req.sourceId);
  if (src.builtIn) return {error: "Files can't be added to the built-in sample data."};
  const read = readItemIdFile(req.fileName, req.text);
  if ('error' in read) return {error: read.error};
  return stageFile(w, src, req.fileName, read);
}

/** Saves the file's ids as staged chunks and queues its import (`source.ingest`). */
async function stageFile(w: Scope, src: DataSource, fileName: string, read: {ids: string[]; rows: number; bad: number; repeats: number}): Promise<SourceUploadResult> {
  const user = await w.user();
  const file: SourceFile = {id: newId('sf'), sourceId: src.id, tenantId: src.tenantId, name: fileName, rows: read.rows, bad: read.bad, repeats: read.repeats, items: 0, seed: newId('seed'), state: 'importing', done: 0, uploadedAt: now(), uploadedBy: user.name};
  await w.catalog.insertMany('source_chunks', chunksOf(src.id, file.id, 0, read.ids, true));
  await w.catalog.insert('source_files', file);
  await w.catalog.patch('data_sources', src.id, {files: src.files + 1, updatedAt: file.uploadedAt});
  await w.jobs.enqueue(w.ctx, {kind: 'source.ingest', projectId: null, args: {fileId: file.id}, idempotencyKey: `source.ingest:${file.id}`});
  await w.catalog.audit(null, user.name, 'data_source.file_added', {sourceId: src.id, fileId: file.id, rows: read.rows, bad: read.bad, repeats: read.repeats});
  w.tm.event('source_file_uploaded', {rows: read.rows, bad: read.bad, repeats: read.repeats});
  w.emitChange(null);
  const files = await w.catalog.find('source_files', {sourceId: src.id});
  return {source: summary((await w.catalog.get('data_sources', src.id))!, files), file};
}

/**
 * The `source.ingest` executor: writes a staged file into its source's order. Under the source's
 * lock it reserves the positions (recorded on the file, so a run cut short goes on with the same
 * ones), leaves out ids already in the source, shuffles the rest with the file's seed and writes
 * them in chunks, with progress.
 */
export async function runIngest(w: Scope, job: Job): Promise<JobOutcome> {
  const fileId = String(job.args.fileId);
  let file = await w.catalog.get('source_files', fileId);
  if (!file || file.state !== 'importing') return {state: 'done'};
  try {
    await withLock(w, `source:${file.sourceId}`, async () => {
      file = (await w.catalog.get('source_files', fileId))!;
      const src = (await w.catalog.get('data_sources', file.sourceId))!;
      const chunks = await w.catalog.find('source_chunks', {sourceId: file.sourceId});
      const staged = chunks.filter(c => c.staged && c.fileId === fileId).sort((a, b) => a.start - b.start).flatMap(c => c.ids);
      const start = file.start ?? src.items;
      // Only the positions before this file's: the same ids are left out on a run that goes on.
      const there = new Set(chunks.filter(c => !c.staged && c.start < start).flatMap(c => c.ids));
      const order = seededShuffle(staged.filter(id => !there.has(id)), file.seed);
      if (file.start == null) {
        await w.catalog.patch('source_files', fileId, {start, items: order.length, repeats: file.repeats + staged.length - order.length});
        await w.catalog.patch('data_sources', src.id, {items: start + order.length});
      }
      const written = new Set(chunks.filter(c => !c.staged && c.fileId === fileId).map(c => c.start));
      const pieces = chunksOf(src.id, fileId, start, order);
      let done = 0;
      for (const piece of pieces) {
        if (!written.has(piece.start)) await w.catalog.insert('source_chunks', piece);
        done += piece.ids.length;
        await w.catalog.patch('source_files', fileId, {done});
        w.emitChange(null);
      }
      await w.catalog.patch('source_files', fileId, {state: 'done', done: order.length, error: null});
      await w.catalog.patch('data_sources', src.id, {updatedAt: now()});
      await w.catalog.deleteStagedChunks(fileId);
    });
  } catch (e) {
    // Not tried again: the file shows why it failed, and can be uploaded again.
    await w.catalog.patch('source_files', fileId, {state: 'failed', error: (e as Error).message});
    throw e;
  } finally {
    w.emitChange(null);
  }
  return {state: 'done'};
}

/**
 * Takes the next `count` items of a source for a dataset (#30): a continuous segment from
 * `next`, skipping items already in the dataset (`known`, which it adds to; a skipped item still
 * uses its position, so the segment may give fewer). Records the segment as a cut of the project.
 * Fails, with the counts, when fewer positions are left than asked for.
 */
export async function allocate(w: Scope, projectId: string, pick: SourcePick, known: Set<string>): Promise<{cut: SourceCut; items: {externalId: string; fileId: string}[]}> {
  return withLock(w, `source:${pick.sourceId}`, async () => {
    const src = await ownSource(w, pick.sourceId);
    if (pick.count > src.items - src.next) throw new Error(`Only ${src.items - src.next} unused items are left in ${src.name}; ${pick.count} were asked for.`);
    const chunks = (await w.catalog.find('source_chunks', {sourceId: src.id})).filter(c => !c.staged).sort((a, b) => a.start - b.start);
    const items: {externalId: string; fileId: string}[] = [];
    let pos = src.next;
    // Positions are read in order; a reserved piece not written yet ends the walk.
    for (const c of chunks) {
      if (items.length >= pick.count) break;
      if (c.start + c.ids.length <= pos) continue;
      if (c.start > pos) break;
      for (let i = pos - c.start; i < c.ids.length && items.length < pick.count; i++, pos++) {
        const id = c.ids[i];
        if (known.has(id)) continue;
        known.add(id);
        items.push({externalId: id, fileId: c.fileId});
      }
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

/** Where the project's eval dataset came from, per data source. */
export async function datasetSources(w: Scope, projectId: string): Promise<DatasetSourceLine[]> {
  const cuts = (await w.catalog.find('source_cuts', {projectId})).filter(c => !c.retired && c.taken > 0);
  if (!cuts.length) return [];
  const by = new Map<string, DatasetSourceLine>();
  const names = new Map((await w.catalog.findByIds('data_sources', [...new Set(cuts.map(c => c.sourceId))])).map(s => [s.id, s.name]));
  for (const c of cuts) {
    const line = by.get(c.sourceId) ?? {sourceId: c.sourceId, name: names.get(c.sourceId) ?? c.sourceId, examples: 0, addedAt: c.createdAt};
    line.examples += c.taken;
    if (c.createdAt > line.addedAt) line.addedAt = c.createdAt;
    by.set(c.sourceId, line);
  }
  return [...by.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

import type {Answer, DatasetSnapshot, Example, ExampleMedia, ItemCheckCounts, GoldLabel, GoldUploadRefusal, GoldUploadResult, Job, JobControl, JobOutcome, RawExample, SamplingTask, Schema, SourcePick} from '@yushiguang/sprint-contracts';
import {checksTotal, countProblem, hashString, newId, noChecks, readGoldAnswerWhy, systemConfig, readLabelFile, sameAnswer, type LabelFileRow} from '@yushiguang/sprint-domain';
import {latestGold} from './evaluation.ts';
import {now, type Scope} from './app.ts';
import {appendExamples, frozenFacts, insertExamplesSettled, type NewExample} from './governance.ts';
import {allocate, checkPicks, retireCuts} from './sources.ts';

/**
 * Taking examples from data sources (#29) runs as a `dataset.sample` job (deployment readiness
 * spec, 3): the Dataset page's progress is the job's stored progress, never a map in one process,
 * so it shows whichever process runs the job.
 */
const activeSamples = (w: Scope, projectId: string) => w.jobs.list(w.ctx, {projectId, kinds: ['dataset.sample'], states: ['queued', 'running']});

const picksOf = (job: Job): SourcePick[] => JSON.parse(String(job.args.picks ?? '[]')) as SourcePick[];

/** A job as the Dataset page shows it. */
function samplingView(job: Job): SamplingTask {
  const total = picksOf(job).reduce((n, p) => n + p.count, 0);
  return {
    id: job.id,
    projectId: job.projectId!,
    total,
    fetched: Math.min(total, job.progress?.done ?? 0),
    startedAt: job.createdAt,
    state: job.state === 'failed' ? 'failed' : 'running',
    error: job.state === 'failed' ? job.error : null,
    ...(job.progress?.saving ? {saving: true} : {}),
  };
}

/**
 * The take running in the project, or the last one when it failed (its error shows on the Dataset
 * page until the next take). A take that ended done or stopped shows nothing.
 */
export async function getSamplingTask(w: Scope, projectId: string): Promise<SamplingTask | null> {
  const [active] = await activeSamples(w, projectId);
  if (active) return samplingView(active);
  const ended = await w.jobs.list(w.ctx, {projectId, kinds: ['dataset.sample'], states: ['done', 'failed', 'cancelled']});
  const last = ended.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return last?.state === 'failed' ? samplingView(last) : null;
}

/** Stop on the Dataset page: cancels the job. */
export async function stopSampleDataset(w: Scope, projectId: string): Promise<void> {
  for (const job of await activeSamples(w, projectId)) await w.jobs.cancel(w.ctx, job.id);
  w.emitChange(projectId);
}

type Taken = RawExample & {sourceId?: string; sourceFileId?: string; fetchedAt?: string};

async function saveSnapshot(w: Scope, projectId: string, all: Taken[], source: DatasetSnapshot['source'], sourceName: string, invalid = 0, checks?: ItemCheckCounts): Promise<DatasetSnapshot> {
  const {catalog, user} = w;
  const prev = await catalog.find('dataset_snapshots', {projectId});
  const snapshotId = newId('ds');
  // Halves: the order is fixed by a hash of the ids, so the same dataset always halves the same
  // way. One half is for the Optimiser and the helpers to learn from; scores use the other.
  const halves = (rs: {externalId: string}[]) => new Map([...rs].sort((a, b) => hashString(a.externalId).localeCompare(hashString(b.externalId))).map((r, i) => [r.externalId, i % 2 === 0]));
  const first = halves(all);
  const examples = all.map((r): NewExample => ({id: newId('ex'), snapshotId, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: 'eval', optimiserHalf: first.get(r.externalId)!, ...(r.fetchedAt ? {fetchedAt: r.fetchedAt} : {}), ...(r.sourceId ? {sourceId: r.sourceId, sourceFileId: r.sourceFileId} : {})}));
  // Each example is saved on its own; one that fails twice is skipped (resilience spec, 3.2).
  const saved = await insertExamplesSettled(w, examples);
  if (!saved.length) throw new Error('None of the examples could be saved. Try again.');
  const notSaved = examples.length - saved.length;
  if (notSaved) {
    // Halve the saved ones again, so the halves stay even.
    const again = halves(saved);
    const moved = saved.filter(e => again.get(e.externalId) !== e.optimiserHalf);
    for (const e of moved) e.optimiserHalf = again.get(e.externalId)!;
    if (moved.length) await catalog.patchMany('examples', moved.map(e => ({id: e.id, patch: {optimiserHalf: e.optimiserHalf}})));
  }
  const raws = saved;
  const snap: DatasetSnapshot = {
    id: snapshotId,
    projectId,
    number: prev.length + 1,
    source,
    sourceName,
    createdAt: now(),
    counts: {
      rows: raws.length + invalid,
      valid: raws.length,
      invalid,
      video: raws.filter(r => r.type === 'video').length,
      photoText: raws.filter(r => r.type === 'photo_text').length,
      ...(notSaved ? {notSaved} : {}),
      ...(checks ? {checks} : {}),
    },
    // Every valid example of a Prompt Tuning project is in the eval dataset (spec 1.0.0, 2.1).
    split: {eval: raws.length, test: 0, train: 0},
    ...frozenFacts(null, raws),
  };
  snap.counts.rows = all.length + invalid;
  // The snapshot is saved after its examples, so a half-saved upload is never picked up.
  await catalog.insert('dataset_snapshots', snap);
  await catalog.patch('projects', projectId, {snapshotId: snap.id});
  await catalog.audit(projectId, (await user()).name, 'dataset.create', {source, rows: raws.length, ...(notSaved ? {notSaved} : {})});
  w.emitChange(projectId);
  return snap;
}

/**
 * Takes examples from data sources (#29): a new eval dataset, or more for the one there. Checks
 * the picks (each source has that many unused items), then queues a `dataset.sample` job; a job
 * already running in the project stops first.
 */
export async function takeExamples(w: Scope, projectId: string, picks: SourcePick[]): Promise<SamplingTask> {
  const project = await w.catalog.get('projects', projectId);
  if (!project) throw new Error('This project does not exist.');
  await checkPicks(w, picks);
  await stopSampleDataset(w, projectId);
  // A stopped take ends at its runner's next look: the new one waits, so two never run at once.
  for (let i = 0; (await activeSamples(w, projectId)).length; i++) {
    if (i >= 100) throw new Error('The last take is still stopping. Try again in a moment.');
    await new Promise(res => setTimeout(res, 100));
  }
  const job = await w.jobs.enqueue(w.ctx, {kind: 'dataset.sample', projectId, args: {picks: JSON.stringify(picks.map(p => ({sourceId: p.sourceId, count: p.count})))}, idempotencyKey: `sample:${projectId}`});
  w.emitChange(projectId);
  return samplingView(job);
}

/**
 * The `dataset.sample` executor: takes each pick's segment of its source (#30), loads the items'
 * features with progress and Stop, then saves them as a new dataset or adds them. The job stays
 * running until the examples are saved (resilience spec, 3.1), so the page never shows the empty
 * start in between. Stopped or failed before the save: its segments are retired, nothing is saved.
 */
export async function runSample(w: Scope, job: Job, ctl: JobControl): Promise<JobOutcome> {
  // The progress lives on the job: every move is a change the Dataset page reads again.
  const progress = async (p: Parameters<JobControl['progress']>[0]) => {
    await ctl.progress(p);
    w.emitChange(job.projectId);
  };
  try {
    return await take(w, job, ctl, progress);
  } finally {
    w.emitChange(job.projectId);
  }
}

async function take(w: Scope, job: Job, ctl: JobControl, progress: JobControl['progress']): Promise<JobOutcome> {
  const projectId = job.projectId!;
  const picks = picksOf(job);
  const n = picks.reduce((m, p) => m + p.count, 0);
  const {catalog} = w;
  const project = await catalog.get('projects', projectId);
  if (!project || project.deleting) return {state: 'cancelled', error: 'The project was deleted.'};
  const append = !!project.snapshotId;
  // Removed examples count as in the dataset: they are not taken again.
  const known = append ? new Set((await catalog.find('examples', {snapshotId: project.snapshotId!})).map(e => e.externalId)) : new Set<string>();
  await progress({done: 0, total: n});
  w.tm.event('sample_started', {requested: n});
  const started = Date.now();
  let fetched = 0;
  const ended = (outcome: 'done' | 'stopped' | 'failed') => w.tm.event('sample_finished', {fetched, seconds: Math.round((Date.now() - started) / 1000), outcome});
  const cuts: {id: string; sourceId: string; items: Set<string>}[] = [];
  const wanted: {externalId: string; sourceId: string; fileId: string}[] = [];
  const names: string[] = [];
  const raws: Taken[] = [];
  const checks = noChecks();
  // Set once the examples are in: a failure after it keeps the segments, since their items are.
  let saved = false;
  try {
    for (const p of picks) {
      const {cut, items} = await allocate(w, projectId, p, known);
      cuts.push({id: cut.id, sourceId: p.sourceId, items: new Set(items.map(i => i.externalId))});
      names.push((await catalog.get('data_sources', p.sourceId))?.name ?? p.sourceId);
      wanted.push(...items.map(i => ({...i, sourceId: p.sourceId})));
    }
    // Materialise (#32): each batch is checked (gone, a creator under 18, not recommendable), then
    // the usable items' features are fetched once and frozen with the dataset.
    const batch = Math.max(1, systemConfig().dataset.featureBatch);
    for (let i = 0; i < wanted.length; i += batch) {
      if (ctl.signal.aborted) break;
      const part = wanted.slice(i, i + batch);
      const checked = w.examples.check ? new Map((await retried(() => w.examples.check!(part.map(x => x.externalId)), ctl.signal)).map(c => [c.externalId, c])) : null;
      const usable = part.filter(x => {
        if (!checked) return true;
        const c = checked.get(x.externalId);
        if (c && !c.problem) return true;
        countProblem(checks, c?.problem ?? 'missing');
        return false;
      });
      const fetchedAt = now();
      const found = usable.length ? new Map((await retried(() => w.examples.lookup(usable.map(x => x.externalId)), ctl.signal)).map(r => [r.externalId, r])) : new Map<string, RawExample>();
      for (const x of usable) {
        const r = found.get(x.externalId);
        const c = checked?.get(x.externalId);
        if (r) raws.push({...r, ...(c?.type ? {type: c.type} : {}), sourceId: x.sourceId, sourceFileId: x.fileId, fetchedAt});
        // Checked as fine but no features came back: kept, with none (the item is there).
        else if (c?.type) raws.push({externalId: x.externalId, type: c.type, title: x.externalId, features: {}, sourceId: x.sourceId, sourceFileId: x.fileId, fetchedAt});
        else countProblem(checks, 'missing');
      }
      fetched = Math.min(n, i + part.length);
      await progress({done: fetched, total: n});
    }
    if (ctl.signal.aborted) {
      ended('stopped');
      await retireCuts(w, projectId, cuts.map(c => c.id));
      return {state: 'cancelled', error: 'Stopped.'};
    }
    if (!wanted.length) {
      // Every position was already in the dataset: nothing to add, and that is not a failure.
      if (append) {
        saved = true;
        ended('done');
        return {state: 'done'};
      }
      throw new Error('No items could be taken from these data sources yet. Try again when their files are imported.');
    }
    // Items left out by the checks, or that the example service does not know, are counted.
    const notFound = checksTotal(checks);
    // Nothing usable: adding to a dataset still records what the checks left out; a new dataset
    // cannot start empty, and the error says which checks left the items out.
    if (!raws.length && !append) throw new Error(checks.missing === notFound ? 'None of these items could be found. Check the data source file.' : `None of these items can be used: ${leftOutText(checks)}.`);
    await progress({done: n, total: n, saving: true});
    if (append) await appendExamples(w, projectId, raws, 'sources', notFound, checks);
    else await saveSnapshot(w, projectId, raws, 'sources', names.join(', '), notFound, checks);
    saved = true;
    ended('done');
    // Each segment records how many of its items went in: the examples actually saved. A record
    // only (the Dataset page counts the examples themselves), so a failure here fails nothing.
    try {
      const snapshotId = (await catalog.get('projects', projectId))?.snapshotId;
      const examples = snapshotId ? await catalog.find('examples', {snapshotId}) : [];
      await catalog.patchMany('source_cuts', cuts.map(c => ({id: c.id, patch: {taken: examples.filter(e => e.sourceId === c.sourceId && c.items.has(e.externalId)).length}})));
    } catch {
      // The cuts keep the counts they were made with.
    }
    return {state: 'done'};
  } catch (e) {
    if (!saved) await retireCuts(w, projectId, cuts.map(c => c.id));
    const stopped = !saved && ((e as Error).name === 'AbortError' || ctl.signal.aborted);
    ended(stopped ? 'stopped' : 'failed');
    if (stopped) return {state: 'cancelled', error: 'Stopped.'};
    throw e;
  }
}

/** What the checks left out, in words: "2 not found, 1 from a creator under 18". */
function leftOutText(c: ItemCheckCounts): string {
  return [c.missing && `${c.missing} not found`, c.minorCreator && `${c.minorCreator} from a creator under 18`, c.notRecommendable && `${c.notRecommendable} not publicly recommendable`].filter(Boolean).join(', ');
}

/** A call to the example service, tried twice more when it throws; the take fails after that. */
async function retried<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= 2 || signal.aborted) throw e;
      await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
      // Stopped while waiting: no further call.
      if (signal.aborted) throw e;
    }
  }
}

/** The media of one example (Gold Labels), or null without a media source. */
export async function exampleMedia(w: Scope, projectId: string, exampleId: string): Promise<ExampleMedia | null> {
  const {catalog, media} = w;
  const ex = await catalog.get('examples', exampleId);
  const snap = ex ? await catalog.get('dataset_snapshots', ex.snapshotId) : null;
  if (!ex || snap?.projectId !== projectId) throw new Error('This example does not exist.');
  return media ? media.media(ex.externalId, ex.type) : null;
}

export function hasBundledGold(w: Scope): boolean {
  return typeof w.examples.bundledLabels === 'function';
}

export async function saveGold(w: Scope, projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source: GoldLabel['source'] = 'labeled'): Promise<GoldLabel> {
  const {catalog, user} = w;
  const g: GoldLabel = {id: newId('gl'), projectId, exampleId, schemaVersion, answer, source, revealed, createdAt: now(), createdBy: (await user()).name};
  await catalog.insert('gold_labels', g);
  if (source === 'labeled') {
    const ex = await catalog.get('examples', exampleId);
    w.tm.event('gold_label_saved', {split: ex?.split ?? 'unknown', revealed, seconds_on_example: 0, matches_model: null, was_recheck: false});
  }
  w.emitChange(projectId);
  return g;
}

/** How many refused rows an upload's audit record keeps, for the helpers' get_upload_result (#39). */
export const UPLOAD_ROWS_KEPT = 20;

/**
 * Upload labels: rows of {externalId, answer}, from a file (`uploadGoldText`), JSON lines, or the
 * labels bundled with the sample file. `answer` is the value; older files with `{label: ["Value"]}`
 * still import (2026-11-16).
 *
 * Labels never add examples (#31): each row is matched to an example already in the dataset, and
 * a row for any other item is counted and skipped. An answer that is not an answer to the label is
 * refused with its row named. A row that gives the item a different label replaces the earlier one
 * (the newest label counts); the same label again saves nothing. Each upload is audited.
 */
export async function uploadGold(w: Scope,
  projectId: string,
  schema: Schema,
  schemaVersion: number,
  examples: Example[],
  lines: {externalId: string; answer: unknown}[],
  source: {file?: string; kind?: 'file' | 'bundled'} = {},
): Promise<GoldUploadResult> {
  return saveUploadedLabels(w, projectId, schema, schemaVersion, examples, lines.map((l, i) => ({row: i + 1, externalId: String(l.externalId ?? ''), answer: l.answer})), [], source);
}

/** Upload labels from a file: CSV or JSONL (`readLabelFile`). */
export async function uploadGoldText(w: Scope, projectId: string, schema: Schema, schemaVersion: number, examples: Example[], name: string, text: string): Promise<GoldUploadResult> {
  const read = readLabelFile(name, text, schema.name);
  if ('error' in read) return {saved: 0, skipped: 0, error: read.error};
  const unreadable = read.bad.map(b => ({row: b.row, externalId: '', reason: b.reason}));
  return saveUploadedLabels(w, projectId, schema, schemaVersion, examples, read.rows, unreadable, {file: name, kind: 'file'});
}

async function saveUploadedLabels(w: Scope,
  projectId: string,
  schema: Schema,
  schemaVersion: number,
  examples: Example[],
  rows: LabelFileRow[],
  unreadable: GoldUploadRefusal[],
  source: {file?: string; kind?: 'file' | 'bundled'},
): Promise<GoldUploadResult> {
  const byExt = new Map(examples.map(e => [e.externalId, e]));
  const {current} = await latestGold(w, projectId, schemaVersion);
  const refused: GoldUploadRefusal[] = [...unreadable];
  let saved = 0;
  let replaced = 0;
  let unchanged = 0;
  let notInDataset = 0;
  // The last row for an item wins, as if the rows were saved one after another.
  const last = new Map<string, LabelFileRow>();
  for (const r of rows) last.set(r.externalId, r);
  for (const r of rows) {
    if (last.get(r.externalId) !== r) continue;
    const ex = byExt.get(r.externalId);
    if (!ex) {
      notInDataset++;
      continue;
    }
    const got = readGoldAnswerWhy(r.answer, schema);
    if ('problem' in got) {
      refused.push({row: r.row, externalId: r.externalId, reason: got.problem});
      continue;
    }
    const had = current[ex.id];
    if (had && sameAnswer(had.answer, got.answer)) {
      unchanged++;
      continue;
    }
    await saveGold(w, projectId, ex.id, schemaVersion, got.answer, false, 'uploaded');
    saved++;
    if (had) replaced++;
  }
  refused.sort((a, b) => a.row - b.row);
  const skipped = notInDataset + refused.length;
  await w.catalog.audit(projectId, (await w.user()).name, 'gold_labels.uploaded', {file: source.file ?? null, saved, replaced, unchanged, notInDataset, refused: refused.length, refusedRows: refused.slice(0, UPLOAD_ROWS_KEPT)});
  w.tm.event('gold_labels_uploaded', {source: source.kind ?? 'file', saved, skipped});
  return {saved, skipped, replaced, unchanged, notInDataset, refused};
}

export async function importBundledGold(w: Scope, projectId: string, schema: Schema, schemaVersion: number, examples: Example[]): Promise<{saved: number; skipped: number}> {
  const bundled = w.examples.bundledLabels;
  if (!bundled) return {saved: 0, skipped: 0};
  const lines = await bundled();
  return uploadGold(w, projectId, schema, schemaVersion, examples, lines, {kind: 'bundled'});
}

import type {Answer, DatasetSnapshot, DatasetUploadResult, Example, ExampleMedia, GoldLabel, Job, JobControl, JobOutcome, RawExample, SamplingTask, Schema} from '@sprint/contracts';
import {hashString, newId, readGoldAnswer, toFeatures} from '@sprint/domain';
import {now, type Scope} from './app.ts';
import {appendExamples, insertExamplesSettled} from './governance.ts';

/**
 * Sampling runs as a `dataset.sample` job (deployment readiness spec, 3): the Dataset page's
 * progress is the job's stored progress, never a map in one process, so it shows whichever
 * process runs the job. Loading the features of an uploaded file stays inside its request (the
 * page waits for the result); its progress and Stop sit in shared state (`loading:{projectId}`).
 */
const LOADING_TTL_MS = 10 * 60_000;
const loadingKey = (projectId: string) => `loading:${projectId}`;
interface Loading {
  task: SamplingTask;
  stop: boolean;
}

const activeSamples = (w: Scope, projectId: string) => w.jobs.list(w.ctx, {projectId, kinds: ['dataset.sample'], states: ['queued', 'running']});

/** A sampling job as the Dataset page shows it. */
function samplingView(job: Job): SamplingTask {
  const total = Number(job.args.n);
  return {
    id: job.id,
    projectId: job.projectId!,
    kind: 'sample',
    total,
    fetched: Math.min(total, job.progress?.done ?? 0),
    startedAt: job.createdAt,
    state: 'running',
    error: null,
    ...(job.progress?.saving ? {saving: true} : {}),
  };
}

export async function getSamplingTask(w: Scope, projectId: string): Promise<SamplingTask | null> {
  const loading = await w.shared.get<Loading>(loadingKey(projectId));
  if (loading) return loading.task;
  const [job] = await activeSamples(w, projectId);
  return job ? samplingView(job) : null;
}

/** Stop on the Dataset page: cancels the sampling job, or stops loading an upload's features. */
export async function stopSampleDataset(w: Scope, projectId: string): Promise<void> {
  for (const job of await activeSamples(w, projectId)) await w.jobs.cancel(w.ctx, job.id);
  const loading = await w.shared.get<Loading>(loadingKey(projectId));
  if (loading) await w.shared.set(loadingKey(projectId), {...loading, stop: true}, LOADING_TTL_MS);
  w.emitChange();
}

async function saveSnapshot(w: Scope, projectId: string, all: RawExample[], source: DatasetSnapshot['source'], sourceName: string, invalid = 0): Promise<DatasetSnapshot> {
  const {catalog, user} = w;
  const prev = await catalog.find('dataset_snapshots', {projectId});
  const snapshotId = newId('ds');
  // Halves: the order is fixed by a hash of the ids, so the same dataset always halves the same
  // way. One half is for the Optimiser and the helpers to learn from; scores use the other.
  const halves = (rs: {externalId: string}[]) => new Map([...rs].sort((a, b) => hashString(a.externalId).localeCompare(hashString(b.externalId))).map((r, i) => [r.externalId, i % 2 === 0]));
  const first = halves(all);
  const examples = all.map((r): Example => ({id: newId('ex'), snapshotId, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: 'eval', optimiserHalf: first.get(r.externalId)!}));
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
    },
    // Every valid example of a Prompt Tuning project is in the eval dataset (spec 1.0.0, 2.1).
    split: {eval: raws.length, test: 0, train: 0},
  };
  snap.counts.rows = all.length + invalid;
  // The snapshot is saved after its examples, so a half-saved upload is never picked up.
  await catalog.insert('dataset_snapshots', snap);
  await catalog.patch('projects', projectId, {snapshotId: snap.id});
  await catalog.audit(projectId, (await user()).name, 'dataset.create', {source, rows: raws.length, ...(notSaved ? {notSaved} : {})});
  w.emitChange();
  return snap;
}

/** Queues a `dataset.sample` job; a sampling already running in the project stops first. */
async function queueSample(w: Scope, projectId: string, n: number, append: boolean): Promise<SamplingTask> {
  if (!(await w.catalog.get('projects', projectId))) throw new Error('This project does not exist.');
  await stopSampleDataset(w, projectId);
  const job = await w.jobs.enqueue(w.ctx, {kind: 'dataset.sample', projectId, args: {n, append}});
  w.emitChange();
  return samplingView(job);
}

/** Samples a new eval dataset of `n` examples: returns once queued. */
export function startSampleDataset(w: Scope, projectId: string, n: number): Promise<SamplingTask> {
  return queueSample(w, projectId, n, false);
}

/**
 * Adds `n` sampled examples to the eval dataset (spec 1.0.0, 4.3), none of them already in it
 * (removed ones count as in it): returns once queued.
 */
export function appendSample(w: Scope, projectId: string, n: number): Promise<SamplingTask> {
  return queueSample(w, projectId, n, true);
}

/**
 * The `dataset.sample` executor: asks the example source for `n` examples (more when adding, so
 * repeats can be dropped), with progress and Stop, then saves them as a new dataset or adds them.
 * The job stays running until the examples are saved (resilience spec, 3.1), so the page never
 * shows the empty start in between. Stopped while the last page came in: nothing is saved.
 */
export async function runSample(w: Scope, job: Job, ctl: JobControl): Promise<JobOutcome> {
  // The progress lives on the job: every move is a change the Dataset page reads again.
  const progress = async (p: Parameters<JobControl['progress']>[0]) => {
    await ctl.progress(p);
    w.emitChange();
  };
  try {
    return await sample(w, job, ctl, progress);
  } finally {
    w.emitChange();
  }
}

async function sample(w: Scope, job: Job, ctl: JobControl, progress: JobControl['progress']): Promise<JobOutcome> {
  const projectId = job.projectId!;
  const n = Number(job.args.n);
  const append = job.args.append === true;
  const {catalog} = w;
  const project = await catalog.get('projects', projectId);
  if (!project || project.deleting) return {state: 'cancelled', error: 'The project was deleted.'};
  const known = append && project.snapshotId ? new Set((await catalog.find('examples', {snapshotId: project.snapshotId})).map(e => e.externalId)) : new Set<string>();
  await progress({done: 0, total: n});
  w.tm.event('sample_started', {requested: n});
  const sampleStarted = Date.now();
  let fetched = 0;
  const ended = (outcome: 'done' | 'stopped' | 'failed') => w.tm.event('sample_finished', {fetched, seconds: Math.round((Date.now() - sampleStarted) / 1000), outcome});
  let raws: RawExample[];
  try {
    raws = await w.examples.sample(n + known.size, got => ((fetched = Math.min(n, got)), void progress({done: fetched, total: n})), ctl.signal);
  } catch (e) {
    const stopped = (e as Error).name === 'AbortError' || ctl.signal.aborted;
    ended(stopped ? 'stopped' : 'failed');
    if (stopped) return {state: 'cancelled', error: 'Stopped.'};
    throw e;
  }
  ended('done');
  if (ctl.signal.aborted) return {state: 'cancelled', error: 'Stopped.'};
  await progress({done: n, total: n, saving: true});
  if (append) await appendExamples(w, projectId, raws.filter(r => !known.has(r.externalId)).slice(0, n), 'sample');
  else await saveSnapshot(w, projectId, raws, 'sample', 'Sampled from the platform');
  return {state: 'done'};
}

export async function getSamplePoolSize(w: Scope): Promise<number> {
  return w.examples.available();
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

/**
 * Upload dataset: a text or CSV file of item IDs separated by commas or new lines (an optional
 * header such as item_id is skipped), or JSONL of ids or full examples. The system then loads each
 * item's features, which the Dataset page shows as "Loading features for N items".
 */
export async function uploadDatasetText(w: Scope, projectId: string, name: string, text: string, append = false): Promise<DatasetUploadResult> {
  if (!/\.(csv|txt|jsonl|json)$/i.test(name)) {
    return {error: "This file can't be used. Upload a text or CSV file of item IDs."};
  }
  const raws: RawExample[] = [];
  const ids: string[] = [];
  let invalid = 0;
  const first = (text.split(/\r?\n/)[0] ?? '').split(',').map(h => h.trim().toLowerCase());
  // A CSV table with several columns, one of them the id; anything else is a plain list of IDs.
  const isTable = /\.csv$/i.test(name) && first.length > 1 && first.some(h => h === 'video_id' || h === 'id' || h === 'external_id');
  if (!isTable && /\.(txt|csv)$/i.test(name)) {
    // A list of item IDs, separated by commas or new lines; a header word is skipped.
    for (const tok of text.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)) {
      if (/^(item_id|video_id|id|external_id)$/i.test(tok)) continue;
      if (/^[A-Za-z0-9_-]+$/.test(tok)) ids.push(tok);
      else invalid++;
    }
  } else if (/\.csv$/i.test(name)) {
    const [head, ...rows] = text.trim().split(/\r?\n/);
    const col = head
      .split(',')
      .map(s => s.trim().toLowerCase())
      .findIndex(h => h === 'video_id' || h === 'id' || h === 'external_id');
    if (col === -1) return {error: 'The file needs a video_id column.'};
    for (const row of rows) {
      const id = row.split(',')[col]?.trim();
      if (id) ids.push(id);
      else invalid++;
    }
  } else {
    for (const line of text.split(/\r?\n/).filter(l => l.trim())) {
      try {
        const o = JSON.parse(line);
        if (o.features && o.type) raws.push({externalId: String(o.externalId ?? o.id ?? o.video_id), type: o.type, title: o.title ?? '', features: toFeatures(o.features)});
        else if (o.video_id ?? o.id) ids.push(String(o.video_id ?? o.id));
        else invalid++;
      } catch {
        invalid++;
      }
    }
  }
  let task: SamplingTask | null = null;
  if (ids.length) {
    const found = await loadFeatures(w, projectId, name, ids);
    if (!found) return {};
    task = found.task;
    invalid += ids.length - found.raws.length;
    raws.push(...found.raws);
  }
  try {
    if (!raws.length) {
      w.tm.event('dataset_upload_failed', {reason: 'empty'});
      return {error: 'No usable rows in this file.'};
    }
    w.tm.event('dataset_uploaded', {rows: raws.length + invalid, valid: raws.length, invalid, video: raws.filter(r => r.type === 'video').length, photo_text: raws.filter(r => r.type !== 'video').length});
    if (task) await setLoading(w, projectId, {...task, fetched: task.total, saving: true});
    // Adding to an eval dataset there (spec 1.0.0, 4.3) keeps every example, half and gold label.
    if (append) return await appendExamples(w, projectId, raws, 'upload', invalid);
    return {snapshot: await saveSnapshot(w, projectId, raws, 'upload', name, invalid)};
  } finally {
    if (task) await endLoading(w, projectId);
  }
}

async function setLoading(w: Scope, projectId: string, task: SamplingTask): Promise<boolean> {
  const was = await w.shared.get<Loading>(loadingKey(projectId));
  if (was?.stop) return false;
  await w.shared.set(loadingKey(projectId), {task, stop: false}, LOADING_TTL_MS);
  w.emitChange();
  return true;
}

async function endLoading(w: Scope, projectId: string): Promise<void> {
  await w.shared.delete(loadingKey(projectId));
  w.emitChange();
}

/**
 * Looks the IDs up in chunks, as a task the Dataset page shows with its progress and Stop (in
 * shared state, so Stop works from whichever process the page reaches). On success the task stays
 * on until the caller has saved the examples and calls `endLoading`.
 */
async function loadFeatures(w: Scope, projectId: string, fileName: string, ids: string[]): Promise<{raws: RawExample[]; task: SamplingTask} | null> {
  await stopSampleDataset(w, projectId);
  await w.shared.delete(loadingKey(projectId));
  const task: SamplingTask = {id: newId('sm'), projectId, kind: 'upload', fileName, total: ids.length, fetched: 0, startedAt: now(), state: 'running', error: null};
  await setLoading(w, projectId, task);
  const out: RawExample[] = [];
  try {
    for (let i = 0; i < ids.length; i += 10) {
      out.push(...(await w.examples.lookup(ids.slice(i, i + 10))));
      // Stop pressed: the next chunk is not asked for, and nothing is saved.
      if (!(await setLoading(w, projectId, {...task, fetched: Math.min(ids.length, i + 10)}))) {
        await endLoading(w, projectId);
        return null;
      }
    }
    return {raws: out, task};
  } catch (e) {
    await endLoading(w, projectId);
    throw e;
  }
}

export async function saveGold(w: Scope, projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source: GoldLabel['source'] = 'labeled'): Promise<GoldLabel> {
  const {catalog, user} = w;
  const g: GoldLabel = {id: newId('gl'), projectId, exampleId, schemaVersion, answer, source, revealed, createdAt: now(), createdBy: (await user()).name};
  await catalog.insert('gold_labels', g);
  if (source === 'labeled') {
    const ex = await catalog.get('examples', exampleId);
    w.tm.event('gold_label_saved', {split: ex?.split ?? 'unknown', revealed, seconds_on_example: 0, matches_model: null, was_recheck: false});
  }
  w.emitChange();
  return g;
}

/**
 * Upload labels: JSONL lines of {externalId, answer}, or the labels bundled with the sample file.
 * `answer` is the value; older files with `{label: ["Value"]}` still import (2026-11-16).
 */
export async function uploadGold(w: Scope,
  projectId: string,
  schema: Schema,
  schemaVersion: number,
  examples: Example[],
  lines: {externalId: string; answer: unknown}[],
): Promise<{saved: number; skipped: number}> {
  const byExt = new Map(examples.map(e => [e.externalId, e]));
  let saved = 0;
  let skipped = 0;
  for (const l of lines) {
    const ex = byExt.get(l.externalId);
    const answer = readGoldAnswer(l.answer, schema);
    if (!ex || answer == null) {
      skipped++;
      continue;
    }
    await saveGold(w, projectId, ex.id, schemaVersion, answer, false, 'uploaded');
    saved++;
  }
  w.tm.event('gold_labels_uploaded', {source: 'file', saved, skipped});
  return {saved, skipped};
}

export async function importBundledGold(w: Scope, projectId: string, schema: Schema, schemaVersion: number, examples: Example[]): Promise<{saved: number; skipped: number}> {
  const bundled = w.examples.bundledLabels;
  if (!bundled) return {saved: 0, skipped: 0};
  const lines = await bundled();
  return uploadGold(w, projectId, schema, schemaVersion, examples, lines);
}

import type {Answer, DatasetSnapshot, DatasetUploadResult, Example, ExampleMedia, GoldLabel, RawExample, SamplingTask, Schema} from '@tsp/contracts';
import {hashString, newId, readGoldAnswer, toFeatures} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {appendExamples, insertExamplesSettled} from './governance.ts';

const activeSampling = new Map<string, {task: SamplingTask; ctrl: AbortController}>();

export function getSamplingTask(projectId: string): SamplingTask | null {
  return activeSampling.get(projectId)?.task ?? null;
}

export function stopSampleDataset(projectId: string): void {
  const entry = activeSampling.get(projectId);
  if (entry) {
    entry.ctrl.abort();
    activeSampling.delete(projectId);
    emitChange();
  }
}

/**
 * Ends a sampling or loading task once its examples are saved (resilience spec, 3.1): the page
 * keeps its progress until the dataset is there, and never shows the empty start in between.
 */
function release(projectId: string, task: SamplingTask): void {
  if (activeSampling.get(projectId)?.task === task) activeSampling.delete(projectId);
  emitChange();
}

/** Marks a task as saving: all items are in, and Stop is gone. */
function saving(task: SamplingTask): void {
  task.fetched = task.total;
  task.saving = true;
  emitChange();
}

async function saveSnapshot(projectId: string, all: RawExample[], source: DatasetSnapshot['source'], sourceName: string, invalid = 0): Promise<DatasetSnapshot> {
  const {catalog, user} = getApp();
  const prev = await catalog.find('dataset_snapshots', {projectId});
  const snapshotId = newId('ds');
  // Halves: the order is fixed by a hash of the ids, so the same dataset always halves the same
  // way. One half is for the Optimiser and the helpers to learn from; scores use the other.
  const halves = (rs: {externalId: string}[]) => new Map([...rs].sort((a, b) => hashString(a.externalId).localeCompare(hashString(b.externalId))).map((r, i) => [r.externalId, i % 2 === 0]));
  const first = halves(all);
  const examples = all.map((r): Example => ({id: newId('ex'), snapshotId, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: 'eval', optimiserHalf: first.get(r.externalId)!}));
  // Each example is saved on its own; one that fails twice is skipped (resilience spec, 3.2).
  const saved = await insertExamplesSettled(examples);
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
  emitChange();
  return snap;
}

/**
 * Adds `n` sampled examples to the eval dataset (spec 1.0.0, 4.3), none of them already in it
 * (removed ones count as in it). Returns how many were added; 0 when stopped.
 */
export async function appendSample(projectId: string, n: number): Promise<number> {
  const {catalog} = getApp();
  const project = await catalog.get('projects', projectId);
  const known = project?.snapshotId ? new Set((await catalog.find('examples', {snapshotId: project.snapshotId})).map(e => e.externalId)) : new Set<string>();
  const got = await sampleTask(projectId, n, known.size);
  if (!got) return 0;
  try {
    saving(got.task);
    const fresh = got.raws.filter(r => !known.has(r.externalId)).slice(0, n);
    return (await appendExamples(projectId, fresh, 'sample')).added;
  } finally {
    release(projectId, got.task);
  }
}

/**
 * The sampling task with its progress and Stop; `extra` more are asked for so repeats can be
 * dropped. On success the task stays on until the caller has saved the examples and calls
 * `release` (resilience spec, 3.1).
 */
async function sampleTask(projectId: string, n: number, extra = 0): Promise<{raws: RawExample[]; task: SamplingTask} | null> {
  stopSampleDataset(projectId);
  const ctrl = new AbortController();
  const task: SamplingTask = {id: newId('sm'), projectId, total: n, fetched: 0, startedAt: now(), state: 'running', error: null};
  activeSampling.set(projectId, {task, ctrl});
  tm().event('sample_started', {requested: n});
  const sampleStarted = Date.now();
  const ended = (outcome: 'done' | 'stopped' | 'failed') => tm().event('sample_finished', {fetched: task.fetched, seconds: Math.round((Date.now() - sampleStarted) / 1000), outcome});
  emitChange();
  try {
    const raws = await getApp().examples.sample(n + extra, fetched => ((task.fetched = Math.min(n, fetched)), emitChange()), ctrl.signal);
    ended('done');
    // Stopped while the last page came in: nothing is saved.
    if (ctrl.signal.aborted) return null;
    return {raws, task};
  } catch (e) {
    ended((e as Error).name === 'AbortError' ? 'stopped' : 'failed');
    release(projectId, task);
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Starts a stateful sampling task inside the backend. Progress is pushed via state updates
 * rather than a client callback so the contract stays serialisable over HTTP.
 */
export async function startSampleDataset(projectId: string, n: number): Promise<DatasetSnapshot | null> {
  const got = await sampleTask(projectId, n);
  if (!got) return null;
  try {
    saving(got.task);
    return await saveSnapshot(projectId, got.raws, 'sample', 'Sampled from the platform');
  } finally {
    release(projectId, got.task);
  }
}

export async function getSamplePoolSize(): Promise<number> {
  return getApp().examples.available();
}

/** The media of one example (Gold Labels), or null without a media source. */
export async function exampleMedia(exampleId: string): Promise<ExampleMedia | null> {
  const {catalog, media} = getApp();
  if (!media) return null;
  const ex = await catalog.get('examples', exampleId);
  return ex ? media.media(ex.externalId, ex.type) : null;
}

export function hasBundledGold(): boolean {
  return typeof getApp().examples.bundledLabels === 'function';
}

/**
 * Upload dataset: a text or CSV file of item IDs separated by commas or new lines (an optional
 * header such as item_id is skipped), or JSONL of ids or full examples. The system then loads each
 * item's features, which the Dataset page shows as "Loading features for N items".
 */
export async function uploadDatasetText(projectId: string, name: string, text: string, append = false): Promise<DatasetUploadResult> {
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
    const found = await loadFeatures(projectId, name, ids);
    if (!found) return {};
    task = found.task;
    invalid += ids.length - found.raws.length;
    raws.push(...found.raws);
  }
  try {
    if (!raws.length) {
      tm().event('dataset_upload_failed', {reason: 'empty'});
      return {error: 'No usable rows in this file.'};
    }
    tm().event('dataset_uploaded', {rows: raws.length + invalid, valid: raws.length, invalid, video: raws.filter(r => r.type === 'video').length, photo_text: raws.filter(r => r.type !== 'video').length});
    if (task) saving(task);
    // Adding to an eval dataset there (spec 1.0.0, 4.3) keeps every example, half and gold label.
    if (append) return await appendExamples(projectId, raws, 'upload', invalid);
    return {snapshot: await saveSnapshot(projectId, raws, 'upload', name, invalid)};
  } finally {
    if (task) release(projectId, task);
  }
}

/**
 * Looks the IDs up in chunks, as a task the Dataset page shows with its progress and Stop. On
 * success the task stays on until the caller has saved the examples and calls `release`.
 */
async function loadFeatures(projectId: string, fileName: string, ids: string[]): Promise<{raws: RawExample[]; task: SamplingTask} | null> {
  stopSampleDataset(projectId);
  const ctrl = new AbortController();
  const task: SamplingTask = {id: newId('sm'), projectId, kind: 'upload', fileName, total: ids.length, fetched: 0, startedAt: now(), state: 'running', error: null};
  activeSampling.set(projectId, {task, ctrl});
  emitChange();
  const out: RawExample[] = [];
  try {
    for (let i = 0; i < ids.length; i += 10) {
      if (ctrl.signal.aborted) {
        release(projectId, task);
        return null;
      }
      out.push(...(await getApp().examples.lookup(ids.slice(i, i + 10))));
      task.fetched = Math.min(ids.length, i + 10);
      emitChange();
    }
    return {raws: out, task};
  } catch (e) {
    release(projectId, task);
    throw e;
  }
}

export async function saveGold(projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source: GoldLabel['source'] = 'labeled'): Promise<GoldLabel> {
  const {catalog, user} = getApp();
  const g: GoldLabel = {id: newId('gl'), projectId, exampleId, schemaVersion, answer, source, revealed, createdAt: now(), createdBy: (await user()).name};
  await catalog.insert('gold_labels', g);
  if (source === 'labeled') {
    const ex = await catalog.get('examples', exampleId);
    tm().event('gold_label_saved', {split: ex?.split ?? 'unknown', revealed, seconds_on_example: 0, matches_model: null, was_recheck: false});
  }
  emitChange();
  return g;
}

/**
 * Upload labels: JSONL lines of {externalId, answer}, or the labels bundled with the sample file.
 * `answer` is the value; older files with `{label: ["Value"]}` still import (2026-11-16).
 */
export async function uploadGold(
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
    await saveGold(projectId, ex.id, schemaVersion, answer, false, 'uploaded');
    saved++;
  }
  tm().event('gold_labels_uploaded', {source: 'file', saved, skipped});
  return {saved, skipped};
}

export async function importBundledGold(projectId: string, schema: Schema, schemaVersion: number, examples: Example[]): Promise<{saved: number; skipped: number}> {
  const bundled = getApp().examples.bundledLabels;
  if (!bundled) return {saved: 0, skipped: 0};
  const lines = await bundled();
  return uploadGold(projectId, schema, schemaVersion, examples, lines);
}

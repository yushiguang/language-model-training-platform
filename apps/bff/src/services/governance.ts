import type {DatasetRemoval, DatasetSnapshot, Example, LabelComment, RawExample, RemovalReason} from '@tsp/contracts';
import {assignEvalHalves, newId, pickToPrune, systemConfig} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {loadProjectState} from './projects.ts';

/**
 * Eval dataset governance (spec 1.0.0, 4.2 to 4.4): balanced halves and the holdout lock, adding
 * examples without touching the ones there, removal with a trail, batch pruning, and comments.
 */

/**
 * Balances the halves by gold label while no helper has read an example (spec 1.0.0, 4.2). Once
 * the holdout is locked nothing moves. Called when Gold Labels is left and before the lock.
 * Once scoring has started nothing moves either: a score rests on its held-out half, and moving
 * examples would leave every score out of date.
 */
export async function balanceHalves(projectId: string): Promise<number> {
  const {catalog} = getApp();
  const project = await catalog.get('projects', projectId);
  if (!project || project.holdoutLocked) return 0;
  const state = await loadProjectState(projectId);
  if (!state || state.reports.length || state.runs.length) return 0;
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const goldAnswers = Object.fromEntries(Object.entries(state.gold).map(([id, g]) => [id, g.answer]));
  const halves = assignEvalHalves(evalEx, goldAnswers, false);
  const moved = evalEx.filter(e => halves[e.id] !== e.optimiserHalf);
  if (moved.length) {
    await catalog.patchMany('examples', moved.map(e => ({id: e.id, patch: {optimiserHalf: halves[e.id]}})));
    await catalog.audit(projectId, 'system', 'dataset.halves', {moved: moved.length});
    emitChange();
  }
  tm().event('eval_halves_balanced', {moved: moved.length, locked: false});
  return moved.length;
}

/**
 * The holdout lock (spec 1.0.0, 4.2): called before a helper or the Optimiser first reads
 * examples. The halves are balanced one last time, then no example ever changes half again.
 */
export async function lockHoldout(projectId: string): Promise<void> {
  const {catalog} = getApp();
  const project = await catalog.get('projects', projectId);
  if (!project || project.holdoutLocked) return;
  await balanceHalves(projectId);
  await catalog.patch('projects', projectId, {holdoutLocked: true});
  await catalog.audit(projectId, 'system', 'dataset.holdout_locked', {});
}

/**
 * Adds examples to the eval dataset (spec 1.0.0, 4.3): ids already in it, removed ones too, are
 * skipped; existing examples, their halves and gold labels stay as they are. New examples take the
 * half that keeps the two even. Without a dataset yet it starts one.
 */
export async function appendExamples(projectId: string, raws: RawExample[], source: DatasetSnapshot['source'], invalid = 0): Promise<{added: number; duplicates: number}> {
  const {catalog, user} = getApp();
  const project = await catalog.get('projects', projectId);
  const snap = project?.snapshotId ? await catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!project || !snap) throw new Error('There is no eval dataset to add to yet.');
  const existing = await catalog.find('examples', {snapshotId: snap.id});
  const seen = new Set(existing.map(e => e.externalId));
  const fresh: RawExample[] = [];
  for (const r of raws) {
    if (seen.has(r.externalId)) continue;
    seen.add(r.externalId);
    fresh.push(r);
  }
  const duplicates = raws.length - fresh.length;
  if (fresh.length) {
    const live = existing.filter(e => !e.removed);
    const added: Example[] = fresh.map(r => ({id: newId('ex'), snapshotId: snap.id, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: 'eval', optimiserHalf: false}));
    const {current: gold} = await (await import('./evaluation.ts')).latestGold(projectId, (await catalog.get('setup_versions', project.setupVersionId ?? ''))?.schemaVersion ?? 0);
    // The ones there keep their half (as if locked); only the new ones are placed.
    const halves = assignEvalHalves(
      [...live.map(e => ({...e, optimiserHalf: e.optimiserHalf as boolean | null})), ...added.map(e => ({...e, optimiserHalf: null}))],
      Object.fromEntries(Object.entries(gold).map(([id, g]) => [id, g.answer])),
      true,
    );
    for (const e of added) e.optimiserHalf = halves[e.id];
    await catalog.insertMany('examples', added);
    await catalog.patch('dataset_snapshots', snap.id, {
      counts: {
        rows: snap.counts.rows + fresh.length + invalid,
        valid: snap.counts.valid + fresh.length,
        invalid: snap.counts.invalid + invalid,
        video: snap.counts.video + fresh.filter(r => r.type === 'video').length,
        photoText: snap.counts.photoText + fresh.filter(r => r.type === 'photo_text').length,
      },
      split: {eval: (snap.split?.eval ?? 0) + fresh.length, test: 0, train: 0},
    });
  }
  await catalog.audit(projectId, (await user()).name, 'dataset.append', {source, added: fresh.length, duplicates});
  tm().event('dataset_appended', {source, added: fresh.length, duplicates});
  emitChange();
  return {added: fresh.length, duplicates};
}

/**
 * Removes examples from the eval dataset (spec 1.0.0, 4.4): soft delete, each with a
 * `DatasetRemoval` that keeps its half and gold label at the time. No other example changes half.
 */
export async function removeExamples(projectId: string, exampleIds: string[], reason: RemovalReason): Promise<number> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('This project does not exist.');
  const byId = new Map(state.examples.map(e => [e.id, e]));
  const targets = [...new Set(exampleIds)].map(id => byId.get(id)).filter((e): e is Example => !!e);
  if (targets.length !== new Set(exampleIds).size) throw new Error('Some of these examples are not in this eval dataset.');
  const who = (await user()).name;
  const at = now();
  const records: DatasetRemoval[] = targets.map(e => ({
    id: newId('rm'),
    projectId,
    exampleId: e.id,
    externalId: e.externalId,
    half: e.optimiserHalf ? 'optimiser' : 'held_out',
    gold: state.gold[e.id]?.answer ?? null,
    reason,
    removedBy: who,
    removedAt: at,
    restoredAt: null,
  }));
  if (!records.length) return 0;
  await catalog.insertMany('dataset_removals', records);
  await catalog.patchMany('examples', targets.map(e => ({id: e.id, patch: {removed: true}})));
  await catalog.audit(projectId, who, 'dataset.remove', {reason, count: records.length, withGold: records.filter(r => r.gold).length});
  tm().event('dataset_examples_removed', {reason, count: records.length, with_gold: records.filter(r => r.gold).length});
  emitChange();
  return records.length;
}

/** Puts removed examples back, in the half they had (spec 1.0.0, 4.4). */
export async function restoreExamples(projectId: string, removalIds: string[]): Promise<void> {
  const {catalog, user} = getApp();
  const removals = (await catalog.findByIds('dataset_removals', removalIds)).filter(r => r.projectId === projectId && !r.restoredAt);
  if (!removals.length) return;
  const at = now();
  await catalog.patchMany('dataset_removals', removals.map(r => ({id: r.id, patch: {restoredAt: at}})));
  await catalog.patchMany('examples', removals.map(r => ({id: r.exampleId, patch: {removed: false}})));
  await catalog.audit(projectId, (await user()).name, 'dataset.restore', {count: removals.length});
  tm().event('dataset_examples_restored', {count: removals.length});
  emitChange();
}

/**
 * Batch pruning (spec 1.0.0, 4.3): unlabeled examples down to `keep`, or the examples of an
 * over-represented gold value down to `keep`, at random but evenly from both halves.
 */
export async function pruneDataset(projectId: string, mode: 'unlabeled' | 'downsample', keep: number, field?: string, value?: string): Promise<number> {
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('This project does not exist.');
  const evalEx = state.examples.filter(e => e.split === 'eval');
  let candidates: Example[];
  if (mode === 'unlabeled') candidates = evalEx.filter(e => !state.gold[e.id]);
  else {
    if (!field || !value) throw new Error('Name the field and value to downsample.');
    candidates = evalEx.filter(e => (state.gold[e.id]?.answer[field] ?? []).includes(value));
  }
  const ids = pickToPrune(candidates, keep);
  if (!ids.length) return 0;
  return removeExamples(projectId, ids, mode === 'unlabeled' ? 'excess_unlabeled' : 'downsample');
}

/** Adds a person's comment to an example (spec 1.0.0, 5.4); comments are never edited or deleted. */
export async function addComment(projectId: string, exampleId: string, text: string, promptVersionId: string | null = null): Promise<LabelComment> {
  const {catalog, user} = getApp();
  const body = text.trim().slice(0, systemConfig().labeling.commentMaxChars);
  if (!body) throw new Error('The comment is empty.');
  const ex = await catalog.get('examples', exampleId);
  const project = await catalog.get('projects', projectId);
  if (!ex || ex.snapshotId !== project?.snapshotId) throw new Error('This example is not in the eval dataset.');
  const u = await user();
  const c: LabelComment = {id: newId('lc'), projectId, exampleId, authorId: u.id, authorName: u.name, text: body, promptVersionId, createdAt: now()};
  await catalog.insert('label_comments', c);
  tm().event('label_comment_added', {where: promptVersionId ? 'mismatch' : 'eval', chars: body.length});
  emitChange();
  return c;
}

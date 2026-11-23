import type {DatasetRemoval, DatasetSnapshot, Example, ExampleFeatures, FeatureStorePort, ExampleType, ExampleWithFeatures, ItemCheckCounts, LabelComment, RawExample, RemovalReason} from '@yushiguang/sprint-contracts';
import {addChecks, assignEvalHalves, checksTotal, computeFeatureMissingness, featureDocId, featureSizes, mergeFeatureMissingness, mergeFeatureSizes, newId, noChecks, pickToPrune, subtractFeatureMissingness, systemConfig} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {featuresOf} from './features.ts';
import {loadProjectState} from './projects.ts';

/**
 * Eval dataset governance (spec 1.0.0, 4.2 to 4.4): balanced halves and the holdout lock, adding
 * examples without touching the ones there, removal with a trail, batch pruning, and comments.
 */

/** An example to save with its frozen features (#32) and when they were fetched. */
export type NewExample = ExampleWithFeatures & {fetchedAt?: string};

/**
 * Saves examples a few at a time, each on its own (resilience spec, 3.2): a write that fails is
 * tried once more, then skipped, so one bad item never stops a sample, an upload or an append.
 * Before a retry, and after the last failure, the record is looked up: a write that failed on
 * the way back but was stored counts as saved and is not written twice. Returns the saved ones.
 *
 * Features go first, then each example's index record: an example is never in the dataset
 * without its features (#32). With a feature store (docs/design/server.md 6) they are written a
 * batch at a time (`dataset.featureBatch`, one segment file in object storage); a batch that
 * fails twice is skipped whole, and the index records keep where each example's features are
 * (`featureRef`). Without one, each example's features are a document of their own. Features
 * saved for an example whose record then failed are deleted with the project, or never read.
 */
export async function insertExamplesSettled(w: Scope, examples: NewExample[], parallel = 8): Promise<NewExample[]> {
  const {catalog} = w;
  const settled = async (write: () => Promise<unknown>, stored: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await write();
        return true;
      } catch {
        if (await stored().catch(() => false)) return true;
      }
    }
    return false;
  };
  const featuresOf = (e: NewExample): ExampleFeatures => ({id: featureDocId(e.snapshotId, e.externalId), snapshotId: e.snapshotId, externalId: e.externalId, type: e.type, features: e.features, fetchedAt: e.fetchedAt ?? now()});
  const saveIndex = (e: NewExample) => {
    const {features: _features, fetchedAt: _fetchedAt, ...index} = e;
    return settled(() => catalog.insert('examples', index as Example), async () => !!(await catalog.get('examples', e.id)));
  };
  const saveOne = async (e: NewExample) => {
    const doc = featuresOf(e);
    if (!(await settled(() => catalog.insert('example_features', doc), async () => !!(await catalog.get('example_features', doc.id))))) return false;
    return saveIndex(e);
  };
  /** One batch's features in one write, tried once more; null: not stored. */
  const putFeatures = async (store: FeatureStorePort, batch: NewExample[]) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await store.putBatch(batch[0].snapshotId, batch.map(featuresOf));
      } catch {
        // A segment written on a failed way back is never referenced: nothing reads it.
      }
    }
    return null;
  };
  const saved: NewExample[] = [];
  const saveAll = async (list: NewExample[], one: (e: NewExample) => Promise<boolean>) => {
    for (let i = 0; i < list.length; i += parallel) {
      const batch = list.slice(i, i + parallel);
      const ok = await Promise.all(batch.map(one));
      batch.forEach((e, k) => ok[k] && saved.push(e));
    }
  };
  if (w.features) {
    const size = Math.max(1, systemConfig().dataset.featureBatch);
    const bySnapshot = new Map<string, NewExample[]>();
    for (const e of examples) bySnapshot.set(e.snapshotId, [...(bySnapshot.get(e.snapshotId) ?? []), e]);
    for (const list of bySnapshot.values()) {
      for (let i = 0; i < list.length; i += size) {
        const batch = list.slice(i, i + size);
        const refs = await putFeatures(w.features, batch);
        if (!refs) continue;
        for (const e of batch) {
          const ref = refs[e.externalId];
          if (ref) e.featureRef = ref;
        }
        await saveAll(batch, saveIndex);
      }
    }
  } else await saveAll(examples, saveOne);
  if (saved.length < examples.length) w.tm.event('examples_not_saved', {count: examples.length - saved.length});
  return saved;
}

/** The average feature sizes (#32) and exact feature-missingness counts (#48) for saved examples. */
export function frozenFacts(
  snap: Pick<DatasetSnapshot, 'featureSizes' | 'featureMissingness' | 'counts'> | null,
  saved: NewExample[],
  zeroExcluded: Partial<Record<ExampleType, number>> = {},
): Pick<DatasetSnapshot, 'featureSizes' | 'featureMissingness'> {
  const kinds = (list: {type: string}[]) => ({video: list.filter(e => e.type === 'video').length, photo_text: list.filter(e => e.type === 'photo_text').length});
  const sizes = mergeFeatureSizes(snap?.featureSizes, {video: snap?.counts.video ?? 0, photo_text: snap?.counts.photoText ?? 0}, featureSizes(saved), kinds(saved));
  // Legacy snapshots without featureMissingness stay undefined once they already have valid examples.
  const legacy = !!snap && !snap.featureMissingness && snap.counts.valid > 0;
  if (legacy) return {featureSizes: sizes};
  const delta = computeFeatureMissingness(saved, zeroExcluded);
  return {
    featureSizes: sizes,
    featureMissingness: snap?.featureMissingness ? mergeFeatureMissingness(snap.featureMissingness, delta) : delta,
  };
}

/**
 * Balances the halves by gold label while no helper has read an example (spec 1.0.0, 4.2). Once
 * the holdout is locked nothing moves. Called when Gold Labels is left and before the lock.
 * Once scoring has started nothing moves either: a score rests on its held-out half, and moving
 * examples would leave every score out of date.
 */
export async function balanceHalves(w: Scope, projectId: string): Promise<number> {
  const {catalog} = w;
  const project = await catalog.get('projects', projectId);
  if (!project || project.holdoutLocked) return 0;
  const state = await loadProjectState(w, projectId);
  if (!state || state.reports.length || state.runs.length) return 0;
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const goldAnswers = Object.fromEntries(Object.entries(state.gold).map(([id, g]) => [id, g.answer]));
  const halves = assignEvalHalves(evalEx, goldAnswers, false);
  const moved = evalEx.filter(e => halves[e.id] !== e.optimiserHalf);
  if (moved.length) {
    await catalog.patchMany('examples', moved.map(e => ({id: e.id, patch: {optimiserHalf: halves[e.id]}})));
    await catalog.audit(projectId, 'system', 'dataset.halves', {moved: moved.length});
    w.emitChange(projectId);
  }
  w.tm.event('eval_halves_balanced', {moved: moved.length, locked: false});
  return moved.length;
}

/**
 * The holdout lock (spec 1.0.0, 4.2): called before a helper or the Optimiser first reads
 * examples. The halves are balanced one last time, then no example ever changes half again.
 */
export async function lockHoldout(w: Scope, projectId: string): Promise<void> {
  const {catalog} = w;
  const project = await catalog.get('projects', projectId);
  if (!project || project.holdoutLocked) return;
  await balanceHalves(w, projectId);
  await catalog.patch('projects', projectId, {holdoutLocked: true});
  await catalog.audit(projectId, 'system', 'dataset.holdout_locked', {});
}

/**
 * Adds examples to the eval dataset (spec 1.0.0, 4.3): ids already in it, removed ones too, are
 * skipped; existing examples, their halves and gold labels stay as they are. New examples take the
 * half that keeps the two even. Without a dataset yet it starts one.
 */
export async function appendExamples(
  w: Scope,
  projectId: string,
  raws: (RawExample & {sourceId?: string; sourceFileId?: string; fetchedAt?: string})[],
  source: DatasetSnapshot['source'],
  invalid = 0,
  checks?: ItemCheckCounts,
  zeroExcluded?: Partial<Record<ExampleType, number>>,
): Promise<{added: number; duplicates: number; notSaved: number}> {
  const {catalog, user} = w;
  const project = await catalog.get('projects', projectId);
  const snap = project?.snapshotId ? await catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!project || !snap) throw new Error('There is no eval dataset to add to yet.');
  const existing = await catalog.find('examples', {snapshotId: snap.id});
  const seen = new Set(existing.map(e => e.externalId));
  const fresh: typeof raws = [];
  for (const r of raws) {
    if (seen.has(r.externalId)) continue;
    seen.add(r.externalId);
    fresh.push(r);
  }
  const duplicates = raws.length - fresh.length;
  const hasZeroExcluded = Object.values(zeroExcluded ?? {}).some(n => (n ?? 0) > 0);
  let saved: NewExample[] = [];
  if (fresh.length) {
    const live = existing.filter(e => !e.removed);
    const added: NewExample[] = fresh.map(r => ({id: newId('ex'), snapshotId: snap.id, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: 'eval', optimiserHalf: false, ...(r.fetchedAt ? {fetchedAt: r.fetchedAt} : {}), ...(r.sourceId ? {sourceId: r.sourceId, sourceFileId: r.sourceFileId} : {})}));
    const {current: gold} = await (await import('./evaluation.ts')).latestGold(w, projectId, (await catalog.get('setup_versions', project.setupVersionId ?? ''))?.schemaVersion ?? 0);
    // The ones there keep their half (as if locked); only the new ones are placed.
    const goldAnswers = Object.fromEntries(Object.entries(gold).map(([id, g]) => [id, g.answer]));
    const place = (news: NewExample[]) => assignEvalHalves([...live.map(e => ({...e, optimiserHalf: e.optimiserHalf as boolean | null})), ...news.map(e => ({...e, optimiserHalf: null}))], goldAnswers, true);
    const halves = place(added);
    for (const e of added) e.optimiserHalf = halves[e.id];
    saved = await insertExamplesSettled(w, added);
    if (!saved.length) throw new Error('None of the examples could be saved. Try again.');
    if (saved.length < added.length) {
      // Some were skipped: place the saved ones again so the halves stay even.
      const again = place(saved);
      const moved = saved.filter(e => again[e.id] !== e.optimiserHalf);
      if (moved.length) await catalog.patchMany('examples', moved.map(e => ({id: e.id, patch: {optimiserHalf: again[e.id]}})));
    }
    await catalog.patch('dataset_snapshots', snap.id, {
      counts: {
        rows: snap.counts.rows + fresh.length + invalid,
        valid: snap.counts.valid + saved.length,
        invalid: snap.counts.invalid + invalid,
        video: snap.counts.video + saved.filter(r => r.type === 'video').length,
        photoText: snap.counts.photoText + saved.filter(r => r.type === 'photo_text').length,
        ...(snap.counts.notSaved || saved.length < fresh.length ? {notSaved: (snap.counts.notSaved ?? 0) + fresh.length - saved.length} : {}),
        ...(snap.counts.checks || checks ? {checks: addChecks(snap.counts.checks, checks ?? noChecks())} : {}),
      },
      split: {eval: (snap.split?.eval ?? 0) + saved.length, test: 0, train: 0},
      ...frozenFacts(snap, saved, zeroExcluded),
    });
  } else if (invalid || (checks && checksTotal(checks)) || hasZeroExcluded) {
    // Nothing new to add, but items were left out: they are still counted on the dataset.
    const legacy = !snap.featureMissingness && snap.counts.valid > 0;
    const missingnessPatch = hasZeroExcluded && !legacy ? {featureMissingness: mergeFeatureMissingness(snap.featureMissingness, computeFeatureMissingness([], zeroExcluded))} : {};
    await catalog.patch('dataset_snapshots', snap.id, {
      counts: {
        ...snap.counts,
        rows: snap.counts.rows + invalid,
        invalid: snap.counts.invalid + invalid,
        ...(snap.counts.checks || checks ? {checks: addChecks(snap.counts.checks, checks ?? noChecks())} : {}),
      },
      ...missingnessPatch,
    });
  }
  const notSaved = fresh.length - saved.length;
  await catalog.audit(projectId, (await user()).name, 'dataset.append', {source, added: saved.length, duplicates, ...(notSaved ? {notSaved} : {})});
  w.tm.event('dataset_appended', {source, added: saved.length, duplicates});
  w.emitChange(projectId);
  return {added: saved.length, duplicates, notSaved};
}

/**
 * Best-effort live adjustment of snapshot `featureMissingness.byType` on remove/restore (#48):
 * reads the affected examples' frozen features by id in `dataset.featureBatch` batches and
 * subtracts/merges with clamping. Never throws so stats failures never block removal or restore.
 */
async function adjustSnapshotMissingness(w: Scope, snapshotId: string, examples: Example[], op: 'remove' | 'restore'): Promise<void> {
  if (!examples.length) return;
  try {
    const snap = await w.catalog.get('dataset_snapshots', snapshotId);
    if (!snap?.featureMissingness) return;
    const features = await featuresOf(w, examples);
    const delta = computeFeatureMissingness(examples.map(e => ({type: e.type, features: features.get(e.id) ?? {}})));
    const next = op === 'remove' ? subtractFeatureMissingness(snap.featureMissingness, delta) : mergeFeatureMissingness(snap.featureMissingness, delta);
    await w.catalog.patch('dataset_snapshots', snap.id, {featureMissingness: next});
  } catch {
    // Best-effort: never block removing or restoring examples.
  }
}

/**
 * Removes examples from the eval dataset (spec 1.0.0, 4.4): soft delete, each with a
 * `DatasetRemoval` that keeps its half and gold label at the time. No other example changes half.
 */
export async function removeExamples(w: Scope, projectId: string, exampleIds: string[], reason: RemovalReason): Promise<number> {
  const {catalog, user} = w;
  const state = await loadProjectState(w, projectId);
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
  if (state.snapshot) await adjustSnapshotMissingness(w, state.snapshot.id, targets, 'remove');
  await catalog.audit(projectId, who, 'dataset.remove', {reason, count: records.length, withGold: records.filter(r => r.gold).length});
  w.tm.event('dataset_examples_removed', {reason, count: records.length, with_gold: records.filter(r => r.gold).length});
  w.emitChange(projectId);
  return records.length;
}

/** Puts removed examples back, in the half they had (spec 1.0.0, 4.4). */
export async function restoreExamples(w: Scope, projectId: string, removalIds: string[]): Promise<void> {
  const {catalog, user} = w;
  const removals = (await catalog.findByIds('dataset_removals', removalIds)).filter(r => r.projectId === projectId && !r.restoredAt);
  if (!removals.length) return;
  const at = now();
  await catalog.patchMany('dataset_removals', removals.map(r => ({id: r.id, patch: {restoredAt: at}})));
  await catalog.patchMany('examples', removals.map(r => ({id: r.exampleId, patch: {removed: false}})));
  try {
    const restored = await catalog.findByIds('examples', removals.map(r => r.exampleId));
    const bySnap = new Map<string, Example[]>();
    for (const e of restored) {
      const list = bySnap.get(e.snapshotId) ?? [];
      list.push(e);
      bySnap.set(e.snapshotId, list);
    }
    for (const [snapshotId, list] of bySnap) await adjustSnapshotMissingness(w, snapshotId, list, 'restore');
  } catch {
    // Best-effort: never block restoring examples.
  }
  await catalog.audit(projectId, (await user()).name, 'dataset.restore', {count: removals.length});
  w.tm.event('dataset_examples_restored', {count: removals.length});
  w.emitChange(projectId);
}

/**
 * Batch pruning (spec 1.0.0, 4.3): unlabeled examples down to `keep`, or the examples of an
 * over-represented gold value down to `keep`, at random but evenly from both halves.
 */
export async function pruneDataset(w: Scope, projectId: string, mode: 'unlabeled' | 'downsample', keep: number, value?: string): Promise<number> {
  const state = await loadProjectState(w, projectId);
  if (!state) throw new Error('This project does not exist.');
  const evalEx = state.examples.filter(e => e.split === 'eval');
  let candidates: Example[];
  if (mode === 'unlabeled') candidates = evalEx.filter(e => !state.gold[e.id]);
  else {
    if (!value) throw new Error('Name the value to downsample.');
    candidates = evalEx.filter(e => !!state.gold[e.id]?.answer.includes(value));
  }
  const ids = pickToPrune(candidates, keep);
  if (!ids.length) return 0;
  return removeExamples(w, projectId, ids, mode === 'unlabeled' ? 'excess_unlabeled' : 'downsample');
}

/** Adds a person's comment to an example (spec 1.0.0, 5.4); comments are never edited or deleted. */
export async function addComment(w: Scope, projectId: string, exampleId: string, text: string, promptVersionId: string | null = null): Promise<LabelComment> {
  const {catalog, user} = w;
  const body = text.trim().slice(0, systemConfig().labeling.commentMaxChars);
  if (!body) throw new Error('The comment is empty.');
  const ex = await catalog.get('examples', exampleId);
  const project = await catalog.get('projects', projectId);
  if (!ex || ex.snapshotId !== project?.snapshotId) throw new Error('This example is not in the eval dataset.');
  const u = await user();
  const c: LabelComment = {id: newId('lc'), projectId, exampleId, authorId: u.id, authorName: u.name, text: body, promptVersionId, createdAt: now()};
  await catalog.insert('label_comments', c);
  w.tm.event('label_comment_added', {where: promptVersionId ? 'mismatch' : 'eval', chars: body.length});
  w.emitChange(projectId);
  return c;
}

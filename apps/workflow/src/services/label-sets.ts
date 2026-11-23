import type {CreateLabelSetRequest, CreateLabelSetsRequest, LabelSet, LabelSetList, LabelSetPreview, LabelSetsPreview, PreviewLabelSetsRequest, UpdateLabelSetRequest} from '@yushiguang/sprint-contracts';
import {msg, newId} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {withRetries} from './access.ts';
import {latestGold} from './evaluation.ts';
import {isMismatch, versionAnswers} from './mismatches.ts';
import {loadProjectState} from './projects.ts';
import {notify} from './notify.ts';
import {ensureNumbered, withSamplesLock} from './samples.ts';
import {withLock} from './sources.ts';

/**
 * Label sets (docs/design/server.md 4.2): contiguous ranges of sample numbers that never overlap,
 * never change and are never deleted. A new set starts after the last one and takes the next
 * samples that are not removed; removed samples inside a range are hidden and counted nowhere.
 * One labeler per set for now: adding one grants them project write on the permission platform
 * and tells them by notification.
 */

const BUSY = 'The label sets are being changed. Try again in a minute.';
const withSetsLock = <T>(w: Scope, projectId: string, fn: () => Promise<T>) => withLock(w, `label-sets:${projectId}`, fn, BUSY);

/** Most labelers a set may have in this version. */
const MAX_LABELERS = 1;
const NAME_MAX = 80;

/** The label set page (W-LabelSet), where a labeler labels it. */
const goldPage = (projectId: string, setId: string) => `/gold/set/?p=${encodeURIComponent(projectId)}&set=${encodeURIComponent(setId)}`;
const setName = (s: Pick<LabelSet, 'name' | 'number'>) => s.name || `#${s.number}`;

async function datasetOf(w: Scope, projectId: string) {
  const project = await w.catalog.get('projects', projectId);
  if (!project || project.deleting) throw new Error('This project does not exist.');
  const snap = project.snapshotId ? await w.catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!snap) throw new Error('Add samples to the dataset first.');
  await ensureNumbered(w, snap);
  return {project, snap};
}

const setsOf = async (w: Scope, projectId: string) => (await w.catalog.find('label_sets', {projectId})).sort((a, b) => a.number - b.number);

/**
 * The numbers of the samples not removed and in no set yet, in order: what new sets take from.
 * Read whole (the store pages through them), never one page of them.
 */
async function unassignedNumbers(w: Scope, snapshotId: string, sets: LabelSet[]): Promise<number[]> {
  const start = sets.reduce((n, s) => Math.max(n, s.last), 0) + 1;
  const live = await w.catalog.find('examples', {snapshotId, removed: false}, 'number');
  return live.map(e => e.number!).filter(n => n >= start);
}

/** Checks the labelers asked for: at most one, each a member of the tenant (when the platform lists members). */
async function checkLabelers(w: Scope, tenantId: string, ids: string[]): Promise<string[]> {
  const list = [...new Set(ids.map(x => x.trim()).filter(Boolean))];
  if (list.length > MAX_LABELERS) throw new Error('A label set has one labeler for now.');
  if (list.length && w.permissionAdmin) {
    const members = new Set((await w.permissionAdmin.listTenantMembers(tenantId)).map(m => m.userId));
    if (list.some(id => !members.has(id))) throw new Error('A labeler must be a member of this tenant.');
  }
  return list;
}

/** Gives each new labeler project write, so they can save gold labels; nothing is saved when a grant fails. */
async function grantLabelers(w: Scope, tenantId: string, projectId: string, userIds: string[]): Promise<void> {
  const admin = w.permissionAdmin;
  if (!admin) return;
  for (const id of userIds) {
    try {
      await withRetries(() => admin.grantProjectWrite(w.ctx, tenantId, projectId, id), 3, w.grantRetryMs ?? 200);
    } catch {
      throw new Error('Edit access for the labeler could not be saved. Try again.');
    }
  }
}

const cleanName = (name: string | undefined) => (name ?? '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);

/**
 * Saves sets cut from the unassigned samples, in order; `sizesOf` gets how many there are and
 * gives each set's size (or throws). Under the project's sets lock, and inside it the dataset's
 * samples lock, so a take still saving examples is waited for: a range is never cut while a
 * sample inside it is still being written. Locks are always taken in that order.
 */
/**
 * The ranges new sets of these sizes would get, after the sets there are: each starts after the
 * last one and ends on the sample that makes its size, so removed samples are skipped.
 */
function plan(sets: LabelSet[], free: number[], sizesOf: (free: number) => number[]): LabelSetPreview[] {
  if (!free.length) throw new Error('Every sample is already in a label set.');
  const sizes = sizesOf(free.length);
  const want = sizes.reduce((n, k) => n + k, 0);
  if (want > free.length) throw new Error(`Only ${free.length} samples are left without a label set.`);
  const top = sets.reduce((n, s) => Math.max(n, s.number), 0);
  let at = 0;
  let first = sets.reduce((n, s) => Math.max(n, s.last), 0) + 1;
  return sizes.map((size, i) => {
    const last = free[at + size - 1];
    const p = {number: top + i + 1, first, last, samples: size};
    at += size;
    first = last + 1;
    return p;
  });
}

async function cut(w: Scope, projectId: string, sizesOf: (free: number) => number[], extra: {name?: string; labelers: (setIndex: number) => string[]}): Promise<LabelSet[]> {
  const {project, snap} = await datasetOf(w, projectId);
  const user = await w.user();
  return withSetsLock(w, projectId, () =>
    withSamplesLock(w, snap.id, async () => {
      const sets = await setsOf(w, projectId);
      const ranges = plan(sets, await unassignedNumbers(w, snap.id, sets), sizesOf);
      const want = ranges.reduce((n, r) => n + r.samples, 0);
      const labelers = await Promise.all(ranges.map((_, i) => checkLabelers(w, project.tenantId, extra.labelers(i))));
      await grantLabelers(w, project.tenantId, projectId, [...new Set(labelers.flat())]);
      const made: LabelSet[] = ranges.map((r, i) => ({id: newId('ls'), projectId, snapshotId: snap.id, number: r.number, name: cleanName(extra.name), first: r.first, last: r.last, labelerIds: labelers[i], createdAt: now(), createdBy: user.id}));
      // One after another, in order: a write that fails leaves the sets before it and none after,
      // so no range is skipped and trying again cuts what is left.
      for (const set of made) await w.catalog.insert('label_sets', set);
      await w.catalog.audit(projectId, user.name, 'label_sets.create', {count: made.length, samples: want});
      w.emitChange(projectId);
      return made;
    }),
  );
}

/** Tells the labelers of a set (not the person who made the change) that they label it. */
async function tellLabelers(w: Scope, set: LabelSet, userIds: string[], kind: 'label_set_created' | 'labeler_added'): Promise<void> {
  const to = userIds.filter(id => id !== w.ctx.user.id);
  if (!to.length) return;
  const project = (await w.catalog.get('projects', set.projectId))?.name ?? '';
  const params = {set: setName(set), project, from: String(set.first), to: String(set.last)};
  await notify(w, {
    userIds: to,
    kind,
    projectId: set.projectId,
    link: goldPage(set.projectId, set.id),
    title: msg('You have samples to label'),
    msg: kind === 'label_set_created' ? msg('A new label set {set} (samples {from} to {to}) in {project} is yours to label.', params) : msg('You were added as a labeler of label set {set} (samples {from} to {to}) in {project}.', params),
  });
}

export async function createLabelSet(w: Scope, req: CreateLabelSetRequest): Promise<LabelSet> {
  oneOf(req.count);
  const [set] = await cut(w, req.projectId, () => [req.count], {name: req.name, labelers: () => req.labelerIds ?? []});
  await tellLabelers(w, set, set.labelerIds, 'label_set_created');
  return set;
}

/** The sizes of several sets, by number of sets or by samples per set (checked before anything is read). */
function splitBy(req: {sets?: number; perSet?: number}): (free: number) => number[] {
  const by = req.sets != null ? 'sets' : 'perSet';
  const n = req.sets ?? req.perSet;
  if ((req.sets != null) === (req.perSet != null)) throw new Error('Give the number of sets or the samples per set.');
  if (!Number.isInteger(n) || n! < 1) throw new Error(by === 'sets' ? 'Make at least 1 label set.' : 'A label set needs at least 1 sample.');
  return free => {
    if (by === 'perSet') return Array.from({length: Math.ceil(free / n!)}, (_, i) => Math.min(n!, free - i * n!));
    if (n! > free) throw new Error(`Only ${free} samples are left without a label set.`);
    return Array.from({length: n!}, (_, i) => Math.floor(free / n!) + (i < free % n! ? 1 : 0));
  };
}

/** One set of `count` samples (checked before anything is read). */
function oneOf(count: number | undefined): (free: number) => number[] {
  if (!Number.isInteger(count) || count! < 1) throw new Error('A label set needs at least 1 sample.');
  return () => [count!];
}

/** Splits the unassigned samples into sets by number of sets or by samples per set; see `CreateLabelSetsRequest`. */
export async function createLabelSets(w: Scope, req: CreateLabelSetsRequest): Promise<LabelSet[]> {
  const sizesOf = splitBy(req);
  // Sizes come from the samples left when the sets lock is held, so a set made meanwhile is counted.
  const made = await cut(w, req.projectId, sizesOf, {labelers: i => (req.labelers?.[i] ? [req.labelers[i]!] : [])});
  for (const set of made) await tellLabelers(w, set, set.labelerIds, 'label_set_created');
  return made;
}

/**
 * The sets a create would make now (#107), for the create dialogs: the same ranges and the same
 * refusals as the create, read without the locks and saving nothing. A refusal comes back as
 * `error`, with no sets.
 */
export async function previewLabelSets(w: Scope, req: PreviewLabelSetsRequest): Promise<LabelSetsPreview> {
  const project = await w.catalog.get('projects', req.projectId);
  const snap = project?.snapshotId ? await w.catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!project || project.deleting) throw new Error('This project does not exist.');
  if (!snap) return {sets: [], unassigned: 0, error: 'Add samples to the dataset first.'};
  await ensureNumbered(w, snap);
  const sets = await setsOf(w, req.projectId);
  const free = await unassignedNumbers(w, snap.id, sets);
  try {
    const sizesOf = req.count != null ? (req.sets != null || req.perSet != null ? null : oneOf(req.count)) : splitBy(req);
    if (!sizesOf) throw new Error('Give the number of samples, the number of sets or the samples per set.');
    return {sets: plan(sets, free, sizesOf), unassigned: free.length};
  } catch (e) {
    return {sets: [], unassigned: free.length, error: (e as Error).message};
  }
}

export async function updateLabelSet(w: Scope, req: UpdateLabelSetRequest): Promise<LabelSet> {
  const project = await w.catalog.get('projects', req.projectId);
  if (!project || project.deleting) throw new Error('This project does not exist.');
  const labelers = req.labelerIds ? await checkLabelers(w, project.tenantId, req.labelerIds) : null;
  const user = await w.user();
  const {set, added} = await withSetsLock(w, req.projectId, async () => {
    const set = await w.catalog.get('label_sets', req.labelSetId);
    if (!set || set.projectId !== req.projectId) throw new Error('This label set does not exist.');
    const added = labelers ? labelers.filter(id => !set.labelerIds.includes(id)) : [];
    await grantLabelers(w, project.tenantId, req.projectId, added);
    // A labeler taken off keeps project write: it may have been given for other work.
    const patch = {...(req.name != null ? {name: cleanName(req.name)} : {}), ...(labelers ? {labelerIds: labelers} : {})};
    if (Object.keys(patch).length) {
      await w.catalog.patch('label_sets', set.id, patch);
      await w.catalog.audit(req.projectId, user.name, 'label_sets.update', {set: set.number, ...(req.name != null ? {renamed: true} : {}), ...(labelers ? {labelers: labelers.length} : {})});
      w.emitChange(req.projectId);
    }
    return {set: {...set, ...patch}, added};
  });
  await tellLabelers(w, set, added, 'labeler_added');
  return set;
}

/**
 * The project's label sets with how many samples each has (not removed), how many are gold-labeled
 * and how many of those are mismatches (the Dataset page's rule: the gold label against the best
 * version's answer), and the same two counts for the whole dataset.
 */
export async function listLabelSets(w: Scope, projectId: string): Promise<LabelSetList> {
  const project = await w.catalog.get('projects', projectId);
  const snap = project?.snapshotId ? await w.catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!project || !snap) return {sets: [], unassigned: 0, labeled: 0, mismatch: 0};
  await ensureNumbered(w, snap);
  const setup = project.setupVersionId ? await w.catalog.get('setup_versions', project.setupVersionId) : null;
  const [sets, examples, {current: gold}, state] = await Promise.all([setsOf(w, projectId), w.catalog.find('examples', {snapshotId: snap.id}), latestGold(w, projectId, setup?.schemaVersion ?? 0), loadProjectState(w, projectId)]);
  const found = state ? await versionAnswers(w, state) : null;
  const answers = found?.answers.get(found.best.id);
  const live = examples.filter(e => !e.removed);
  const labeledIn = (list: typeof live) => list.filter(e => !!gold[e.id]);
  const mismatchIn = (list: typeof live) => (answers ? labeledIn(list).filter(e => answers.has(e.id) && isMismatch(gold[e.id]!.answer, answers.get(e.id))).length : 0);
  const inRange = (s: LabelSet) => live.filter(e => e.number! >= s.first && e.number! <= s.last);
  const end = sets.reduce((n, s) => Math.max(n, s.last), 0);
  return {
    sets: sets.map(s => {
      const own = inRange(s);
      return {...s, samples: own.length, labeled: labeledIn(own).length, mismatch: mismatchIn(own)};
    }),
    unassigned: live.filter(e => e.number! > end).length,
    labeled: labeledIn(live).length,
    mismatch: mismatchIn(live),
  };
}

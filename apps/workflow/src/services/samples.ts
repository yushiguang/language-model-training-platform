import type {DatasetSnapshot, DocFilterExpression, Example, ListSamplesRequest, SampleFilter, SamplePage} from '@yushiguang/sprint-contracts';
import type {Scope} from './app.ts';
import {isMismatch, versionAnswers} from './mismatches.ts';
import {loadProjectState} from './projects.ts';
import {withLock} from './sources.ts';

/**
 * Sample numbers (docs/design/server.md 4.2): every example of a dataset has a number from 1, in
 * the order examples were added, that never changes. Removing an example only flags it, so the
 * others keep their numbers; label sets are ranges of them. The Dataset page reads the samples a
 * page at a time from the store, filtered by these numbers and the explicit `removed` flag.
 */

const BUSY = 'The dataset is being changed. Try again in a minute.';

/** Held while a dataset's examples get numbers, so two writers never hand out the same one. */
export const withSamplesLock = <T>(w: Scope, snapshotId: string, fn: () => Promise<T>) => withLock(w, `samples:${snapshotId}`, fn, BUSY);

/** The next free number after these examples (1 for none). */
export const nextNumber = (examples: Pick<Example, 'number'>[]) => examples.reduce((n, e) => Math.max(n, e.number ?? 0), 0) + 1;

/**
 * Numbers the examples of a dataset made before numbers, in the order the store keeps them (the
 * order they were saved), after any already numbered, and writes `removed: false` where it was
 * left out, then marks the dataset `numbered`. Running it again changes nothing.
 */
export async function ensureNumbered(w: Scope, snap: DatasetSnapshot): Promise<void> {
  if (snap.numbered) return;
  await withSamplesLock(w, snap.id, async () => {
    const again = await w.catalog.get('dataset_snapshots', snap.id);
    if (!again || again.numbered) return;
    const examples = await w.catalog.find('examples', {snapshotId: snap.id});
    let next = nextNumber(examples);
    // Only what is missing is written: a removal or restore made meanwhile (they do not take this
    // lock) keeps its `removed`.
    const patches = examples.filter(e => e.number == null || e.removed == null).map(e => ({id: e.id, patch: {...(e.number == null ? {number: next++} : {}), ...(e.removed == null ? {removed: false} : {})}}));
    if (patches.length) await w.catalog.patchMany('examples', patches);
    await w.catalog.patch('dataset_snapshots', snap.id, {numbered: true});
  });
}

const field = (name: string, op: '==' | '>=' | '<=' | 'in' | 'not-in', value: unknown): DocFilterExpression => ({type: 'field', field: name, op, value});

const ORDER: Record<NonNullable<ListSamplesRequest['sort']>, string> = {number: 'number', '-number': 'number desc', externalId: 'externalId, number', '-externalId': 'externalId desc, number'};

/**
 * One page of the dataset's samples; see `ListSamplesRequest`. The tabs' filters and counts need
 * the gold labels and the best version's answers (`versionAnswers`), which are read for the project
 * as a whole; the page itself, its order and its total come from the store.
 */
export async function listSamples(w: Scope, req: ListSamplesRequest): Promise<SamplePage> {
  const {catalog} = w;
  const none: SamplePage = {items: [], total: 0, model: null, counts: {live: 0, no_label: 0, mismatch: 0, removed: 0}};
  const project = await catalog.get('projects', req.projectId);
  const snap = project?.snapshotId ? await catalog.get('dataset_snapshots', project.snapshotId) : null;
  if (!project || !snap) return none;
  await ensureNumbered(w, snap);
  const state = await loadProjectState(w, req.projectId);
  if (!state) return none;
  const gold = state.gold;
  const found = await versionAnswers(w, state);
  const answers = found?.answers.get(found.best.id);
  const labeled = Object.keys(gold);
  const mismatched = answers ? [...answers.keys()].filter(id => isMismatch(gold[id]!.answer, answers.get(id))) : [];

  // The dataset (or the label set): what the tab counts are of.
  const base: DocFilterExpression[] = [field('snapshotId', '==', snap.id)];
  if (req.labelSetId) {
    const set = await catalog.get('label_sets', req.labelSetId);
    if (!set || set.projectId !== req.projectId) throw new Error('This label set does not exist.');
    base.push(field('number', '>=', set.first), field('number', '<=', set.last));
  }
  const live = field('removed', '==', false);
  const tab: Record<SampleFilter, DocFilterExpression[]> = {
    live: [live],
    no_label: [live, field('id', 'not-in', labeled)],
    mismatch: [live, field('id', 'in', mismatched)],
    removed: [field('removed', '==', true)],
  };
  const count = async (f: SampleFilter) => (await catalog.page('examples', {where: {type: 'and', filters: [...base, ...tab[f]]}, limit: 1})).total;
  const filter: SampleFilter = req.filter && req.filter in tab ? req.filter : 'live';

  const filters = [...base, ...tab[filter]];
  const query = req.query?.trim();
  if (query) {
    // A number only when it can be one (a long numeric sample ID is looked up as an ID only).
    const n = /^#?\d{1,9}$/.test(query) ? Number(query.replace('#', '')) : 0;
    const asNumber = n >= 1 ? n : null;
    filters.push(asNumber != null ? {type: 'or', filters: [field('number', '==', asNumber), field('externalId', '==', query)]} : field('externalId', '==', query));
  }
  if (req.sourceId) filters.push(field('sourceId', '==', req.sourceId));
  if (req.gold) filters.push(field('id', 'in', labeled.filter(id => gold[id]!.answer.includes(req.gold!))));
  const whole = (x: number | undefined, d: number) => (Number.isFinite(x) ? Math.floor(x!) : d);
  const limit = Math.min(500, Math.max(1, whole(req.limit, 50)));
  const offset = Math.max(0, whole(req.offset, 0));
  const [page, counts] = await Promise.all([
    catalog.page('examples', {where: {type: 'and', filters}, order: ORDER[req.sort ?? 'number'] ?? 'number', offset, limit}),
    Promise.all((['live', 'no_label', 'mismatch', 'removed'] as const).map(async f => [f, await count(f)] as const)).then(Object.fromEntries) as Promise<SamplePage['counts']>,
  ]);
  const ids = page.items.map(e => e.id);
  const sourceIds = [...new Set(page.items.map(e => e.sourceId).filter((x): x is string => !!x))];
  const [sources, removals] = await Promise.all([
    catalog.findByIds('data_sources', sourceIds),
    filter === 'removed' && ids.length ? catalog.find('dataset_removals', {projectId: req.projectId}) : Promise.resolve([]),
  ]);
  const sourceName = new Map(sources.map(s => [s.id, s.name]));
  // The removal that stands: not restored, the newest if an example was removed again.
  const removalOf = new Map(removals.filter(r => !r.restoredAt).sort((a, b) => a.removedAt.localeCompare(b.removedAt)).map(r => [r.exampleId, r]));
  const mismatch = new Set(mismatched);
  return {
    total: page.total,
    model: found ? {versionId: found.best.id, label: found.best.label} : null,
    counts,
    items: page.items.map(e => {
      const r = removalOf.get(e.id);
      const p = answers?.get(e.id);
      return {
        number: e.number!,
        exampleId: e.id,
        externalId: e.externalId,
        type: e.type,
        source: e.sourceId ? {id: e.sourceId, name: sourceName.get(e.sourceId) ?? e.sourceId} : null,
        labeled: !!gold[e.id],
        gold: gold[e.id]?.answer ?? null,
        model: p && !p.filtered ? p.answer : null,
        mismatch: mismatch.has(e.id),
        removal: r ? {id: r.id, reason: r.reason, note: r.note ?? null, removedBy: r.removedBy, removedAt: r.removedAt} : null,
      };
    }),
  };
}

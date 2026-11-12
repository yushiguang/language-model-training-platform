import type {Answer, DryRunResult, Example, ExampleBrief, OptimisationRun, OptimiserRound, Prediction, PromptVersion, Schema} from '@tsp/contracts';
import {placeholderKeys} from './template.ts';
import {isImageKey} from './catalogue.ts';

/**
 * Pure parts of the Optimiser (GEPA, ported to TypeScript; see
 * docs/design/optimiser.md): per-example scores, the Pareto front, picking a parent and the dry-run examples,
 * and comparing a change with its parent in the dry run. The loop itself is in the bff.
 */

const same = (a: string[] | undefined, b: string[] | undefined) => {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Fields of one answer that match the gold label. An invalid answer (null) gets none. */
export function fieldsRight(schema: Schema, gold: Answer, predicted: Answer | null): string[] {
  if (!predicted) return [];
  return schema.fields.filter(f => same(gold[f.name], predicted[f.name])).map(f => f.name);
}

/** One example's score: the share of fields right (1 = every field matches the gold label). */
export const exampleScore = (schema: Schema, gold: Answer, predicted: Answer | null) => (schema.fields.length ? fieldsRight(schema, gold, predicted).length / schema.fields.length : 0);

/** Dry-run size: half of the optimiser half, at most 20 (D4, 2026-11-10). */
export const dryRunSize = (optimiserHalf: number) => Math.min(20, Math.max(1, Math.floor(optimiserHalf / 2)));

/** The features a version's prompt shows the model: its ticked features and its placeholders. */
export const promptKeys = (v: Pick<PromptVersion, 'template' | 'features'>) => new Set([...v.features.video, ...v.features.photo_text, ...v.features.metadata, ...placeholderKeys(v.template)]);

/** How long one feature may be in an example a helper reads. */
export const BRIEF_FEATURE_CHARS = 300;
/** How many wrong examples a helper reads (D3), and how many each version wins in a merge. */
export const BRIEF_WRONG = 8;
export const BRIEF_WINS = 4;

/** How many images of one example a helper sees. */
export const BRIEF_IMAGES = 2;

/**
 * An example as a helper reads it: the text features in `keys`, cut short (URLs left out), and
 * up to 2 of its images (any image feature, whether or not the prompt uses it).
 */
export function exampleBrief(e: Example, keys: Iterable<string>, gold: Answer, predicted: Answer | null, rightIn?: 'template' | 'other', said?: HelperNote): ExampleBrief {
  const features: Record<string, string> = {};
  for (const k of keys) {
    const v = e.features[k];
    if (typeof v !== 'string' || !v.trim() || /^https?:\/\//.test(v.trim())) continue;
    features[k] = v.length > BRIEF_FEATURE_CHARS ? `${v.slice(0, BRIEF_FEATURE_CHARS - 1).trimEnd()}…` : v;
  }
  const images = Object.entries(e.features)
    .filter(([k]) => isImageKey(k))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter(u => typeof u === 'string' && u.trim())
    .slice(0, BRIEF_IMAGES);
  return {externalId: e.externalId, features, gold, predicted, ...(said?.reason ? {reason: said.reason} : {}), ...(said?.invalid ? {invalid: said.invalid} : {}), ...(images.length ? {images} : {}), ...(rightIn ? {rightIn} : {})};
}

/**
 * Decided 2026-11-11 (review finding 3): no helper, agent or the Optimiser ever reads an example of
 * the held-out half of the eval set: not its features, gold label or the model's answers. Scores
 * and counts built on it may still be shown.
 */
export const visibleToAgents = (e: Pick<Example, 'split' | 'optimiserHalf'>): boolean => !(e.split === 'eval' && !e.optimiserHalf);

/** What a tool says when it leaves held-out examples out, so a helper doesn't ask for them. */
export const HIDDEN_NOTE = 'The held-out half of the eval set is hidden from helpers so its scores stay fair; it is not in this list.';

/**
 * The examples a version gets wrong, worst first (fewest fields right), at most `max`. Pass only
 * optimiser-half examples: the held-out half must never reach a helper.
 */
export function wrongExamples(schema: Schema, examples: Example[], keys: Iterable<string>, gold: Map<string, Answer>, predicted: Map<string, Answer | null>, max = BRIEF_WRONG, notes?: Map<string, HelperNote>): ExampleBrief[] {
  const ks = [...keys];
  return examples
    .filter(e => gold.has(e.id) && predicted.has(e.id))
    .map(e => ({e, s: exampleScore(schema, gold.get(e.id)!, predicted.get(e.id)!)}))
    .filter(x => x.s < 1)
    .sort((a, b) => a.s - b.s)
    .slice(0, max)
    .map(({e}) => exampleBrief(e, ks, gold.get(e.id)!, predicted.get(e.id)!, undefined, notes?.get(e.id)));
}

/** What a helper reads next to a model answer: the model's own reason, and why a reply was invalid. */
export interface HelperNote {
  reason?: string;
  invalid?: string;
}

/**
 * Saved answers as the helpers read them (decided 2026-11-11): each answer with the model's reason
 * and the invalid reason. Answers the safety filter stopped are left out: there is nothing in
 * them for a prompt to fix.
 */
export function answersForHelpers(preds: Iterable<Pick<Prediction, 'exampleId' | 'answer' | 'invalidReason' | 'reason' | 'filtered'>>): {predicted: Map<string, Answer | null>; notes: Map<string, HelperNote>} {
  const predicted = new Map<string, Answer | null>();
  const notes = new Map<string, HelperNote>();
  for (const p of preds) {
    if (p.filtered) continue;
    predicted.set(p.exampleId, p.answer);
    if (p.reason || (!p.answer && p.invalidReason)) notes.set(p.exampleId, {...(p.reason ? {reason: p.reason} : {}), ...(!p.answer && p.invalidReason ? {invalid: p.invalidReason} : {})});
  }
  return {predicted, notes};
}

/** A version in the pool with its scores on the optimiser half, by example id. */
export interface PoolEntry {
  id: string;
  scores: Map<string, number>;
}

/** a is at least as good as b on every example and better on one. */
const dominates = (a: PoolEntry, b: PoolEntry, exampleIds: string[]) => {
  let better = false;
  for (const ex of exampleIds) {
    const x = a.scores.get(ex) ?? 0;
    const y = b.scores.get(ex) ?? 0;
    if (x < y) return false;
    if (x > y) better = true;
  }
  return better;
};

/**
 * The Pareto front: every version that is the best (ties included) on at least one example of
 * the optimiser half, with how many examples it is best on; a version another one beats or
 * matches everywhere is left out (as GEPA does). A version that fixes a hard case stays a
 * possible parent even when its average is lower.
 */
export function paretoFront(pool: PoolEntry[], exampleIds: string[]): {id: string; wins: number}[] {
  const wins = new Map<string, number>();
  const kept = pool.filter(p => !pool.some(q => q !== p && dominates(q, p, exampleIds)));
  for (const ex of exampleIds) {
    const scored = kept.filter(p => p.scores.has(ex));
    if (!scored.length) continue;
    const best = Math.max(...scored.map(p => p.scores.get(ex)!));
    for (const p of scored) if (p.scores.get(ex) === best) wins.set(p.id, (wins.get(p.id) ?? 0) + 1);
  }
  return kept.filter(p => wins.has(p.id)).map(p => ({id: p.id, wins: wins.get(p.id)!}));
}

/** Picks a parent from the front at random, weighted by how many examples it is best on. */
export function pickParent(front: {id: string; wins: number}[], rand: () => number = Math.random): string | null {
  const total = front.reduce((n, f) => n + f.wins, 0);
  if (!total) return null;
  let r = rand() * total;
  for (const f of front) {
    r -= f.wins;
    if (r < 0) return f.id;
  }
  return front[front.length - 1].id;
}

/** Two front versions that each win examples the other misses: worth merging. */
export function mergePair(pool: PoolEntry[], front: {id: string; wins: number}[]): [string, string] | null {
  const ids = [...front].sort((a, b) => b.wins - a.wins).map(f => f.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = pool.find(p => p.id === ids[i])!;
      const b = pool.find(p => p.id === ids[j])!;
      const aOnly = [...a.scores].some(([ex, s]) => s > (b.scores.get(ex) ?? 0));
      const bOnly = [...b.scores].some(([ex, s]) => s > (a.scores.get(ex) ?? 0));
      if (aOnly && bOnly) return [a.id, b.id];
    }
  return null;
}

/**
 * The dry-run examples: `size` examples of the optimiser half picked at random, as GEPA does
 * (review finding 5: re-testing only the parent's mistakes lets a change that does nothing pass by
 * luck). Up to half come from `focus`, the examples whose gold label holds the weakest value of
 * the lowest field (finding 7), so a change aimed at the gate is tested where it matters.
 */
export function pickDryRun(exampleIds: string[], size: number, focus: Set<string> = new Set(), rand: () => number = Math.random): string[] {
  const shuffle = (xs: string[]) =>
    xs
      .map(x => ({x, k: rand()}))
      .sort((a, b) => a.k - b.k)
      .map(o => o.x);
  const inFocus = shuffle(exampleIds.filter(id => focus.has(id))).slice(0, Math.floor(size / 2));
  const taken = new Set(inFocus);
  return [...inFocus, ...shuffle(exampleIds.filter(id => !taken.has(id)))].slice(0, size);
}

/**
 * Compares a change with its parent on the dry-run examples. It goes on only when it gets more
 * fields right in total (finding 5), the `lowest` field counting double (finding 7: the gate is
 * that field's score). `passed` and `parentPassed` still count examples fully right.
 */
/**
 * The dry run's verdict. `better`: more fields right, the lowest field counting double. `tied`
 * (acceptance R5-6): as many, but right on different examples, so the change may hold something
 * the parent lacks; it goes on to the full labeling without counting as progress.
 */
export function compareDryRun(schema: Schema, parentId: string, items: {gold: Answer; candidate: Answer | null; parent: Answer | null}[], lowest?: string): DryRunResult & {better: boolean; tied: boolean} {
  const all = (a: Answer | null, gold: Answer) => fieldsRight(schema, gold, a).length === schema.fields.length;
  const passed = items.filter(i => all(i.candidate, i.gold)).length;
  const parentPassed = items.filter(i => all(i.parent, i.gold)).length;
  const fields = schema.fields.map(f => ({
    field: f.name,
    passed: items.filter(i => fieldsRight(schema, i.gold, i.candidate).includes(f.name)).length,
    parentPassed: items.filter(i => fieldsRight(schema, i.gold, i.parent).includes(f.name)).length,
  }));
  const weighted = (k: 'passed' | 'parentPassed') => fields.reduce((n, f) => n + f[k] * (f.field === lowest ? 2 : 1), 0);
  const differs = items.some(i => fieldsRight(schema, i.gold, i.candidate).join() !== fieldsRight(schema, i.gold, i.parent).join());
  return {examples: items.length, passed, parentPassed, parentId, fields, better: weighted('passed') > weighted('parentPassed'), tied: weighted('passed') === weighted('parentPassed') && differs};
}

/** What the Optimiser did with a version, for the versions list and the version card. */
export interface OptimiserVersionInfo {
  run: OptimisationRun;
  round: OptimiserRound;
}

/** Every version an Optimiser run made, by id, with its round (dropped, kept, running…). */
export function optimiserVersions(runs: OptimisationRun[]): Map<string, OptimiserVersionInfo> {
  const out = new Map<string, OptimiserVersionInfo>();
  for (const run of runs) for (const round of run.history ?? []) if (round.versionId) out.set(round.versionId, {run, round});
  return out;
}

/** The labels of the panel's "Now" line. */
export function stepLine(step: OptimisationRun['step'], version: string | null, examples: number, parent?: string | null): string {
  switch (step) {
    case 'parent':
      return version ? `Labeling ${version} on the eval set, the version to start from` : 'Picking the version to start from';
    case 'reflect':
      return `Writing a change to ${version ?? 'the prompt'}`;
    case 'merge':
      return 'Writing a version that merges two others';
    case 'check':
      return `Checking ${version ?? 'the change'}`;
    case 'dry_run':
      return `Dry run: labeling ${version ?? 'the change'} on ${examples} examples${parent ? `, against ${parent}` : ''}`;
    case 'full':
      return `Labeling ${version ?? 'the change'} on the eval set`;
    case 'report':
      return `Scoring ${version ?? 'the change'}`;
    case 'confirm':
      return `Confirming ${version ?? 'the pass'}: labeling the held-out half again`;
    default:
      return 'Starting';
  }
}

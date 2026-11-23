import type {Example, GoldLabel, LabelSet, ProjectState, ScoreBasis, ScoreBasisPart, ScoringState, Thresholds} from '@yushiguang/sprint-contracts';
import {hashString} from './template.ts';

/**
 * Scores and Rescore (docs/design/server.md 4.3): scores are made only once every label set is
 * finished, on the eval samples inside label sets; a changed basis (gold labels, thresholds or
 * samples) leaves older scores as they are until someone presses Rescore.
 */

export type SampleRanges = ScoringState['ranges'];

/** Is this sample inside a label set? Every sample is while the project has none (`null`). */
export const inRanges = (e: Pick<Example, 'number'>, ranges: SampleRanges): boolean =>
  ranges == null || (e.number != null && ranges.some(r => e.number! >= r.first && e.number! <= r.last));

/**
 * How far labeling is, from the live (not removed) eval samples, the current gold labels and the
 * dataset's label sets. A set is finished when every live sample in its range has a gold label
 * (a set whose samples were all removed is finished). With no set at all, the whole dataset is
 * one set: a transition until the label set pages ship.
 */
export function labelSetProgress(examples: Pick<Example, 'id' | 'number'>[], gold: Record<string, unknown>, sets: Pick<LabelSet, 'first' | 'last'>[]) {
  const ranges: SampleRanges = sets.length ? [...sets].sort((a, b) => a.first - b.first).map(s => ({first: s.first, last: s.last})) : null;
  const inside = examples.filter(e => inRanges(e, ranges));
  const labeled = inside.filter(e => !!gold[e.id]).length;
  const done = ranges
    ? ranges.filter(r => inside.every(e => !!gold[e.id] || e.number! < r.first || e.number! > r.last)).length
    : inside.length && labeled === inside.length ? 1 : 0;
  const total = ranges ? ranges.length : 1;
  return {ranges, labelSets: ranges ? ranges.length : 0, labelSetsDone: ranges ? done : 0, samples: inside.length, labeled, ready: inside.length > 0 && done === total};
}

/** Thresholds as text that does not depend on key order, or on a missing value versus null. */
function thresholdsText(t: Thresholds | null | undefined): string {
  if (!t) return 'none';
  const all = {...t, precision: t.precision ?? null, recall: t.recall ?? null} as Record<string, unknown>;
  return Object.keys(all)
    .sort()
    .map(k => `${k}=${all[k] ?? null}`)
    .join(';');
}

/**
 * Today's basis from the samples scored on (eval samples inside label sets, empty while a set is
 * unfinished), their gold labels and the thresholds; `contextId` is all of it with the label's
 * schema version, the id every report carries.
 */
export function scoreBasis(schemaVersion: number, scored: Pick<Example, 'id' | 'optimiserHalf'>[], gold: Record<string, Pick<GoldLabel, 'id'>>, thresholds: Thresholds | null | undefined): {basis: ScoreBasis; contextId: string} {
  const samples = hashString(scored.map(e => `${e.id}:${e.optimiserHalf ? 'o' : 'h'}`).sort().join(','));
  const labels = hashString(scored.map(e => `${e.id}:${gold[e.id]?.id ?? '-'}`).sort().join(','));
  const basis: ScoreBasis = {samples, gold: labels, thresholds: hashString(thresholdsText(thresholds))};
  return {basis, contextId: `ctx_${hashString(`${schemaVersion}|${basis.samples}|${basis.gold}|${basis.thresholds}`)}`};
}

/**
 * What changed from a report's basis to today's. A changed sample list changes the gold part too,
 * so gold is named only when the samples are the same.
 */
export function basisChanges(was: ScoreBasis | undefined, now: ScoreBasis): ScoreBasisPart[] {
  if (!was) return [];
  const out: ScoreBasisPart[] = [];
  if (was.samples !== now.samples) out.push('samples');
  else if (was.gold !== now.gold) out.push('gold');
  if (was.thresholds !== now.thresholds) out.push('thresholds');
  return out;
}

type StaleInput = Pick<ProjectState, 'setup' | 'versions' | 'reports' | 'contextId'> & {ready: boolean; basis: ScoreBasis};

/**
 * The versions Rescore would work out again: of the current label, with a score on an older basis
 * and none on today's, for each model. `cannotBuild` holds "versionId|endpoint|contextId" a
 * Rescore found without saved answers for every sample (they need scoring again, not Rescore).
 * Nothing is out of date while a label set is unfinished: no scores are made then.
 */
export function staleScores(s: StaleInput, cannotBuild: ReadonlySet<string> = new Set()): {staleVersionIds: string[]; changed: ScoreBasisPart[]} {
  if (!s.ready || !s.setup?.schema) return {staleVersionIds: [], changed: []};
  const current = new Set(s.reports.filter(r => r.contextId === s.contextId).map(r => `${r.promptVersionId}|${r.endpoint}`));
  const newest = new Map<string, ProjectState['reports'][number]>();
  for (const r of s.reports) {
    const key = `${r.promptVersionId}|${r.endpoint}`;
    if (r.contextId === s.contextId || current.has(key) || r.schemaVersion !== s.setup.schemaVersion) continue;
    if (!s.versions.some(v => v.id === r.promptVersionId) || cannotBuild.has(`${key}|${s.contextId}`)) continue;
    const had = newest.get(key);
    if (!had || r.createdAt > had.createdAt) newest.set(key, r);
  }
  const ids = new Set<string>();
  const changed = new Set<ScoreBasisPart>();
  for (const r of newest.values()) {
    ids.add(r.promptVersionId);
    for (const p of basisChanges(r.basis, s.basis)) changed.add(p);
  }
  const order: ScoreBasisPart[] = ['gold', 'samples', 'thresholds'];
  return {staleVersionIds: s.versions.filter(v => ids.has(v.id)).map(v => v.id), changed: order.filter(p => changed.has(p))};
}

/** The samples scores are made on: eval samples inside label sets, none while a set is unfinished. */
export const scoredExamples = <E extends Pick<Example, 'split' | 'number'>>(s: {examples: E[]; scoring: Pick<ScoringState, 'ready' | 'ranges'>}): E[] =>
  s.scoring.ready ? s.examples.filter(e => e.split === 'eval' && inRanges(e, s.scoring.ranges)) : [];

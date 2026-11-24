import type {EndpointId, LabelingRun, OptimisationRun, PromptVersion} from '@yushiguang/sprint-contracts';
import {shownVersions, withNewestReports} from '@yushiguang/sprint-domain';
import type {ProjectState} from '@/backend-api';

type Report = ProjectState['reports'][number];

/**
 * What one version card on Prompt Tuning shows (wireframes v346, rounds 10 to 18): a score, or where
 * its labeling stands. One card per major version (`shownVersions`); an Optimiser run that is under
 * way, failed or paused has a card of its own (`optimiser`).
 */
export type CardState =
  | {kind: 'scored'; report: Report}
  | {kind: 'labeling'; runs: LabelingRun[]; done: number; total: number}
  | {kind: 'queued'; runs: LabelingRun[]; ahead: number}
  | {kind: 'failed'; run: LabelingRun}
  | {kind: 'stopped'; run: LabelingRun}
  | {kind: 'labeled'; run: LabelingRun}
  | {kind: 'new'}
  | {kind: 'optimiser'; run: OptimisationRun; best: number | null};

export interface TuningItem {
  /** The card's key and its selection: the major version number. */
  major: number;
  label: string;
  version: PromptVersion | null;
  state: CardState;
  /** Macro-F1, when scored (the Optimiser's card: its best so far). */
  score: number | null;
  /** Change against the nearest lower version that has a score. */
  change: number | null;
}

/** Running, or waiting for the model: either way under way and can be stopped. */
export const busy = (r: {state: string; queue?: unknown}) => r.state === 'running' || !!r.queue;

/** An Optimiser run that still has a card: under way, or failed or paused and waiting for Retry. */
export const openRun = (r: OptimisationRun) => busy(r) || r.state === 'failed' || r.state === 'paused';

/** The project's one labeling model (MVP: one model per project). */
export const endpointOf = (s: ProjectState): EndpointId | undefined => s.setup?.models[0]?.endpoint;

/** A version's report on the project's model: the current one, else (scores out of date) its newest. */
export function reportOf(s: ProjectState, versionId: string): Report | undefined {
  const ep = endpointOf(s);
  return withNewestReports(s).reports.find(r => r.promptVersionId === versionId && r.endpoint === ep && !r.archivedNow);
}

function cardState(s: ProjectState, v: PromptVersion): CardState {
  const runs = s.runs.filter(r => r.promptVersionId === v.id && r.purpose !== 'optimiser');
  const live = runs.filter(busy);
  if (live.length) {
    if (live.every(r => r.queue)) return {kind: 'queued', runs: live, ahead: Math.min(...live.map(r => r.queue!.ahead))};
    return {kind: 'labeling', runs: live, done: live.reduce((n, r) => n + r.done, 0), total: live.reduce((n, r) => n + r.total, 0)};
  }
  const report = reportOf(s, v.id);
  if (report) return {kind: 'scored', report};
  const last = runs[0];
  if (!last) {
    // A version the Optimiser labeled has no labeling run of its own.
    const any = s.runs.find(r => r.promptVersionId === v.id && r.state === 'done');
    return any ? {kind: 'labeled', run: any} : {kind: 'new'};
  }
  if (last.state === 'failed') return {kind: 'failed', run: last};
  if (last.state === 'done') return {kind: 'labeled', run: last};
  return {kind: 'stopped', run: last};
}

/** Every card of the Versions row, before ordering. */
export function tuningItems(s: ProjectState): TuningItem[] {
  const items: TuningItem[] = shownVersions(s.versions, s.optimisation)
    .filter(x => x.version || (x.run && openRun(x.run)))
    .map(x => {
      if (x.run && openRun(x.run)) {
        const best = x.version ? (reportOf(s, x.version.id)?.metrics.macroF1 ?? null) : null;
        return {major: x.major, label: x.label, version: x.version, state: {kind: 'optimiser', run: x.run, best}, score: best, change: null};
      }
      const state = cardState(s, x.version!);
      return {major: x.major, label: x.label, version: x.version, state, score: state.kind === 'scored' ? state.report.metrics.macroF1 : null, change: null};
    });
  const scored = [...items].filter(i => i.score != null).sort((a, b) => a.major - b.major);
  for (let i = 1; i < scored.length; i++) scored[i].change = scored[i].score! - scored[i - 1].score!;
  return items;
}

export type SortBy = 'score' | 'newest';

/**
 * The row's order (round 12): the pinned card, then the running Optimiser, then versions with work
 * under way, then finished ones the person has not opened yet, then the chosen sort.
 */
export function orderItems(items: TuningItem[], sort: SortBy, pinned: number | null, unread: (i: TuningItem) => boolean): TuningItem[] {
  const rank = (i: TuningItem) =>
    i.major === pinned ? 0 : i.state.kind === 'optimiser' ? 1 : i.state.kind === 'labeling' || i.state.kind === 'queued' ? 2 : unread(i) ? 3 : 4;
  const bySort = (a: TuningItem, b: TuningItem) => (sort === 'score' ? (b.score ?? -1) - (a.score ?? -1) || b.major - a.major : b.major - a.major);
  return [...items].sort((a, b) => rank(a) - rank(b) || bySort(a, b));
}

/** The highest-scoring card (the Best tag). */
export const bestItem = (items: TuningItem[]) => items.filter(i => i.state.kind === 'scored').sort((a, b) => b.score! - a.score!)[0] ?? null;

/** Rewrites two-level labels in helper texts ("v2.1") to the number the page shows ("v2"). */
export const flatLabels = (text: string) => text.replace(/\bv(\d+)\.\d+\b/g, 'v$1');

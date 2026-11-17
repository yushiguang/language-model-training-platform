import type {EndpointId, Thresholds} from '@sprint/contracts';
import type {ProjectState} from '@/backend-api';

type Report = ProjectState['reports'][number];

export const reportFor = (s: ProjectState, versionId: string, ep: EndpointId): Report | undefined => s.reports.find(r => r.promptVersionId === versionId && r.endpoint === ep && !r.archivedNow);
export const runsFor = (s: ProjectState, versionId: string) => s.runs.filter(r => r.promptVersionId === versionId);
export const modelName = (s: ProjectState, ep: EndpointId) => s.endpoints.find(e => e.id === ep)?.name ?? ep;

/** A version's score in the list and chart: its best model's macro-F1; passed on any model. */
export function versionScore(s: ProjectState, versionId: string): {score: number; passed: boolean; rough: boolean} | null {
  const reps = s.setup!.models.map(m => reportFor(s, versionId, m.endpoint)).filter((r): r is Report => !!r);
  if (!reps.length) return null;
  return {score: Math.max(...reps.map(r => r.metrics.macroF1)), passed: reps.some(r => r.passed), rough: reps.every(r => r.rough)};
}

/**
 * One row per value of the label, weakest F1 first (2026-11-16: per value, not per field). A row
 * passes when it meets every value-level threshold that is on.
 */
export function valueRows(rep: Report, t: Thresholds) {
  return rep.metrics.values
    .map(v => {
      const passed = (t.valueF1 == null || v.f1 >= t.valueF1) && (t.precision == null || v.precision >= t.precision) && (t.recall == null || v.recall >= t.recall);
      return {value: v.value, f1: v.f1, precision: v.precision, recall: v.recall, support: v.support, passed};
    })
    .sort((a, b) => a.f1 - b.f1);
}

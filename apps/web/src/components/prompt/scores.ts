import type {EndpointId, Thresholds} from '@tsp/contracts';
import type {ProjectState} from '@/backend-api';

type Report = ProjectState['reports'][number];

export const reportFor = (s: ProjectState, versionId: string, ep: EndpointId): Report | undefined => s.reports.find(r => r.promptVersionId === versionId && r.endpoint === ep && !r.archivedNow);
export const runsFor = (s: ProjectState, versionId: string) => s.runs.filter(r => r.promptVersionId === versionId);
export const modelName = (s: ProjectState, ep: EndpointId) => s.endpoints.find(e => e.id === ep)?.name ?? ep;

/** A version's score in the list and chart: its best model's lowest field macro-F1; passed on any model. */
export function versionScore(s: ProjectState, versionId: string): {score: number; passed: boolean} | null {
  const reps = s.setup!.models.map(m => reportFor(s, versionId, m.endpoint)).filter((r): r is Report => !!r);
  if (!reps.length) return null;
  return {score: Math.max(...reps.map(r => r.metrics.lowestField.macroF1)), passed: reps.some(r => r.passed)};
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** One row per field, lowest F1 first: F1 is the field's macro-F1, precision and recall are macro averages. */
export function fieldRows(rep: Report, t: Thresholds) {
  return rep.metrics.fields
    .map(f => {
      const vals = f.values;
      const passed =
        f.macroF1 >= t.macroF1 &&
        (t.valueF1 == null || vals.every(v => v.f1 >= t.valueF1!)) &&
        (t.precision == null || vals.every(v => v.precision >= t.precision!)) &&
        (t.recall == null || vals.every(v => v.recall >= t.recall!));
      return {field: f.field, f1: f.macroF1, precision: mean(vals.map(v => v.precision)), recall: mean(vals.map(v => v.recall)), passed};
    })
    .sort((a, b) => a.f1 - b.f1);
}

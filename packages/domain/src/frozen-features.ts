import type {ExampleType, FeatureGroup, FeatureMissingness, FeatureSize, Features, ItemCheckCounts, ItemProblem, TypeFeatureMissingness} from '@yushiguang/sprint-contracts';
import {featureItems, featureText, isFeatureEmpty} from './template.ts';
import {FEATURES, isImageKey} from './catalogue.ts';

/**
 * Frozen features (#32): an example's features are fetched once when it is taken and kept in one
 * document per example, read by id only. Pure: the workflow stores what these decide.
 */

const TYPES: readonly ExampleType[] = ['video', 'photo_text'];
const keysForType = (type: ExampleType): string[] => [...FEATURES[type], ...FEATURES.metadata].map(d => d.key);

/** The id of an example's features document: its dataset and its item. */
export const featureDocId = (snapshotId: string, externalId: string): string => `${snapshotId}:${externalId}`;

/** No items left out yet. */
export const noChecks = (): ItemCheckCounts => ({missing: 0, minorCreator: 0, notRecommendable: 0});

/** Counts one left-out item. */
export function countProblem(c: ItemCheckCounts, problem: ItemProblem): void {
  if (problem === 'minor_creator') c.minorCreator++;
  else if (problem === 'not_recommendable') c.notRecommendable++;
  else c.missing++;
}

/** Two counts added up (an append adds to the dataset's). */
export const addChecks = (a: ItemCheckCounts | undefined, b: ItemCheckCounts): ItemCheckCounts => {
  const noFeatures = (a?.noFeatures ?? 0) + (b.noFeatures ?? 0);
  return {
    missing: (a?.missing ?? 0) + b.missing,
    minorCreator: (a?.minorCreator ?? 0) + b.minorCreator,
    notRecommendable: (a?.notRecommendable ?? 0) + b.notRecommendable,
    ...(noFeatures ? {noFeatures} : {}),
  };
};

export const checksTotal = (c: ItemCheckCounts | undefined): number => (c ? c.missing + c.minorCreator + c.notRecommendable + (c.noFeatures ?? 0) : 0);

/** Catalogue keys for `type` (+ metadata) whose value is empty on this example (#48). */
export function missingFeatureKeys(type: ExampleType, features: Features): string[] {
  return keysForType(type).filter(k => isFeatureEmpty(k, features[k]));
}

/** Exact integer feature-missingness counts across `examples` and zero-feature exclusions (#48). */
export function computeFeatureMissingness(
  examples: {type: ExampleType; features: Features}[],
  zeroExcludedByType: Partial<Record<ExampleType, number>> = {},
): FeatureMissingness {
  const byType: Partial<Record<ExampleType, TypeFeatureMissingness>> = {};
  for (const type of TYPES) {
    const of = examples.filter(e => e.type === type);
    if (!of.length) continue;
    const keys = keysForType(type);
    const missing: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0]));
    for (const {features} of of) {
      for (const k of keys) if (isFeatureEmpty(k, features[k])) missing[k]++;
    }
    byType[type] = {examples: of.length, missing};
  }
  const zeroFeatureExcluded: Partial<Record<ExampleType, number>> = {};
  for (const type of TYPES) {
    const n = zeroExcludedByType[type] ?? 0;
    if (n > 0) zeroFeatureExcluded[type] = n;
  }
  return {version: 1, byType, zeroFeatureExcluded};
}

/** Two `FeatureMissingness` summaries added together (append). */
export function mergeFeatureMissingness(a: FeatureMissingness | undefined, b: FeatureMissingness | undefined): FeatureMissingness {
  const byType: Partial<Record<ExampleType, TypeFeatureMissingness>> = {};
  const zeroFeatureExcluded: Partial<Record<ExampleType, number>> = {};
  for (const type of TYPES) {
    const ta = a?.byType[type];
    const tb = b?.byType[type];
    const examples = (ta?.examples ?? 0) + (tb?.examples ?? 0);
    if (examples > 0) {
      const keys = new Set([...Object.keys(ta?.missing ?? {}), ...Object.keys(tb?.missing ?? {})]);
      const missing: Record<string, number> = {};
      for (const k of keys) missing[k] = (ta?.missing[k] ?? 0) + (tb?.missing[k] ?? 0);
      byType[type] = {examples, missing};
    }
    const ex = (a?.zeroFeatureExcluded[type] ?? 0) + (b?.zeroFeatureExcluded[type] ?? 0);
    if (ex > 0) zeroFeatureExcluded[type] = ex;
  }
  return {version: 1, byType, zeroFeatureExcluded};
}

/** Removes `delta` from `a`, clamping counts to `[0, examples]` and dropping a type entry at 0 examples. */
export function subtractFeatureMissingness(a: FeatureMissingness | undefined, delta: FeatureMissingness | undefined): FeatureMissingness {
  const byType: Partial<Record<ExampleType, TypeFeatureMissingness>> = {};
  const zeroFeatureExcluded: Partial<Record<ExampleType, number>> = {};
  for (const type of TYPES) {
    const ta = a?.byType[type];
    const tb = delta?.byType[type];
    if (ta) {
      const examples = Math.max(0, ta.examples - (tb?.examples ?? 0));
      if (examples > 0) {
        const missing: Record<string, number> = {};
        for (const k of Object.keys(ta.missing)) missing[k] = Math.min(examples, Math.max(0, (ta.missing[k] ?? 0) - (tb?.missing[k] ?? 0)));
        byType[type] = {examples, missing};
      }
    }
    const ex = Math.max(0, (a?.zeroFeatureExcluded[type] ?? 0) - (delta?.zeroFeatureExcluded[type] ?? 0));
    if (ex > 0) zeroFeatureExcluded[type] = ex;
  }
  return {version: 1, byType, zeroFeatureExcluded};
}

/** Missing count, example total, and rate for one feature within `group` (`metadata` sums across types). */
export function featureMissingForGroup(
  stats: FeatureMissingness | undefined | null,
  group: FeatureGroup,
  key: string,
): {missing: number; total: number; rate: number} | null {
  if (!stats) return null;
  if (group === 'metadata') {
    let missing = 0;
    let total = 0;
    for (const type of TYPES) {
      const t = stats.byType[type];
      if (!t || t.examples <= 0 || t.missing[key] === undefined) continue;
      missing += t.missing[key];
      total += t.examples;
    }
    return total > 0 ? {missing, total, rate: missing / total} : null;
  }
  const t = stats.byType[group];
  if (!t || t.examples <= 0 || t.missing[key] === undefined) return null;
  const missing = t.missing[key];
  return {missing, total: t.examples, rate: missing / t.examples};
}

export interface FeatureMissingnessStat {
  key: string;
  missing: number;
  total: number;
  rate: number;
}

export interface TypeMissingnessSummary {
  examples: number;
  zeroExcluded: number;
  missingFeatures: FeatureMissingnessStat[];
  alwaysMissing: string[];
}

export interface MissingnessSummary {
  totalExamples: number;
  totalZeroExcluded: number;
  zeroFeatureExcluded: Partial<Record<ExampleType, number>>;
  byType: Partial<Record<ExampleType, TypeMissingnessSummary>>;
  metadataMissing: FeatureMissingnessStat[];
}

/** Readable summary of `FeatureMissingness` with rates computed on read (#48). */
export function summarizeMissingness(stats: FeatureMissingness | undefined | null): MissingnessSummary | null {
  if (!stats) return null;
  let totalExamples = 0;
  let totalZeroExcluded = 0;
  const zeroFeatureExcluded: Partial<Record<ExampleType, number>> = {};
  const byType: Partial<Record<ExampleType, TypeMissingnessSummary>> = {};
  for (const type of TYPES) {
    const ex = stats.zeroFeatureExcluded[type] ?? 0;
    if (ex > 0) {
      zeroFeatureExcluded[type] = ex;
      totalZeroExcluded += ex;
    }
    const t = stats.byType[type];
    if (!t || t.examples <= 0) continue;
    totalExamples += t.examples;
    const missingFeatures: FeatureMissingnessStat[] = Object.entries(t.missing)
      .filter(([, m]) => m > 0)
      .map(([key, missing]) => ({key, missing, total: t.examples, rate: missing / t.examples}))
      .sort((a, b) => b.missing - a.missing);
    const alwaysMissing = missingFeatures.filter(f => f.missing >= t.examples).map(f => f.key);
    byType[type] = {examples: t.examples, zeroExcluded: ex, missingFeatures, alwaysMissing};
  }
  const metadataMissing: FeatureMissingnessStat[] = FEATURES.metadata
    .map(def => {
      const s = featureMissingForGroup(stats, 'metadata', def.key);
      return s && s.missing > 0 ? {key: def.key, ...s} : null;
    })
    .filter((x): x is FeatureMissingnessStat => x !== null)
    .sort((a, b) => b.rate - a.rate || b.missing - a.missing);
  return {totalExamples, totalZeroExcluded, zeroFeatureExcluded, byType, metadataMissing};
}

/** Average feature sizes per kind of example (#32): video and photo-and-text items differ. */
export type FeatureSizes = Partial<Record<ExampleType, Record<string, FeatureSize>>>;

/**
 * The average size of each feature over `list`, per kind of example, averaged over the examples
 * of that kind only. An image feature (`isImageKey`) counts its images, a single URL as one; any
 * other feature counts the characters of its text, a list as its joined text.
 */
export function featureSizes(list: {type: ExampleType; features: Features}[]): FeatureSizes {
  const out: FeatureSizes = {};
  for (const type of ['video', 'photo_text'] as const) {
    const of = list.filter(e => e.type === type);
    if (!of.length) continue;
    const sum: Record<string, FeatureSize> = {};
    for (const {features} of of) {
      for (const [k, v] of Object.entries(features)) {
        const s = (sum[k] ??= {chars: 0, items: 0});
        if (isImageKey(k)) s.items += featureItems(v).length;
        else s.chars += featureText(v).length;
      }
    }
    out[type] = Object.fromEntries(Object.entries(sum).map(([k, s]) => [k, {chars: Math.round(s.chars / of.length), items: Math.round((s.items / of.length) * 10) / 10}]));
  }
  return out;
}

/** Sizes of `a` and `b` as one average per kind, each weighted by its examples of that kind. */
export function mergeFeatureSizes(a: FeatureSizes | undefined, na: Partial<Record<ExampleType, number>>, b: FeatureSizes, nb: Partial<Record<ExampleType, number>>): FeatureSizes {
  const out: FeatureSizes = {};
  for (const type of ['video', 'photo_text'] as const) {
    const x = a?.[type];
    const y = b[type];
    const m = x ? (na[type] ?? 0) : 0;
    const n = y ? (nb[type] ?? 0) : 0;
    if (!m && !n) {
      if (x || y) out[type] = (x ?? y)!;
      continue;
    }
    const keys = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
    out[type] = Object.fromEntries(
      [...keys].map(k => {
        const p = x?.[k] ?? {chars: 0, items: 0};
        const q = y?.[k] ?? {chars: 0, items: 0};
        return [k, {chars: Math.round((p.chars * m + q.chars * n) / (m + n)), items: Math.round(((p.items * m + q.items * n) / (m + n)) * 10) / 10}];
      }),
    );
  }
  return out;
}

/**
 * An example of average size for its kind, for estimates: each text feature holds as much text,
 * and each image feature as many images, as the dataset's examples of that kind do on average.
 */
export function averageExample(type: ExampleType, sizes: FeatureSizes | undefined): {type: ExampleType; features: Features} {
  const features: Features = {};
  for (const [k, s] of Object.entries(sizes?.[type] ?? {})) {
    if (isImageKey(k)) {
      const items = Math.round(s.items);
      if (items > 0) features[k] = {items: Array.from({length: items}, (_, i) => `https://example.invalid/${i}`)};
    } else if (s.chars > 0) features[k] = {text: 'x'.repeat(s.chars)};
  }
  return {type, features};
}

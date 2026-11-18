import type {ExampleType, FeatureSize, Features, ItemCheckCounts, ItemProblem} from '@yushiguang/sprint-contracts';
import {featureItems, featureText} from './template.ts';
import {isImageKey} from './catalogue.ts';

/**
 * Frozen features (#32): an example's features are fetched once when it is taken and kept in one
 * document per example, read by id only. Pure: the workflow stores what these decide.
 */

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
export const addChecks = (a: ItemCheckCounts | undefined, b: ItemCheckCounts): ItemCheckCounts => ({
  missing: (a?.missing ?? 0) + b.missing,
  minorCreator: (a?.minorCreator ?? 0) + b.minorCreator,
  notRecommendable: (a?.notRecommendable ?? 0) + b.notRecommendable,
});

export const checksTotal = (c: ItemCheckCounts | undefined): number => (c ? c.missing + c.minorCreator + c.notRecommendable : 0);

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

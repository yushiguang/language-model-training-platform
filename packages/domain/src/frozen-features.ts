import type {ExampleType, FeatureSize, Features, ItemCheckCounts, ItemProblem} from '@yushiguang/sprint-contracts';
import {featureItems, featureText} from './template.ts';

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

/** The average size of each feature over `list` (characters of text, list items). */
export function featureSizes(list: Features[]): Record<string, FeatureSize> {
  const sum: Record<string, FeatureSize> = {};
  for (const f of list) {
    for (const [k, v] of Object.entries(f)) {
      const s = (sum[k] ??= {chars: 0, items: 0});
      if (Array.isArray(v.items)) s.items += featureItems(v).length;
      else s.chars += featureText(v).length;
    }
  }
  const n = list.length || 1;
  return Object.fromEntries(Object.entries(sum).map(([k, s]) => [k, {chars: Math.round(s.chars / n), items: Math.round((s.items / n) * 10) / 10}]));
}

/** Sizes of `a` (over `na` examples) and `b` (over `nb`) as one average. */
export function mergeFeatureSizes(a: Record<string, FeatureSize> | undefined, na: number, b: Record<string, FeatureSize>, nb: number): Record<string, FeatureSize> {
  if (!a || !na) return b;
  const n = na + nb || 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries(
    [...keys].map(k => {
      const x = a[k] ?? {chars: 0, items: 0};
      const y = b[k] ?? {chars: 0, items: 0};
      return [k, {chars: Math.round((x.chars * na + y.chars * nb) / n), items: Math.round(((x.items * na + y.items * nb) / n) * 10) / 10}];
    }),
  );
}

/**
 * An example of average size, for estimates: each feature holds as much text, or as many list
 * items, as the dataset's examples do on average.
 */
export function averageExample(type: ExampleType, sizes: Record<string, FeatureSize> | undefined): {type: ExampleType; features: Features} {
  const features: Features = {};
  for (const [k, s] of Object.entries(sizes ?? {})) {
    const items = Math.round(s.items);
    features[k] = items > 0 ? {items: Array.from({length: items}, (_, i) => `https://example.invalid/${i}`)} : {text: 'x'.repeat(s.chars)};
  }
  return {type, features};
}

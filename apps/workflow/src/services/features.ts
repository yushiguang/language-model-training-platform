import type {Example, ExampleWithFeatures, Features} from '@yushiguang/sprint-contracts';
import {systemConfig} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';

/**
 * Frozen features (#32): project state carries examples without their features; whoever needs
 * them reads them here, by id, a batch at a time (`dataset.featureBatch`).
 */
export async function featuresOf(w: Scope, examples: Pick<Example, 'id' | 'snapshotId' | 'externalId'>[]): Promise<Map<string, Features>> {
  const batch = Math.max(1, systemConfig().dataset.featureBatch);
  const out = new Map<string, Features>();
  for (let i = 0; i < examples.length; i += batch) {
    for (const [id, f] of await w.catalog.exampleFeatures(examples.slice(i, i + batch))) out.set(id, f);
  }
  return out;
}

/**
 * The examples with their features. An example whose features are missing is left out
 * when `keepMissing` is false, or kept with none.
 */
export async function withFeatures<E extends Example>(w: Scope, examples: E[], keepMissing = false): Promise<(E & {features: Features})[]> {
  const features = await featuresOf(w, examples);
  const out: (E & {features: Features})[] = [];
  for (const e of examples) {
    const f = features.get(e.id);
    if (f) out.push({...e, features: f});
    else if (keepMissing) out.push({...e, features: {}});
  }
  return out;
}

/** At most this many examples' features in one call from a page or the Optimiser. */
const MAX_IDS = 200;

/**
 * Examples' features for the project's own examples only (an id from another project is left
 * out). An example whose features are missing maps to {}.
 */
export async function exampleFeatures(w: Scope, projectId: string, exampleIds: string[]): Promise<Record<string, Features>> {
  const ids = [...new Set(exampleIds)];
  if (ids.length > MAX_IDS) throw new Error(`Ask for at most ${MAX_IDS} examples at a time.`);
  if (!ids.length) return {};
  const examples = await w.catalog.findByIds('examples', ids);
  const snaps = new Map((await w.catalog.findByIds('dataset_snapshots', [...new Set(examples.map(e => e.snapshotId))])).map(s => [s.id, s]));
  const own = examples.filter(e => snaps.get(e.snapshotId)?.projectId === projectId);
  const features = await featuresOf(w, own);
  return Object.fromEntries(own.map(e => [e.id, features.get(e.id) ?? {}]));
}

/** Strips features kept on example records saved before #32: project state never carries them. */
export const indexOnly = <E extends Example>(e: E): E => {
  if (!('features' in e)) return e;
  const {features: _, ...rest} = e as E & {features?: unknown};
  return rest as E;
};

export type {ExampleWithFeatures};

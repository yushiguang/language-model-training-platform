import type {ExampleMedia, ExampleSource, MediaSource, RawExample} from '@yushiguang/sprint-contracts';
import {featureItems, toFeatures} from '@yushiguang/sprint-domain';

interface SampleFile {
  examples: RawExample[];
  labels: {externalId: string; answer: string | Record<string, string[]>}[];
}

let cache: Promise<SampleFile> | null = null;
/**
 * The prepared file. NEXT_PUBLIC_EXAMPLES_URL points at a file uploaded to the file store (the real
 * examples never go in the repo); without it the made-up sample in public/sample-data is used.
 */
const fileUrl = (base: string) => process.env.NEXT_PUBLIC_EXAMPLES_URL || `${base}/sample-data/examples.json`;
export const loadSampleFile = (base: string) =>
  (cache ??= fetch(fileUrl(base)).then(r => {
    if (!r.ok) throw new Error(`Could not load the examples file (${r.status}).`);
    // The file keeps the plain `string | string[]` shape; examples get `FeatureValue`s (spec 1.0.0, 7.1).
    return (r.json() as Promise<SampleFile>).then(f => ({...f, examples: f.examples.map(e => ({...e, features: toFeatures(e.features as unknown as Record<string, unknown>)}))}));
  }));

/**
 * Stand-in example service: the prepared file of examples with features. Its items are every
 * tenant's built-in "Sample data" source (#29), and features are looked up from it; see
 * docs/integration.md, "Examples".
 */
export function sampleExamples(base = ''): ExampleSource {
  return {
    async builtIn() {
      return {name: 'Sample data', ids: (await loadSampleFile(base)).examples.map(e => e.externalId)};
    },
    async lookup(ids) {
      const all = (await loadSampleFile(base)).examples;
      return ids.map(id => all.find(e => e.externalId === id)).filter((e): e is RawExample => !!e);
    },
    async bundledLabels() {
      return (await loadSampleFile(base)).labels;
    },
  };
}

/**
 * Stand-in media: the made-up pictures the sample file names in its Cover, Frame and Images
 * features. There is no video. The real media service replaces this (docs/integration.md).
 */
export function sampleMedia(base = ''): MediaSource {
  const url = (u: string) => (/^(https?:|data:|\/)/.test(u) ? u : `${base}/${u}`);
  return {
    async media(externalId) {
      const ex = (await loadSampleFile(base)).examples.find(e => e.externalId === externalId);
      if (!ex) return null;
      const imageUrls = [...featureItems(ex.features.Frame), ...featureItems(ex.features.Images)].map(url);
      const cover = featureItems(ex.features.Cover)[0];
      if (!cover && !imageUrls.length) return null;
      // The stand-in has no item page; its cover image opens in a new tab in its place.
      const page = cover ? url(cover) : imageUrls[0];
      const m: ExampleMedia = {kind: ex.type === 'video' ? 'video' : 'images', imageUrls, ...(cover ? {coverUrl: url(cover)} : {}), externalUrl: page};
      return m;
    },
  };
}

import type {ExampleMedia, ExampleSource, MediaSource, RawExample} from '@tsp/contracts';

interface SampleFile {
  examples: RawExample[];
  labels: {externalId: string; answer: Record<string, string[]>}[];
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
    return r.json() as Promise<SampleFile>;
  }));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('Stopped', 'AbortError'))));
  });

/**
 * Stand-in for automatic sampling: picks from the prepared file of examples with features.
 * For the MVP the real data is also a prepared file (50 to 100 examples) in the same format;
 * see docs/handover/integration.md, "Examples".
 */
export function sampleExamples(base = ''): ExampleSource {
  return {
    async available() {
      return (await loadSampleFile(base)).examples.length;
    },
    async sample(n, onProgress, signal) {
      const all = [...(await loadSampleFile(base)).examples];
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      const picked = all.slice(0, n);
      for (let i = 0; i < picked.length; i += 8) {
        await sleep(400, signal);
        onProgress?.(Math.min(picked.length, i + 8));
      }
      return picked;
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
 * features. There is no video. The real media service replaces this (docs/handover/integration.md).
 */
export function sampleMedia(base = ''): MediaSource {
  const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
  const url = (u: string) => (/^(https?:|data:|\/)/.test(u) ? u : `${base}/${u}`);
  return {
    async media(externalId) {
      const ex = (await loadSampleFile(base)).examples.find(e => e.externalId === externalId);
      if (!ex) return null;
      const imageUrls = [...list(ex.features.Frame), ...list(ex.features.Images)].map(url);
      const cover = list(ex.features.Cover)[0];
      if (!cover && !imageUrls.length) return null;
      const m: ExampleMedia = {kind: ex.type === 'video' ? 'video' : 'images', imageUrls, ...(cover ? {coverUrl: url(cover)} : {})};
      return m;
    },
  };
}

import type {ChatRequest, ChatResult, EndpointInfo, LabelingModels, LlmStreamChunk, ModelMessage} from '@sprint/contracts';
import {loadSampleFile} from './sample-examples.ts';

/**
 * Stand-in labeling models. They answer like a model would (JSON text), using the answers
 * bundled with the sample file and a made-up error rate that falls as the prompt gains rules,
 * so prompt versions move the scores. Nothing here is a real model.
 */
export const ENDPOINTS: EndpointInfo[] = [
  {id: 'A', name: 'gpt-5.6-terra', description: 'Higher quality', badge: 'Higher quality', cost: 'Higher', speed: 'Slower', supportsTemperature: false, priceIn: 1.25, priceOut: 5.0},
  {id: 'B', name: 'gpt-5.4', description: 'Faster', badge: 'Faster', cost: 'Lower', speed: 'Faster', supportsTemperature: false, priceIn: 0.75, priceOut: 3.0},
];

const SAMPLE_VALUES = ['Entertainment', 'Practical', 'Discussion', 'Ecosystem issue'];
const CONFUSE: Record<string, string> = {Entertainment: 'Discussion', Discussion: 'Entertainment', Practical: 'Entertainment', 'Ecosystem issue': 'Practical'};

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const textOf = (messages: ModelMessage[]) =>
  messages.map(m => (typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join(''))).join('\n');
const imageCount = (messages: ModelMessage[]) => messages.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter(p => p.type === 'image').length), 0);

const unescape = (x: string) => x.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The label's key, read from the <output_labels> tag or the output format line. */
function labelAsked(text: string): string | null {
  const tag = text.match(/<output_labels name="([^"]*)"/)?.[1];
  if (tag) return unescape(tag);
  for (const m of text.matchAll(/"([a-z_][a-z0-9_]*)"\s*:/g)) if (!['summary', 'reasoning', 'reason'].includes(m[1])) return m[1];
  return null;
}

/** The label's values, read from the <label value> tags (the sample's when there are none). */
function valuesFor(text: string): string[] {
  const sec = text.split('<output_labels')[1]?.split('</output_labels>')[0] ?? '';
  const found = [...sec.matchAll(/<label value="([^"]+)"/g)].map(m => unescape(m[1]));
  return found.length ? found : SAMPLE_VALUES;
}

async function answer(req: ChatRequest): Promise<ChatResult> {
  const text = textOf(req.messages);
  const truth0 = (await loadSampleFile('')).labels.find(l => l.externalId === req.traceId)?.answer;
  const rules = text.split('\n').filter(l => /\b(before|unless|never|only|check|if|always|prefer|when|not)\b/i.test(l)).length;
  const base = req.endpoint === 'A' ? 0.72 : 0.66;
  // The first few added rules help a little (a draft, Improve with AI); later ones (Optimiser rounds)
  // help more, so a run that keeps changes can reach the pass rule instead of tying round after round.
  const added = Math.max(0, rules - 2);
  const q = Math.min(0.985, base + 0.035 * Math.min(added, 3) + 0.07 * Math.max(0, added - 3) + (text.includes('Return one JSON object only') ? 0.02 : 0));
  // The draws depend on the example, not on the prompt's text: a prompt with more rules only turns
  // wrong answers right, so the stand-in Optimiser's progress is not lost to a reshuffle.
  const r = rng(`${req.endpoint}|${req.traceId}|${req.temperature ?? 0}`);
  const out: Record<string, unknown> = text.includes('"reason" key') ? {reason: 'Based on the description and what is shown.'} : {summary: 'A short post.', reasoning: 'Based on the description and what is shown.'};
  const key = labelAsked(text);
  if (key) {
    const values = valuesFor(text);
    const tag = text.match(/<output_labels [^>]*>/)?.[0] ?? '';
    const multi = /selection="multi"/.test(tag);
    const truth = (Array.isArray(truth0) ? truth0 : typeof truth0 === 'string' ? [truth0] : []).filter(v => values.includes(v));
    const gold = truth[0] ?? values[Math.floor(r() * values.length)];
    const p = Math.max(0.3, q);
    const other = values.filter(v => v !== gold);
    const pick = r() < p || !other.length ? gold : CONFUSE[gold] && values.includes(CONFUSE[gold]) ? CONFUSE[gold] : other[Math.floor(r() * other.length)];
    if (!multi) out[key] = pick;
    else {
      // A multi-select answer: the picked value, sometimes with a second one, within max.
      const max = Number(tag.match(/max="(\d+)"/)?.[1] ?? values.length);
      const second = other.filter(v => v !== pick)[Math.floor(r() * Math.max(1, other.length - 1))];
      out[key] = max > 1 && second && r() > p ? [pick, second] : [pick];
    }
  }
  // A broken reply is not tied to the example: a version that reads differently draws it afresh, so
  // the same few examples are not invalid in every version (which no prompt could fix).
  const broken = rng(`${req.endpoint}|${req.traceId}|${text.length}`)() < 0.006;
  const json = broken ? JSON.stringify(out).slice(0, -8) : JSON.stringify(out);
  const inputTokens = Math.round(text.length / 4) + imageCount(req.messages) * 258;
  return {text: json, inputTokens, outputTokens: Math.round(json.length / 4)};
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('Stopped', 'AbortError'))));
  });

/**
 * Answer time per call, about what a large model takes for a short labeling answer, so progress,
 * parallel calls and resume can be seen. With 4 calls at once, 100 examples take about 30 s on A.
 */
const LATENCY_MS = {A: 1100, B: 650};

export function simulatedModels(latency: {A: number; B: number} = LATENCY_MS): LabelingModels {
  return {
    endpoints: () => ENDPOINTS,
    async chat(req) {
      const base = req.endpoint === 'A' ? latency.A : latency.B;
      await sleep(base * (0.7 + Math.random() * 0.6), req.signal);
      return answer(req);
    },
    async *chatStream(req): AsyncGenerator<LlmStreamChunk> {
      const res = await this.chat(req);
      yield {type: 'delta', text: res.text};
      yield {type: 'done', createdAt: new Date().toISOString()};
    },
  };
}

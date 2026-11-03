import type {BatchJobs, BatchResult, ChatRequest, ChatResult, EndpointInfo, LabelingModels, ModelMessage} from '../interfaces';
import {loadSampleFile} from './sample-examples';

/**
 * Stand-in labeling models. They answer like a model would (JSON text), using the answers
 * bundled with the sample file and a made-up error rate that falls as the prompt gains rules,
 * so prompt versions move the scores. Nothing here is a real model.
 */
export const ENDPOINTS: EndpointInfo[] = [
  {id: 'A', name: '[Model name for endpoint A]', description: 'Higher quality', badge: 'Higher quality', cost: 'Higher', speed: 'Slower', supportsTemperature: true, priceIn: 1.2, priceOut: 4.8},
  {id: 'B', name: '[Model name for endpoint B]', description: 'Cheaper', badge: 'Cheaper', cost: 'Lower', speed: 'Faster', supportsTemperature: false, priceIn: 0.7, priceOut: 2.8},
];

const SCHEMA_VALUES: Record<string, string[]> = {
  primary_value: ['Entertainment', 'Practical', 'Discussion', 'Ecosystem issue'],
  format: ['Vlog', 'Tutorial', 'Review', 'Skit', 'Clip', 'Other'],
  topics: ['Food & drink', 'Travel', 'Home & renting', 'Work & money', 'Tech', 'Health & fitness', 'Beauty & fashion', 'Pets & animals', 'Games', 'News & society'],
};
const CONFUSE: Record<string, string> = {Entertainment: 'Discussion', Discussion: 'Entertainment', Practical: 'Entertainment', 'Ecosystem issue': 'Practical', Vlog: 'Review', Clip: 'Vlog', Review: 'Tutorial', Tutorial: 'Review', Skit: 'Clip', Other: 'Vlog'};
const DIFFICULTY: Record<string, number> = {primary_value: 0, format: 0.02, topics: 0.07};

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

/** Field names the prompt asks for, read from the output line or field headings. */
function fieldsAsked(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/###\s*\d+\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/"([a-z_][a-z0-9_]*)"\s*:/g)) if (!['summary', 'reasoning'].includes(m[1])) names.add(m[1]);
  return [...names];
}

function valuesFor(text: string, field: string): string[] {
  if (SCHEMA_VALUES[field]) return SCHEMA_VALUES[field];
  const sec = text.split(new RegExp(`###\\s*\\d+\\.\\s*${field}`))[1]?.split('###')[0] ?? '';
  return [...sec.matchAll(/^\s*-\s*([^:\n]+):/gm)].map(m => m[1].trim());
}

async function answer(req: ChatRequest): Promise<ChatResult> {
  const text = textOf(req.messages);
  const truth = (await loadSampleFile('')).labels.find(l => l.externalId === req.traceId)?.answer ?? {};
  const rules = text.split('\n').filter(l => /\b(before|unless|never|only|check|if|always|prefer|when|not)\b/i.test(l)).length;
  const base = req.endpoint === 'A' ? 0.72 : 0.66;
  const q = Math.min(0.985, base + 0.035 * Math.max(0, rules - 2) + (text.includes('Return JSON only') ? 0.02 : 0));
  const r = rng(`${req.endpoint}|${req.traceId}|${text.length}|${rules}|${req.temperature ?? 0}`);
  const out: Record<string, unknown> = {summary: 'A short post.', reasoning: 'Based on the description and what is shown.'};
  for (const field of fieldsAsked(text)) {
    const values = valuesFor(text, field);
    const gold = truth[field] ?? [values[Math.floor(r() * values.length)]];
    const p = Math.max(0.3, q - (DIFFICULTY[field] ?? 0.03));
    if (field === 'topics' || gold.length > 1) {
      const set = new Set(gold);
      if (r() > p) set.add(values[Math.floor(r() * values.length)]);
      if (r() > p + 0.05 && set.size > 1) set.delete([...set][0]);
      out[field] = [...set].slice(0, 3);
    } else {
      out[field] = r() < p ? gold[0] : (CONFUSE[gold[0]] ?? values[Math.floor(r() * values.length)]);
    }
  }
  const json = r() < 0.006 ? JSON.stringify(out).slice(0, -8) : JSON.stringify(out);
  const inputTokens = Math.round(text.length / 4) + imageCount(req.messages) * 258;
  return {text: json, inputTokens, outputTokens: Math.round(json.length / 4)};
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('Stopped', 'AbortError'))));
  });

export function simulatedModels(): LabelingModels {
  return {
    endpoints: () => ENDPOINTS,
    async chat(req) {
      await sleep(req.endpoint === 'A' ? 90 : 50, req.signal);
      return answer(req);
    },
  };
}

interface StoredJob {
  endpoint: 'A' | 'B';
  ids: string[];
  startedAt: number;
  cancelled?: boolean;
  maxOutputTokens: number;
  temperature: number | null;
  messages: Record<string, ModelMessage[]>;
}

/** Stand-in batch jobs: progress is computed from the time since submit, so it survives a reload. */
export function simulatedBatch(msPerRequest = 150): BatchJobs {
  const key = (id: string) => `batch-job:${id}`;
  const load = (id: string): StoredJob => JSON.parse(localStorage.getItem(key(id)) ?? 'null');
  return {
    async submit(input) {
      const jobId = `job_${Date.now().toString(36)}`;
      const job: StoredJob = {
        endpoint: input.endpoint,
        ids: input.requests.map(r => r.id),
        startedAt: Date.now(),
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
        messages: Object.fromEntries(input.requests.map(r => [r.id, r.messages])),
      };
      localStorage.setItem(key(jobId), JSON.stringify(job));
      return {jobId};
    },
    async status(jobId) {
      const job = load(jobId);
      if (!job) return {state: 'failed', done: 0, total: 0, error: 'Job not found'};
      const done = Math.min(job.ids.length, Math.floor((Date.now() - job.startedAt) / msPerRequest));
      if (job.cancelled) return {state: 'cancelled', done, total: job.ids.length};
      return {state: done >= job.ids.length ? 'done' : 'running', done, total: job.ids.length};
    },
    async results(jobId) {
      const job = load(jobId);
      const done = Math.min(job.ids.length, Math.floor((Date.now() - job.startedAt) / msPerRequest));
      const out: BatchResult[] = [];
      for (const id of job.ids.slice(0, done)) {
        const result = await answer({endpoint: job.endpoint, messages: job.messages[id], maxOutputTokens: job.maxOutputTokens, temperature: job.temperature, traceId: id});
        out.push({id, ok: true, result});
      }
      return out;
    },
    async cancel(jobId) {
      const job = load(jobId);
      if (job) localStorage.setItem(key(jobId), JSON.stringify({...job, cancelled: true}));
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {AVAILABLE_LLM_MODELS, LlmCallError, type ChatRequest, type ChatResult, type EndpointInfo, type Platform} from '@tsp/contracts';
import {createGateway} from './gateway.ts';
import {EndpointLimiter} from './limiter.ts';
import {buildRegistry} from './registry.ts';

const INFOS: EndpointInfo[] = [
  {id: 'A', name: 'gpt-5.6-terra', description: '', badge: '', cost: 'Higher', speed: 'Slower', supportsTemperature: false, priceIn: 1, priceOut: 4},
  {id: 'B', name: 'gpt-5.4', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: false, priceIn: 0.5, priceOut: 2},
];

function fakePlatform(chat: (req: ChatRequest) => Promise<ChatResult>, endpoints?: Platform['endpoints']): Pick<Platform, 'models' | 'agent' | 'endpoints'> {
  return {
    models: {endpoints: () => INFOS, chat, chatStream: async function* () {}},
    agent: {
      models: () => AVAILABLE_LLM_MODELS,
      chat: async () => 'ok',
      complete: async (_m, o) => ({text: `answered by ${o?.model}`, model: String(o?.model), usage: {inputTokens: 10, outputTokens: 5}}),
      chatStream: async function* () {},
    },
    endpoints,
  };
}

const msg = [{role: 'user' as const, content: 'hello'}];
const noWait = async () => {};

test('registry: assumed defaults per model, registered endpoints win', () => {
  const reg = buildRegistry(
    fakePlatform(async () => ({text: '', inputTokens: 0, outputTokens: 0}), [
      {id: 'tenant-ep-1', purpose: 'labeling', slot: 'A', model: 'gpt-5.6-terra', tier: 'reasoning', qpm: 10, tpm: 1000, maxConcurrency: 2, priceIn: 1, priceOut: 4, supportsTemperature: false, active: true, assumed: false},
    ]),
  );
  const a = reg.find(e => e.purpose === 'labeling' && e.slot === 'A')!;
  const b = reg.find(e => e.purpose === 'labeling' && e.slot === 'B')!;
  assert.equal(a.id, 'tenant-ep-1');
  assert.equal(a.assumed, false);
  assert.deepEqual([b.model, b.qpm, b.tpm, b.assumed], ['gpt-5.4', 240, 800_000, true]);
  const inactive = reg.find(e => e.purpose === 'chat' && e.model === 'gpt-5.5')!;
  assert.equal(inactive.active, false);
});

test('label retries busy and broken replies, then succeeds', async () => {
  let calls = 0;
  const gw = createGateway(
    fakePlatform(async () => {
      calls++;
      if (calls === 1) throw new LlmCallError('rate_limited', 'slow down', {status: 429, retryAfterMs: 5});
      if (calls === 2) throw new Error('socket hang up');
      return {text: '{"a":1}', inputTokens: 1000, outputTokens: 100};
    }),
    {sleep: noWait},
  );
  const r = await gw.label({slot: 'B', messages: msg, maxOutputTokens: 100, temperature: null});
  assert.equal(r.attempts, 3);
  assert.equal(r.text, '{"a":1}');
  assert.ok(Math.abs(r.costUsd - (1000 * 0.5 + 100 * 2) / 1e6) < 1e-12);
});

test('label does not retry a rejected request and gives up after 5 tries', async () => {
  let calls = 0;
  const rejected = createGateway(
    fakePlatform(async () => {
      calls++;
      throw Object.assign(new Error('bad request'), {status: 400});
    }),
    {sleep: noWait},
  );
  await assert.rejects(rejected.label({slot: 'A', messages: msg, maxOutputTokens: 10, temperature: null}), (e: LlmCallError) => e.kind === 'rejected');
  assert.equal(calls, 1);

  calls = 0;
  const broken = createGateway(
    fakePlatform(async () => {
      calls++;
      throw new Error('server error');
    }),
    {sleep: noWait},
  );
  await assert.rejects(broken.label({slot: 'A', messages: msg, maxOutputTokens: 10, temperature: null}), /after 5 tries/);
  assert.equal(calls, 5);
});

test('chat routes to the chat endpoint of the requested model, inactive models fall back', async () => {
  const gw = createGateway(fakePlatform(async () => ({text: '', inputTokens: 0, outputTokens: 0})), {sleep: noWait});
  assert.equal(await gw.agentModel().chat(msg, {model: 'gpt-5.4'}), 'answered by gpt-5.4');
  assert.equal(await gw.agentModel().chat(msg, {model: 'gpt-5.5'}), 'answered by gpt-5.6-terra');
});

test('limiter never exceeds QPM in a window and caps calls in flight', async () => {
  const lim = new EndpointLimiter({qpm: 3, tpm: 1_000_000, maxConcurrency: 2, windowMs: 120});
  const started: number[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({length: 6}, async () => {
      const p = await lim.acquire(10);
      started.push(Date.now() - t0);
      assert.ok(lim.stats().inFlight <= 2);
      await new Promise(r => setTimeout(r, 5));
      p.release(10);
    }),
  );
  started.sort((a, b) => a - b);
  // The 4th call can only start after the first window has passed.
  assert.ok(started[3] >= 110, `4th call started at ${started[3]}ms`);
});

test('limiter holds calls that would exceed TPM until the window frees', async () => {
  const lim = new EndpointLimiter({qpm: 100, tpm: 1000, maxConcurrency: 10, windowMs: 100});
  const t0 = Date.now();
  const a = await lim.acquire(800);
  a.release(800);
  const b = await lim.acquire(800);
  b.release();
  assert.ok(Date.now() - t0 >= 90);
});

test('limiter halves concurrency after a 429 and holds new calls', async () => {
  const lim = new EndpointLimiter({qpm: 100, tpm: 1_000_000, maxConcurrency: 8, windowMs: 1000});
  lim.onRateLimited(60);
  assert.equal(lim.stats().concurrency, 4);
  const t0 = Date.now();
  (await lim.acquire(1)).release();
  assert.ok(Date.now() - t0 >= 50);
});

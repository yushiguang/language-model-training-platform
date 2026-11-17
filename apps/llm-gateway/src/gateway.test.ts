import assert from 'node:assert/strict';
import test from 'node:test';
import {LlmCallError, NO_TELEMETRY, type ChatRequest, type ChatResult, type EndpointInfo, type Platform} from '@sprint/contracts';
import {memoryLimiterStore, STAND_IN_MODELS} from '@sprint/platform';
import {createGateway} from './gateway.ts';
import {EndpointLimiter} from './limiter.ts';
import {buildRegistry} from './registry.ts';

const INFOS: EndpointInfo[] = [
  {id: 'A', name: 'gpt-5.6-terra', description: '', badge: '', cost: 'Higher', speed: 'Slower', supportsTemperature: false, priceIn: 1, priceOut: 4},
  {id: 'B', name: 'gpt-5.4', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: false, priceIn: 0.5, priceOut: 2},
];

/** A limiter on its own store, as one process has it; waiters ask again every 5 ms. */
const oneStore = () => ({store: memoryLimiterStore(), key: 'ep', pollMs: 5});

function fakePlatform(chat: (req: ChatRequest) => Promise<ChatResult>, endpoints?: Platform['endpoints']): Pick<Platform, 'models' | 'agent' | 'endpoints' | 'limiterStore'> {
  return {
    limiterStore: memoryLimiterStore(),
    models: {endpoints: () => INFOS, chat, chatStream: async function* () {}},
    agent: {
      models: () => STAND_IN_MODELS,
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
  const lim = new EndpointLimiter({...oneStore(), qpm: 3, tpm: 1_000_000, maxConcurrency: 2, windowMs: 120});
  const started: number[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({length: 6}, async () => {
      const p = await lim.acquire(10);
      started.push(Date.now() - t0);
      assert.ok((await lim.stats()).inFlight <= 2);
      await new Promise(r => setTimeout(r, 5));
      p.release(10);
    }),
  );
  started.sort((a, b) => a - b);
  // The 4th call can only start after the first window has passed.
  assert.ok(started[3] >= 110, `4th call started at ${started[3]}ms`);
});

test('limiter holds calls that would exceed TPM until the window frees', async () => {
  const lim = new EndpointLimiter({...oneStore(), qpm: 100, tpm: 1000, maxConcurrency: 10, windowMs: 100});
  const t0 = Date.now();
  const a = await lim.acquire(800);
  a.release(800);
  const b = await lim.acquire(800);
  b.release();
  assert.ok(Date.now() - t0 >= 90);
});

test('limiter halves concurrency after a 429 and holds new calls', async () => {
  const lim = new EndpointLimiter({...oneStore(), qpm: 100, tpm: 1_000_000, maxConcurrency: 8, windowMs: 1000});
  await lim.onRateLimited(60);
  assert.equal((await lim.stats()).concurrency, 4);
  const t0 = Date.now();
  (await lim.acquire(1)).release();
  assert.ok(Date.now() - t0 >= 50);
});

test('after a 429 no queued call goes out during the hold, and a 429 on the last try still slows the endpoint', async () => {
  const sent: number[] = [];
  let calls = 0;
  const t0 = Date.now();
  const gw = createGateway(
    fakePlatform(
      async () => {
        calls++;
        sent.push(Date.now() - t0);
        if (calls === 1) {
          await new Promise(r => setTimeout(r, 5));
          throw new LlmCallError('rate_limited', 'slow down', {status: 429, retryAfterMs: 80});
        }
        return {text: '{}', inputTokens: 1, outputTokens: 1};
      },
      [{id: 'ep-a', purpose: 'labeling', slot: 'A', model: 'gpt-5.6-terra', tier: 'reasoning', qpm: 100, tpm: 1_000_000, maxConcurrency: 1, priceIn: 1, priceOut: 4, supportsTemperature: false, active: true, assumed: false}],
    ),
    {retryDelaysMs: [0]},
  );
  const req = {slot: 'A' as const, messages: msg, maxOutputTokens: 10, temperature: null};
  await Promise.all([gw.label(req), gw.label(req)]);
  // Call 1 (the 429) went out at once; nothing else before its 80 ms hold ended.
  assert.ok(sent.slice(1).every(t => t >= 80), `sent at ${sent.join(', ')} ms`);

  const last = createGateway(
    fakePlatform(async () => {
      throw new LlmCallError('rate_limited', 'slow down', {status: 429, retryAfterMs: 60});
    }),
    {retryDelaysMs: [], sleep: noWait},
  );
  await assert.rejects(last.label({...req, slot: 'B'}), /after 1 tries/);
  const t1 = Date.now();
  await assert.rejects(last.label({...req, slot: 'B'}));
  assert.ok(Date.now() - t1 >= 50, 'the next call waited for the hold');
});

test('limiter: a shorter wakeup replaces a pending later timer', async () => {
  const lim = new EndpointLimiter({...oneStore(), qpm: 100, tpm: 100, maxConcurrency: 4, windowMs: 1000});
  const a = await lim.acquire(60);
  const t0 = Date.now();
  // b does not fit (60 + 60 > 100): the limiter wakes when a's window entry expires, in 1 s.
  const b = lim.acquire(60);
  lim.onRateLimited(30);
  a.release(5); // the real usage was small: b fits once the 30 ms hold ends
  (await b).release();
  assert.ok(Date.now() - t0 < 500, `b waited ${Date.now() - t0} ms`);
});

test('limiter: aborting a queued call lets the one behind it go', async () => {
  const lim = new EndpointLimiter({...oneStore(), qpm: 100, tpm: 100, maxConcurrency: 4, windowMs: 1000});
  const a = await lim.acquire(60);
  const ctrl = new AbortController();
  const big = lim.acquire(60, ctrl.signal);
  const t0 = Date.now();
  const small = lim.acquire(10);
  ctrl.abort();
  await assert.rejects(big);
  (await small).release();
  assert.ok(Date.now() - t0 < 500, `small waited ${Date.now() - t0} ms`);
  a.release();
});

test('chatStream retries a 429 before the first chunk and slows the endpoint down', async () => {
  let tries = 0;
  const p = fakePlatform(async () => ({text: '', inputTokens: 0, outputTokens: 0}));
  p.agent.chatStream = async function* () {
    tries++;
    if (tries === 1) throw new LlmCallError('rate_limited', 'slow down', {status: 429, retryAfterMs: 5});
    yield {type: 'delta' as const, text: 'hi'};
    yield {type: 'done' as const, createdAt: ''};
  };
  const gw = createGateway(p, {sleep: noWait});
  const out: string[] = [];
  for await (const c of gw.agentModel().chatStream(msg)) if (c.type === 'delta') out.push(c.text);
  assert.deepEqual(out, ['hi']);
  assert.equal(tries, 2);
});

test('cancel(requestId) stops every call under that id, before or after it starts; other ids go on (spec 4.1)', async () => {
  // A model call that ends only when its signal (kept inside the gateway) is aborted.
  const gw = createGateway(
    fakePlatform(
      req =>
        new Promise((resolve, reject) => {
          if (req.traceId === 'other') return resolve({text: 'ok', inputTokens: 1, outputTokens: 1});
          req.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {once: true});
        }),
    ),
    {sleep: noWait},
  );
  const req = {slot: 'B' as const, messages: msg, maxOutputTokens: 10, temperature: null, requestId: 'run_1'};
  const a = gw.label(req);
  const b = gw.label(req);
  const other = gw.label({...req, requestId: 'run_2', traceId: 'other'});
  await new Promise(r => setTimeout(r, 5));
  await gw.cancel('run_1');
  await assert.rejects(a, (e: Error) => e.name === 'AbortError');
  await assert.rejects(b, (e: Error) => e.name === 'AbortError');
  assert.equal((await other).text, 'ok');
  // A call that starts after its id was cancelled is stopped at once.
  await assert.rejects(gw.label(req), (e: Error) => e.name === 'AbortError');
});

test('model registry (spec 5): opaque ids; no model, an unknown or an inactive one falls back to an active reasoning model', async () => {
  const p = fakePlatform(async req => ({text: `labeled on ${req.endpoint}`, inputTokens: 1, outputTokens: 1}));
  const registry = [
    {...STAND_IN_MODELS[2], id: 'm-fast-01', name: 'Fast'},
    {...STAND_IN_MODELS[0], id: 'm-think-07', name: 'Thinker'},
    {...STAND_IN_MODELS[1], id: 'm-off', name: 'Off', active: false},
  ];
  p.agent.models = () => registry;
  // A labeling endpoint whose id is the registry's own, not a fixed slot letter.
  p.models.endpoints = () => [{...INFOS[0], id: 'labeling-main'}];
  const allowed: Record<string, readonly string[]> = {};
  const telemetry = {...NO_TELEMETRY, allowLabelValues: (l: string, v: readonly string[]) => void (allowed[l] = v)};
  const gw = createGateway(p, {sleep: noWait, telemetry});
  const agent = gw.agentModel();
  assert.equal((await agent.complete(msg, {model: 'm-fast-01'})).text, 'answered by m-fast-01');
  assert.equal((await agent.complete(msg)).text, 'answered by m-think-07');
  assert.equal((await agent.complete(msg, {model: 'm-off'})).text, 'answered by m-think-07');
  assert.equal((await agent.complete(msg, {model: 'no-such-model'})).text, 'answered by m-think-07');
  assert.equal((await gw.label({slot: 'labeling-main', messages: msg, maxOutputTokens: 10, temperature: null})).text, 'labeled on labeling-main');
  assert.deepEqual(allowed.slot, ['labeling-main']);
  assert.ok(allowed.model.includes('m-think-07'));
});

test('request fields (spec 5): reasoning tokens count toward cost and TPM; a try past its timeout is retried as timed out', async () => {
  const seen: ChatRequest[] = [];
  let tries = 0;
  const gw = createGateway(
    fakePlatform(async req => {
      seen.push(req);
      tries++;
      // The first try never answers and ignores its signal: the gateway stops waiting anyway.
      if (tries === 1) return new Promise<ChatResult>(() => {});
      return {text: 'ok', inputTokens: 100, outputTokens: 50, reasoningTokens: 200};
    }),
    {sleep: noWait},
  );
  const r = await gw.label({slot: 'B', messages: msg, maxOutputTokens: 10, temperature: null, reasoningEffort: 'low', responseFormat: {type: 'json_object'}, timeoutMs: 20});
  assert.equal(r.attempts, 2);
  assert.equal(r.reasoningTokens, 200);
  // Endpoint B: $0.5 in, $2 out per million; reasoning at the output price.
  assert.ok(Math.abs(r.costUsd - (100 * 0.5 + 250 * 2) / 1e6) < 1e-12);
  assert.equal(seen[1].reasoningEffort, 'low');
  assert.deepEqual(seen[1].responseFormat, {type: 'json_object'});
  assert.equal(seen[1].timeoutMs, 20);
});

test('request fields (spec 5): a reasoning effort the model does not list is dropped; native tools on a model without them are refused', async () => {
  const asked: Parameters<Platform['agent']['complete']>[1][] = [];
  const p = fakePlatform(async () => ({text: '', inputTokens: 0, outputTokens: 0}));
  p.agent.models = () => [
    {...STAND_IN_MODELS[0], id: 'thinker', capabilities: {...STAND_IN_MODELS[0].capabilities, reasoningEffort: ['high'], tools: true}},
    {...STAND_IN_MODELS[2], id: 'plain', tier: 'fast', capabilities: {...STAND_IN_MODELS[2].capabilities, reasoningEffort: [], tools: false}},
  ];
  p.agent.complete = async (_m, o) => {
    asked.push(o);
    return {text: 'done', model: String(o?.model), usage: {inputTokens: 1, outputTokens: 1, reasoningTokens: 3}, toolCalls: o?.tools ? [{id: 'c1', name: o.tools[0].name, arguments: '{}'}] : undefined};
  };
  const agent = createGateway(p, {sleep: noWait}).agentModel();
  await agent.complete(msg, {model: 'thinker', reasoningEffort: 'high'});
  await agent.complete(msg, {model: 'plain', reasoningEffort: 'high'});
  assert.equal(asked[0]?.reasoningEffort, 'high');
  assert.equal(asked[1]?.reasoningEffort, undefined);
  const tool = {name: 'get_report', description: 'a report', parameters: {type: 'object', properties: {}}};
  const withTools = await agent.complete(msg, {model: 'thinker', tools: [tool]});
  assert.deepEqual(withTools.toolCalls, [{id: 'c1', name: 'get_report', arguments: '{}'}]);
  await assert.rejects(agent.complete(msg, {model: 'plain', tools: [tool]}), (e: Error) => e instanceof LlmCallError && e.kind === 'rejected');
});

// The shared store (spec 5): several limiters, as several processes would have them, on one store.
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));
const onShared = (store: ReturnType<typeof memoryLimiterStore>, o: {qpm: number; tpm: number; maxConcurrency: number; windowMs: number; leaseMs?: number}) => new EndpointLimiter({store, key: 'labeling-A', pollMs: 3, ...o});

test('shared store: three instances together never exceed the endpoint QPM or calls in flight', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 5, tpm: 1_000_000, maxConcurrency: 3, windowMs: 150};
  const instances = [onShared(store, limits), onShared(store, limits), onShared(store, limits)];
  let running = 0;
  let most = 0;
  const t0 = Date.now();
  await Promise.all(
    instances.flatMap(lim =>
      Array.from({length: 5}, async () => {
        const p = await lim.acquire(100);
        running++;
        most = Math.max(most, running);
        const st = await lim.stats();
        assert.ok(st.requestsInWindow <= 5, `${st.requestsInWindow} requests in one window`);
        assert.ok(st.inFlight <= 3, `${st.inFlight} in flight`);
        await sleepMs(10);
        running--;
        p.release(100);
      }),
    ),
  );
  assert.ok(most <= 3, `${most} calls ran at once`);
  // 15 calls at 5 a window: the last ones waited for two windows to pass.
  assert.ok(Date.now() - t0 >= 280, `all done after ${Date.now() - t0} ms`);
});

test('shared store: three instances together never exceed the endpoint TPM', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 1000, tpm: 300, maxConcurrency: 10, windowMs: 120};
  const instances = [onShared(store, limits), onShared(store, limits), onShared(store, limits)];
  await Promise.all(
    instances.flatMap(lim =>
      Array.from({length: 3}, async () => {
        const p = await lim.acquire(100);
        const st = await lim.stats();
        assert.ok(st.tokensInWindow <= 300, `${st.tokensInWindow} tokens in one window`);
        p.release(100);
      }),
    ),
  );
});

test('shared store: a busy reply seen by one instance holds the calls of every instance', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 100, tpm: 1_000_000, maxConcurrency: 4, windowMs: 1000};
  const [a, b] = [onShared(store, limits), onShared(store, limits)];
  await a.onRateLimited(60);
  assert.equal((await b.stats()).concurrency, 2);
  const t0 = Date.now();
  (await b.acquire(1)).release();
  assert.ok(Date.now() - t0 >= 50, `b went after ${Date.now() - t0} ms`);
});

test('shared store: a dead instance frees its slot when the lease ends, and its waiting ticket expires', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 100, tpm: 1_000_000, maxConcurrency: 1, windowMs: 1000};
  // A process takes the only slot and dies; another of its calls was first in the queue.
  const now = Date.now();
  assert.ok((await store.tryAcquire('labeling-A', {ticket: 'gone_1', tokens: 1, limits, leaseMs: 60, ticketTtlMs: 40, now})).granted);
  assert.equal((await store.tryAcquire('labeling-A', {ticket: 'gone_2', tokens: 1, limits, leaseMs: 60, ticketTtlMs: 40, now})).granted, false);
  const t0 = Date.now();
  (await onShared(store, limits).acquire(1)).release();
  const waited = Date.now() - t0;
  assert.ok(waited >= 45 && waited < 1000, `the live instance waited ${waited} ms`);
});

test('shared store: a long call renews its lease, so no one takes its slot while it runs', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 100, tpm: 1_000_000, maxConcurrency: 1, windowMs: 1000, leaseMs: 30};
  const [a, b] = [onShared(store, limits), onShared(store, limits)];
  const long = await a.acquire(1);
  let releasedAt = 0;
  const other = b.acquire(1).then(p => (p.release(), Date.now()));
  await sleepMs(120);
  releasedAt = Date.now();
  long.release();
  assert.ok((await other) >= releasedAt, 'b started only after a released');
});

test('shared store: waiters from different instances go first in, first out', async () => {
  const store = memoryLimiterStore();
  const limits = {qpm: 100, tpm: 1_000_000, maxConcurrency: 1, windowMs: 1000};
  const [a, b, c] = [onShared(store, limits), onShared(store, limits), onShared(store, limits)];
  const held = await a.acquire(1);
  const order: string[] = [];
  const first = b.acquire(1).then(p => (order.push('b'), p.release()));
  await sleepMs(10);
  const second = c.acquire(1).then(p => (order.push('c'), p.release()));
  await sleepMs(10);
  held.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['b', 'c']);
});

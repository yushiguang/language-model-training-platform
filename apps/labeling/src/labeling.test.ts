import assert from 'node:assert/strict';
import test from 'node:test';
import type {LabelCallRequest, LabelCallResult, LlmGatewayContract, Schema} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {featureDocId, toFeatures} from '@yushiguang/sprint-domain';
import {leaseLocks, localDocRuntime, memoryLockStore} from '@yushiguang/sprint-platform';
import {createLabeling, predictionId} from './labeling.ts';
import {memoryLocks} from './locks.ts';

const schema: Schema = {name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]};

async function setup(n: number, prefix: string, without: string[] = []) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  await catalog.insert('setup_versions', {id: 'sv_1', projectId: 'pr_1', number: 1, schemaVersion: 1, task: '', schema, thresholds: null, models: [], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  const v = await catalog.createPromptVersion({projectId: 'pr_1', structured: {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, label: {name: '', kind: 'single', values: []}, ruleGroups: [], images: []}, template: 'Label {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  const ids = Array.from({length: n}, (_, i) => `ex_${i}`);
  await catalog.insertMany('examples', ids.map((id, i) => ({id, snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, title: '', split: 'train' as const, optimiserHalf: false})));
  // Frozen features (#32): one document per example, apart from the example records.
  await catalog.insertMany('example_features', ids.flatMap((_, i) => (without.includes(String(i)) ? [] : [{id: featureDocId('ds_1', String(i)), snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, features: toFeatures({Description: `post ${i}`}), fetchedAt: ''}])));
  return {db, catalog, v, ids};
}

/** Examples with their features, as a caller of tryTemplate passes them. */
async function withFeatures(catalog: ReturnType<typeof createCatalog>, ids: string[]) {
  const examples = await catalog.findByIds('examples', ids);
  const features = await catalog.exampleFeatures(examples);
  return examples.map(e => ({...e, features: features[e.id] ?? {}}));
}

function fakeGateway(answer: (req: LabelCallRequest) => Promise<string>, stats = {inFlight: 0, maxInFlight: 0, calls: 0}): LlmGatewayContract {
  return {
    endpoints: () => [],
    labelingEndpoints: () => [],
    agentModel: () => {
      throw new Error('not used');
    },
    cancel: async () => {},
    async label(req): Promise<LabelCallResult> {
      stats.calls++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise(r => setTimeout(r, 2));
        return {text: await answer(req), inputTokens: 100, outputTokens: 10, costUsd: 0.01, endpointId: 'labeling-A', attempts: 1};
      } finally {
        stats.inFlight--;
      }
    },
  };
}

/** A promise the test resolves by hand, so a run stays in flight until the test lets it finish. */
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(res => (resolve = res));
  return {promise, resolve};
}

const input = (ids: string[], v: {id: string}, extra = {}) => ({
  projectId: 'pr_1',
  purpose: 'training' as const,
  promptVersionId: v.id,
  setupVersionId: 'sv_1',
  endpoint: 'A' as const,
  settings: {endpoint: 'A' as const, maxOutputTokens: 100, temperature: null},
  exampleIds: ids,
  createdBy: 'test',
  ...extra,
});

test('runs examples in parallel (up to 4 at once) and saves one prediction each', async () => {
  const {db, catalog, v, ids} = await setup(30, 'lab-1');
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}', stats), locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v));
  const done = await lab.runTask(t.id);
  assert.equal(done?.state, 'done');
  assert.deepEqual([done?.done, done?.valid, done?.invalid, done?.failed], [30, 30, 0, 0]);
  assert.equal(stats.maxInFlight, 4);
  const preds = await lab.predictions(v.id, 'A', t.settingsHash);
  assert.equal(Object.keys(preds).length, 30);
});

test('invalid answers are results; a resumed task only labels what is missing', async () => {
  const {db, catalog, v, ids} = await setup(10, 'lab-2');
  let calls = 0;
  const gateway = fakeGateway(async () => (++calls % 2 ? '{"format": "Vlog"}' : 'not json'));
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids.slice(0, 6), v));
  await lab.runTask(t.id);
  const t2 = await lab.createTask(input(ids, v));
  const r = await lab.runTask(t2.id);
  assert.equal(calls, 10, 'the 6 already labeled are reused');
  assert.equal(r?.done, 10);
  assert.equal((r?.valid ?? 0) + (r?.invalid ?? 0), 10);
  assert.ok((r?.invalid ?? 0) > 0);
});

test('a failing example does not fail the task; too many failures need attention; Retry failed relabels them', async () => {
  const {db, catalog, v, ids} = await setup(40, 'lab-3');
  let broken = true;
  const gateway = fakeGateway(async req => {
    if (broken && (req.traceId === '3' || req.traceId === '7')) throw new Error('model did not answer');
    return '{"format": "Tutorial"}';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v));
  const r = await lab.runTask(t.id);
  assert.equal(r?.state, 'needs_attention');
  assert.equal(r?.done, 38);
  assert.equal(r?.failed, 2);
  assert.match(r?.error ?? '', /2 examples failed/);

  broken = false;
  const again = await lab.retryFailed(t.id);
  assert.equal(again?.state, 'done');
  assert.deepEqual([again?.done, again?.failed], [40, 0]);
});

test('stops early when more than 5% of examples fail', async () => {
  const {db, catalog, v, ids} = await setup(40, 'lab-4');
  const gateway = fakeGateway(async () => {
    throw new Error('down');
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v));
  const r = await lab.runTask(t.id);
  assert.equal(r?.state, 'needs_attention');
  assert.ok((r?.failed ?? 0) < 10, `stopped after ${r?.failed} failures`);
});

test('one runner per task: a second run returns null; Stop stops it; a closed runner shows as paused', async () => {
  const {db, catalog, v, ids} = await setup(40, 'lab-6');
  const locks = memoryLocks();
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks});
  const t = await lab.createTask(input(ids, v));
  const first = lab.runTask(t.id);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(await lab.runTask(t.id), null);
  assert.equal(await lab.isRunning(t.id), true);
  await lab.stopTask(t.id);
  const stopped = await first;
  assert.equal(stopped?.state, 'stopped');

  // A task left "running" by a closed page (no lock held) is reported as paused.
  await createCatalog(db); // no-op, keeps the same store
  const t2 = await lab.createTask(input(ids, v));
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  await new DocRepo(db).patch('labeling_tasks', t2.id, {state: 'running'});
  const listed = (await lab.listTasks('pr_1')).find(x => x.id === t2.id);
  assert.equal(listed?.state, 'paused');
  assert.equal(listed?.stopReason, 'closed');
});

test('tryTemplate labels a few examples with an unsaved template and saves nothing', async () => {
  const {db, catalog, v, ids} = await setup(3, 'try-');
  const labeling = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": ["Vlog"]}'), locks: memoryLocks()});
  const examples = await withFeatures(catalog, ids);
  const rows = await labeling.tryTemplate({template: 'Draft {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], schema, settings: {endpoint: 'A', maxOutputTokens: 100, temperature: 0}, examples});
  assert.deepEqual(rows.map(r => r.exampleId), ids);
  assert.ok(rows.every(r => r.answer?.join() === 'Vlog' && r.costUsd === 0.01));
  assert.equal((await labeling.listTasks('pr_1')).length, 0);
  // Nothing saved under the version that exists either.
  assert.equal(Object.keys(await labeling.predictions(v.id, 'A', 'any')).length, 0);
});

test('a try is stopped by its request id: the calls carry the id, and cancel reaches the gateway (spec 4.1)', async () => {
  const {db, catalog, ids} = await setup(2, 'try-cancel');
  const withId: (string | undefined)[] = [];
  const cancelled: string[] = [];
  const gateway: LlmGatewayContract = {
    ...fakeGateway(async req => (withId.push(req.requestId), '{"format": ["Vlog"]}')),
    cancel: async id => void cancelled.push(id),
  };
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const examples = await withFeatures(catalog, ids);
  await labeling.tryTemplate({template: 'Draft {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], schema, settings: {endpoint: 'A', maxOutputTokens: 100, temperature: 0}, examples, requestId: 'rq_try'});
  assert.deepEqual(withId, ['rq_try', 'rq_try']);
  await labeling.cancel('rq_try');
  assert.deepEqual(cancelled, ['rq_try']);
});

test('image URLs may be resolved asynchronously (a signed URL per call), and every call gets its own (spec 4.5)', async () => {
  const {db, catalog, v, ids} = await setup(2, 'signed-urls');
  const seen: string[] = [];
  let signed = 0;
  const resolveUrl = async (url: string) => {
    await new Promise(r => setTimeout(r, 1));
    return `https://files.example/${url}?sig=${++signed}`;
  };
  const gateway = fakeGateway(async req => {
    for (const m of req.messages) for (const c of m.content as {type: string; url?: string}[]) if (c.type === 'image') seen.push(c.url!);
    return '{"format": ["Vlog"]}';
  });
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks(), resolveUrl});
  const images = [{url: 'logo.png', name: 'logo.png', size: 1}];
  const examples = await withFeatures(catalog, ids);
  const rows = await labeling.tryTemplate({template: 'Draft {{Description}} [Image 1]', features: {video: ['Description'], photo_text: [], metadata: []}, images, schema, settings: {endpoint: 'A', maxOutputTokens: 100, temperature: 0}, examples});
  assert.ok(rows.every(r => r.error === null && r.answer?.join() === 'Vlog'));
  assert.equal(seen.length, 2);
  assert.ok(seen.every(u => /^https:\/\/files\.example\/logo\.png\?sig=\d$/.test(u)));
  assert.equal(new Set(seen).size, 2, 'each call signs its own URL');
  // A saved run resolves the same way.
  await catalog.patch('prompt_versions', v.id, {template: 'Label {{Description}} [Image 1]', images});
  const task = await labeling.createTask(input(ids, v));
  await labeling.runTask(task.id);
  assert.equal(seen.length, 4);
  assert.ok(seen.slice(2).every(u => u.startsWith('https://files.example/logo.png?sig=')));
});

test('relabelInvalid: an example whose only answer is invalid is labeled once more, and the valid answer wins', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-relabel');
  const seen = new Map<string, number>();
  // Example 0 answers invalid the first time, valid after; example 1 is always invalid.
  const gateway = fakeGateway(async req => {
    const n = (seen.get(req.traceId!) ?? 0) + 1;
    seen.set(req.traceId!, n);
    if (req.traceId === '1' || (req.traceId === '0' && n === 1)) return 'not json';
    return '{"format": "Vlog"}';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const first = await lab.runTask((await lab.createTask(input(ids, v))).id);
  assert.deepEqual([first?.valid, first?.invalid], [2, 2]);
  const again = await lab.createTask(input(ids, v, {relabelInvalid: true}));
  const r = await lab.runTask(again.id);
  assert.deepEqual([seen.get('0'), seen.get('1'), seen.get('2')], [2, 2, 1], 'only the invalid ones are called again');
  assert.deepEqual([r?.done, r?.valid, r?.invalid], [4, 3, 1]);
  const preds = await lab.predictions(v.id, 'A', again.settingsHash);
  assert.ok(preds[ids[0]]?.answer, 'the valid second answer wins');
  // Running it again labels nothing: each example gets one more try only.
  await lab.runTask(again.id);
  const third = await lab.createTask(input(ids, v, {relabelInvalid: true}));
  await lab.runTask(third.id);
  assert.equal(seen.get('1'), 2);
});

test('Retry failed on a task that is running changes nothing and returns null', async () => {
  const {db, catalog, v, ids} = await setup(40, 'lab-retry-lock');
  let calls = 0;
  const gateway = fakeGateway(async req => {
    calls++;
    if (req.traceId === '0') throw new Error('model did not answer');
    await new Promise(r => setTimeout(r, 3));
    return '{"format": "Vlog"}';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v));
  const running = lab.runTask(t.id);
  await new Promise(r => setTimeout(r, 15));
  assert.equal(await lab.retryFailed(t.id), null);
  const r = await running;
  assert.equal(r?.state, 'needs_attention');
  assert.deepEqual([r?.failed, r?.failedExampleIds], [1, [ids[0]]], 'the running run kept its failure');
  assert.equal(calls, 40);
});

test('two tasks for the same version, model and settings never pay twice for an example', async () => {
  const {db, catalog, v, ids} = await setup(12, 'lab-dedupe');
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}', stats), locks: memoryLocks()});
  const a = await lab.createTask(input(ids, v));
  const b = await lab.createTask(input(ids, v));
  const [ra, rb] = await Promise.all([lab.runTask(a.id), lab.runTask(b.id)]);
  assert.equal(stats.calls, 12, 'each example labeled once');
  assert.deepEqual([ra?.done, rb?.done], [12, 12]);
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const docs = await new DocRepo(db).find('predictions', {promptVersionId: v.id});
  assert.equal(docs.length, 12, 'one saved prediction per example');
});

test('a Stop from another tab is seen during a long model call, and an old Stop is ignored', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop');
  // A call that only ends when it is cancelled by its request id (no signal crosses the contract).
  const open = new Map<string, (() => void)[]>();
  const gateway: LlmGatewayContract = {
    ...fakeGateway(async () => '{"format": "Vlog"}'),
    label: req =>
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('never stopped')), 10_000); // like an open request
        const stop = () => (clearTimeout(timer), reject(new DOMException('Stopped', 'AbortError')));
        open.set(req.requestId ?? '', [...(open.get(req.requestId ?? '') ?? []), stop]);
      }),
    cancel: async id => (open.get(id) ?? []).forEach(stop => stop()),
  };
  const tab1 = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const tab2 = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await tab1.createTask(input(ids, v));
  // A Stop pressed before this run started is not for it.
  await tab2.stopTask(t.id);
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  await new DocRepo(db).patch('labeling_tasks', t.id, {stopRequestedAt: '2000-01-01T00:00:00.000Z'});
  const run = tab1.runTask(t.id);
  await new Promise(r => setTimeout(r, 2300));
  assert.equal((await tab1.getTask(t.id))?.state, 'running', 'the old Stop was ignored');
  const pressed = Date.now();
  await tab2.stopTask(t.id);
  const r = await run;
  assert.equal(r?.state, 'stopped');
  assert.ok(Date.now() - pressed < 2600, `seen after ${Date.now() - pressed} ms`);
});

test('an example that failed in one run and was saved by another counts as done, not failed', async () => {
  const {db, catalog, v, ids} = await setup(3, 'lab-failed-saved');
  let broken = true;
  const lab = createLabeling({
    db,
    catalog,
    gateway: fakeGateway(async req => {
      if (broken && req.traceId === '0') throw new Error('down');
      return '{"format": "Vlog"}';
    }),
    locks: memoryLocks(),
  });
  const a = await lab.createTask(input(ids, v));
  assert.equal((await lab.runTask(a.id))?.state, 'needs_attention');
  broken = false;
  // Another task labels example 0.
  await lab.runTask((await lab.createTask(input([ids[0]], v))).id);
  const r = await lab.runTask(a.id);
  assert.deepEqual([r?.state, r?.done, r?.failed], ['done', 3, 0]);
});

test('relabelInvalid does not try again an invalid answer the same task saved before a pause', async () => {
  const {db, catalog, v, ids} = await setup(6, 'lab-relabel-own');
  let answered = 0;
  let down = false;
  const gateway = fakeGateway(async () => {
    // The model goes down after two answers, so the task pauses with two invalid answers saved.
    if (down || answered === 2) {
      down = answered === 2 && !down ? true : down;
      throw new Error('down');
    }
    answered++;
    return 'not json';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v, {relabelInvalid: true, parallel: 1}));
  const paused = await lab.runTask(t.id);
  assert.equal(paused?.state, 'needs_attention');
  down = false;
  answered = 3; // past the outage: every later call answers
  let done: Awaited<ReturnType<typeof lab.runTask>> = paused;
  for (let i = 0; i < 5 && done?.state !== 'done'; i++) done = await lab.retryFailed(t.id, 'user');
  assert.deepEqual([done?.state, done?.done, done?.invalid], ['done', 6, 6]);
  assert.equal(answered - 1, 6, 'each example answered once: its own invalid answers are results');
});

test("every labeling prompt ends with the site's reason line, and the model's reason is kept with the answer", async () => {
  const {REASON_LINE} = await import('@yushiguang/sprint-domain');
  const {db, catalog, v, ids} = await setup(2, 'lab-reason');
  const asked: string[] = [];
  const gateway = fakeGateway(async req => {
    const c = req.messages[0].content;
    asked.push(typeof c === 'string' ? c : c.map(p => (p.type === 'text' ? p.text : '')).join(''));
    return req.traceId === '0' ? '{"reason": "It shows a day out.", "format": "Vlog"}' : '{"format": "Vlog"}';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v));
  await lab.runTask(t.id);
  assert.ok(asked.length === 2 && asked.every(a => a.startsWith('Label post') && a.endsWith(REASON_LINE)));
  const preds = await lab.predictions(v.id, 'A', t.settingsHash);
  assert.equal(preds['ex_0']?.reason, 'It shows a day out.');
  assert.deepEqual(preds['ex_0']?.answer, ['Vlog']);
  assert.equal(preds['ex_1']?.reason, undefined);
});

test('frozen features (#32): a run reads each example\'s features from its document, a batch at a time; missing features fail only that example; older records keep their own', async () => {
  // Example 3's features document is missing.
  const {db, catalog, v, ids} = await setup(120, 'lab-frozen', ['3']);
  // An example saved before #32 holds its features on its own record.
  await catalog.insert('examples', {id: 'ex_old', snapshotId: 'ds_1', externalId: 'old', type: 'video', title: '', split: 'train', optimiserHalf: false, features: toFeatures({Description: 'an older post'})} as never);
  const prompts = new Map<string, string>();
  const reads: number[] = [];
  const exampleFeatures = catalog.exampleFeatures.bind(catalog);
  const counted = Object.assign(Object.create(catalog), {
    exampleFeatures: async (wanted: Parameters<typeof exampleFeatures>[0]) => {
      reads.push(wanted.length);
      return exampleFeatures(wanted);
    },
  });
  const gateway = fakeGateway(async req => {
    prompts.set(req.traceId ?? '', JSON.stringify(req.messages));
    return '{"format": "Vlog"}';
  });
  const lab = createLabeling({db, catalog: counted, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input([...ids, 'ex_old'], v, {parallel: 4}));
  const r = await lab.runTask(t.id);
  assert.deepEqual([r?.done, r?.failed], [120, 1]);
  assert.deepEqual(r?.failedExampleIds, ['ex_3']);
  assert.match(r?.error ?? '', /features could not be found/);
  assert.match(prompts.get('7') ?? '', /post 7/);
  assert.match(prompts.get('old') ?? '', /an older post/);
  assert.ok(reads.length >= 3 && reads.every(n => n <= 50), 'features are read a batch at a time');
});

test('frozen features (#32): a batch read that fails once is tried again; no worker fails on it', async () => {
  const {db, catalog, v, ids} = await setup(20, 'lab-frozen-retry');
  let failures = 1;
  const flaky = Object.assign(Object.create(catalog), {
    exampleFeatures: async (wanted: Parameters<typeof catalog.exampleFeatures>[0]) => {
      if (failures-- > 0) throw new Error('storage blip');
      return catalog.exampleFeatures(wanted);
    },
  });
  const gateway = fakeGateway(async () => '{"format": "Vlog"}');
  const lab = createLabeling({db, catalog: flaky, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v, {parallel: 4}));
  const r = await lab.runTask(t.id);
  assert.deepEqual([r?.done, r?.failed, r?.state], [20, 0, 'done']);
});

// Two processes (issue #46): two createLabeling instances over one document store, each with its
// own locks object. Shared-lock cases give both their own leaseLocks adapter over one
// memoryLockStore, as two server units over one Platform.lockStore; disjoint memoryLocks stand
// for units whose locks cannot see each other at all.

test('two processes, shared locks: a reader in the other process does not falsify a running task, and cannot run it too', async () => {
  const {db, catalog, v, ids} = await setup(8, 'lab-two-process');
  const store = memoryLockStore();
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  const entered = deferred();
  const gate = deferred();
  const gateway = fakeGateway(async () => {
    entered.resolve('in');
    await gate.promise;
    return '{"format": "Vlog"}';
  }, stats);
  const a = createLabeling({db, catalog, gateway, locks: leaseLocks(store)});
  const b = createLabeling({db, catalog: createCatalog(db), gateway, locks: leaseLocks(store)});
  const t = await a.createTask(input(ids, v));
  const running = a.runTask(t.id);
  await entered.promise;
  assert.equal((await b.listTasks('pr_1')).find(x => x.id === t.id)?.state, 'running', "the other process's read leaves the live run running");
  assert.equal((await b.getTask(t.id))?.state, 'running', 'and nothing was persisted over it');
  assert.equal(await b.runTask(t.id), null, 'the task lock is held in the other process');
  gate.resolve('go');
  assert.equal((await running)?.state, 'done');
  assert.equal(stats.calls, 8, 'each example was paid for once');
});

test('two processes, shared locks: concurrent identical work pays once per example and saves one prediction each', async () => {
  const {db, catalog, v, ids} = await setup(12, 'lab-two-process-dedupe');
  const store = memoryLockStore();
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  const gateway = fakeGateway(async () => '{"format": "Vlog"}', stats);
  const a = createLabeling({db, catalog, gateway, locks: leaseLocks(store)});
  const b = createLabeling({db, catalog: createCatalog(db), gateway, locks: leaseLocks(store)});
  const ta = await a.createTask(input(ids, v));
  const tb = await b.createTask(input(ids, v));
  const [ra, rb] = await Promise.all([a.runTask(ta.id), b.runTask(tb.id)]);
  assert.equal(stats.calls, 12, 'each example labeled once across both processes');
  assert.deepEqual([ra?.done, rb?.done], [12, 12]);
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const docs = await new DocRepo(db).find('predictions', {promptVersionId: v.id});
  assert.equal(docs.length, 12, 'one saved prediction per example');
});

test("two processes: a dead runner's task is reaped only after its lock lease ends, and the next runner resumes from saved answers", async () => {
  const {db, catalog, v, ids} = await setup(8, 'lab-two-process-takeover');
  const store = memoryLockStore();
  let now = 1000;
  const clock = () => now;
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  const gateway = fakeGateway(async () => '{"format": "Vlog"}', stats);
  const a = createLabeling({db, catalog, gateway, locks: leaseLocks(store, {clock})});
  const b = createLabeling({db, catalog: createCatalog(db), gateway, locks: leaseLocks(store, {clock})});
  // The dead runner saved the first three answers (under its own task), then died holding the
  // full task's lock: its lease is in the store, its process is gone.
  await a.runTask((await a.createTask(input(ids.slice(0, 3), v))).id);
  assert.equal(stats.calls, 3);
  const t = await a.createTask(input(ids, v));
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  await new DocRepo(db).patch('labeling_tasks', t.id, {state: 'running'});
  await store.acquire(`labeling:${t.id}`, 'gone', 100, now);
  assert.equal((await b.listTasks('pr_1')).find(x => x.id === t.id)?.state, 'running', 'the lease still lasts: not reaped yet');
  now = 1101;
  const listed = (await b.listTasks('pr_1')).find(x => x.id === t.id);
  assert.deepEqual([listed?.state, listed?.stopReason], ['paused', 'closed'], 'after the lease ends the closed runner is reaped, as a closed page is');
  assert.equal((await b.getTask(t.id))?.state, 'paused');
  const resumed = await b.runTask(t.id);
  assert.equal(resumed?.state, 'done');
  assert.equal(stats.calls, 8, 'the three saved answers were reused; only the missing five were paid for');
  const docs = await new DocRepo(db).find('predictions', {promptVersionId: v.id});
  assert.equal(docs.length, 8, 'one saved prediction per example');
});

test('two processes, locks that cannot see each other: liveElsewhere keeps a live run from being falsified, and only then', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-two-process-live-elsewhere');
  let live = true;
  let asked = 0;
  const a = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks: memoryLocks()});
  const b = createLabeling({
    db,
    catalog: createCatalog(db),
    gateway: fakeGateway(async () => '{"format": "Vlog"}'),
    locks: memoryLocks(),
    liveElsewhere: async () => {
      asked++;
      return live;
    },
  });
  const t = await a.createTask(input(ids, v));
  await b.listTasks('pr_1');
  assert.equal(asked, 0, 'the predicate is not consulted for a task that is not a candidate orphan');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  await new DocRepo(db).patch('labeling_tasks', t.id, {state: 'running'});
  assert.equal((await b.listTasks('pr_1')).find(x => x.id === t.id)?.state, 'running', 'work live elsewhere (a queued or running job) leaves the task running');
  assert.equal((await b.getTask(t.id))?.state, 'running', 'and nothing was persisted over it');
  assert.ok(asked >= 1, 'the predicate was consulted for the candidate orphan');
  live = false;
  const listed = (await b.listTasks('pr_1')).find(x => x.id === t.id);
  assert.deepEqual([listed?.state, listed?.stopReason], ['paused', 'closed'], 'nothing live anywhere: the closed runner is reaped as before');
});

test('two processes: a task that finishes while liveElsewhere is being asked is never reaped over its finished state', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-two-process-finish-race');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const a = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks: memoryLocks()});
  // The gated predicate stands for the job-store read in another unit: while it is in flight the
  // runner finishes (its final patch lands, its lock and job end), and only then does the answer
  // "nothing live" come back. The task the read returns and keeps must be the finished one.
  const b = createLabeling({
    db,
    catalog: createCatalog(db),
    gateway: fakeGateway(async () => '{"format": "Vlog"}'),
    locks: memoryLocks(),
    liveElsewhere: async task => {
      await new DocRepo(db).patch('labeling_tasks', task.id, {state: 'done', finishedAt: new Date().toISOString()});
      return false;
    },
  });
  const t = await a.createTask(input(ids, v));
  await new DocRepo(db).patch('labeling_tasks', t.id, {state: 'running'});
  const listed = (await b.listTasks('pr_1')).find(x => x.id === t.id);
  assert.equal(listed?.state, 'done', 'the finished state is adopted, not patched over');
  assert.equal((await b.getTask(t.id))?.state, 'done', 'the stored task stays done, never paused');
});

test('two processes: a liveElsewhere that throws does not fail the read, and the task is not reaped on that read', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-two-process-live-elsewhere-throws');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const a = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks: memoryLocks()});
  // A job-store blip behind the predicate: the read must still succeed, conservatively keeping
  // the task running — a store that cannot answer never proves a runner is gone.
  const b = createLabeling({
    db,
    catalog: createCatalog(db),
    gateway: fakeGateway(async () => '{"format": "Vlog"}'),
    locks: memoryLocks(),
    liveElsewhere: async () => {
      throw new Error('the job store did not answer');
    },
  });
  const t = await a.createTask(input(ids, v));
  await new DocRepo(db).patch('labeling_tasks', t.id, {state: 'running'});
  const listed = (await b.listTasks('pr_1')).find(x => x.id === t.id);
  assert.equal(listed?.state, 'running', 'the read succeeds and leaves the task running');
  assert.equal((await b.getTask(t.id))?.state, 'running', 'nothing was persisted over it');
});

test('an answer saved by another runner while this call was in flight is not saved twice', async () => {
  const {db, catalog, v, ids} = await setup(1, 'lab-saved-meanwhile');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  // While this process pays for the example, another runner (its lock unseen here) saves the
  // same deterministic prediction; the re-check before insert keeps one document.
  const gateway = fakeGateway(async () => {
    const t = (await new DocRepo(db).find<{id: string; settingsHash: string}>('labeling_tasks', {projectId: 'pr_1'}))[0];
    await new DocRepo(db).insert('predictions', {id: predictionId(v.id, 'A', t.settingsHash, ids[0]), projectId: 'pr_1', promptVersionId: v.id, endpoint: 'A', settingsHash: t.settingsHash, exampleId: ids[0], output: '{"format": "Vlog"}', answer: ['Vlog'], invalidReason: null, costUsd: 0.01, tokens: 110, createdAt: new Date().toISOString()});
    return '{"format": "Vlog"}';
  });
  const lab = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v, {parallel: 1}));
  const r = await lab.runTask(t.id);
  assert.equal(r?.state, 'done');
  const docs = await new DocRepo(db).find('predictions', {promptVersionId: v.id});
  assert.equal(docs.length, 1, 'one saved prediction, though two runners labeled the example');
});

test('Stop on a task no runner holds ends it as stopped; a Stop asked of a live one is kept until no runner holds it (#66)', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop-idle');
  let live = true;
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks: memoryLocks(), liveElsewhere: async () => live});
  // Its job is starting (live elsewhere), though the record still says queued: the request waits.
  const starting = await lab.createTask(input(ids, v));
  await lab.stopTask(starting.id);
  assert.deepEqual([(await lab.getTask(starting.id))?.state, (await lab.getTask(starting.id))?.stopRequested], ['queued', true]);
  // Waiting in the queue with no runner anywhere (its job cancelled): stopped at once.
  live = false;
  const queued = await lab.createTask(input(ids, v));
  await lab.stopTask(queued.id);
  assert.deepEqual([(await lab.getTask(queued.id))?.state, (await lab.getTask(queued.id))?.stopReason], ['stopped', 'user']);
  // A task that already ended gets no request left over.
  await new DocRepo(db).patch('labeling_tasks', queued.id, {state: 'needs_attention'});
  await lab.stopTask(queued.id);
  assert.deepEqual([(await lab.getTask(queued.id))?.state, (await lab.getTask(queued.id))?.stopRequested], ['needs_attention', false]);
  live = true;
  // Running in another unit: the request waits for that runner.
  const elsewhere = await lab.createTask(input(ids, v));
  await new DocRepo(db).patch('labeling_tasks', elsewhere.id, {state: 'running'});
  await lab.stopTask(elsewhere.id);
  assert.deepEqual([(await lab.getTask(elsewhere.id))?.state, (await lab.getTask(elsewhere.id))?.stopRequested], ['running', true]);
  // That runner went away: the read that finds it left behind ends it as stopped, not paused.
  live = false;
  const listed = (await lab.listTasks('pr_1')).find(x => x.id === elsewhere.id);
  assert.deepEqual([listed?.state, listed?.stopReason], ['stopped', 'user']);
});

test('a Stop never writes over a task that ends while liveElsewhere is asked; a request left by a runner that never started ends at the next read (#66)', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop-race');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const repo = new DocRepo(db);
  let during: (() => Promise<void>) | null = null;
  let live = true;
  const lab = createLabeling({
    db,
    catalog,
    gateway: fakeGateway(async () => '{"format": "Vlog"}'),
    locks: memoryLocks(),
    liveElsewhere: async () => {
      if (during) await during();
      return live;
    },
  });
  // The runner elsewhere finishes while the Stop asks whether it is live.
  const t = await lab.createTask(input(ids, v));
  await repo.patch('labeling_tasks', t.id, {state: 'running'});
  during = async () => {
    await repo.patch('labeling_tasks', t.id, {state: 'done'});
    live = false;
  };
  await lab.stopTask(t.id);
  assert.deepEqual([(await lab.getTask(t.id))?.state, (await lab.getTask(t.id))?.stopRequested], ['done', false]);
  // A Stop while the task's runner was starting is kept; that runner went away: the next read ends it.
  during = null;
  live = true;
  const s = await lab.createTask(input(ids, v));
  await lab.stopTask(s.id);
  assert.equal((await lab.getTask(s.id))?.stopRequested, true);
  live = false;
  const listed = (await lab.listTasks('pr_1')).find(x => x.id === s.id);
  assert.deepEqual([listed?.state, listed?.stopReason], ['stopped', 'user']);
});

test('a Stop saved while the runner was starting ends the run before any model call (#66)', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop-starting');
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  // Its job has been claimed (live elsewhere) but the runner has not taken the task yet.
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}', stats), locks: memoryLocks(), liveElsewhere: async () => true});
  const t = await lab.createTask(input(ids, v));
  await lab.stopTask(t.id);
  assert.equal((await lab.getTask(t.id))?.stopRequested, true);
  const r = await lab.runTask(t.id);
  assert.deepEqual([r?.state, r?.stopReason, r?.stopRequested], ['stopped', 'user', false]);
  assert.equal(stats.calls, 0, 'nothing paid');
});

test('a Stop while a stopped or failed task is starting again is kept and ends that run; on an idle one it leaves nothing behind (#66)', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop-resume');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const repo = new DocRepo(db);
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  let live = true;
  const locks = memoryLocks();
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}', stats), locks, liveElsewhere: async () => live});
  // Resume of a stopped task: its job is claimed, the record still says stopped.
  const resumed = await lab.createTask(input(ids, v));
  await repo.patch('labeling_tasks', resumed.id, {state: 'stopped', stopReason: 'user'});
  await lab.stopTask(resumed.id);
  assert.equal((await lab.getTask(resumed.id))?.stopRequested, true);
  const r1 = await lab.runTask(resumed.id);
  assert.deepEqual([r1?.state, r1?.stopRequested], ['stopped', false]);
  // Retry failed of a task that needs attention: the same.
  const retried = await lab.createTask(input(ids, v));
  await repo.patch('labeling_tasks', retried.id, {state: 'needs_attention', failed: 1, failedExampleIds: [ids[0]]});
  await lab.stopTask(retried.id);
  const r2 = await lab.retryFailed(retried.id);
  assert.deepEqual([r2?.state, r2?.stopReason], ['stopped', 'user']);
  // Pressed while this process's runner holds the lock and is still preparing: saved, then seen.
  live = false;
  const preparing = await lab.createTask(input(ids, v));
  await locks.run(`labeling:${preparing.id}`, async () => {
    await lab.stopTask(preparing.id);
  });
  assert.equal((await lab.getTask(preparing.id))?.stopRequested, true);
  const r3 = await lab.runTask(preparing.id);
  assert.equal(r3?.state, 'stopped');
  assert.equal(stats.calls, 0, 'nothing paid');
  // An idle stopped task: nothing changes and no request waits for a later Resume.
  await repo.patch('labeling_tasks', resumed.id, {stopRequested: true});
  await lab.stopTask(resumed.id);
  assert.deepEqual([(await lab.getTask(resumed.id))?.state, (await lab.getTask(resumed.id))?.stopRequested], ['stopped', false]);
  // A request left on one is cleared at the next read too.
  await repo.patch('labeling_tasks', retried.id, {stopRequested: true});
  const listed = (await lab.listTasks('pr_1')).find(x => x.id === retried.id);
  assert.deepEqual([listed?.state, listed?.stopRequested], ['stopped', false]);
  const r4 = await lab.runTask(resumed.id);
  assert.equal(r4?.state, 'done', 'a later Resume runs');
});

test('a Stop pressed while this process prepares the run is seen before any model call; a read never saves a request (#66)', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop-preparing');
  const {DocRepo} = await import('@yushiguang/sprint-platform');
  const repo = new DocRepo(db);
  const stats = {inFlight: 0, maxInFlight: 0, calls: 0};
  let onPrepare: (() => Promise<void>) | null = null;
  // The run reads its prompt version while preparing: the Stop comes then (the lock is held,
  // nothing in `active` yet).
  const slow = {
    ...catalog,
    get: (async (collection: string, id: string) => {
      if (collection === 'prompt_versions' && onPrepare) await onPrepare();
      return (catalog.get as (c: string, i: string) => Promise<unknown>)(collection, id);
    }) as typeof catalog.get,
  };
  let live = false;
  const lab = createLabeling({db, catalog: slow, gateway: fakeGateway(async () => '{"format": "Vlog"}', stats), locks: memoryLocks(), liveElsewhere: async () => live});
  const t = await lab.createTask(input(ids, v));
  onPrepare = async () => {
    onPrepare = null;
    await lab.stopTask(t.id);
  };
  const r = await lab.runTask(t.id);
  assert.deepEqual([r?.state, r?.stopReason], ['stopped', 'user']);
  assert.equal(stats.calls, 0, 'nothing paid');
  // A read finds a request while the task's job is live: it saves nothing (the runner ends it).
  live = true;
  const q = await lab.createTask(input(ids, v));
  await lab.stopTask(q.id);
  const saved = (await lab.getTask(q.id))?.stopRequestedAt;
  await new Promise(r => setTimeout(r, 5));
  await lab.listTasks('pr_1');
  assert.deepEqual([(await lab.getTask(q.id))?.state, (await lab.getTask(q.id))?.stopRequestedAt], ['queued', saved]);
  // The request was cleared meanwhile and a new run's job is live: the read adds none.
  await repo.patch('labeling_tasks', q.id, {stopRequested: false});
  await lab.listTasks('pr_1');
  assert.equal((await lab.getTask(q.id))?.stopRequested, false);
});

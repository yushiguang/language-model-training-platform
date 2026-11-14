import assert from 'node:assert/strict';
import test from 'node:test';
import type {LabelCallRequest, LabelCallResult, LlmGatewayContract, Schema} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {toFeatures} from '@tsp/domain';
import {localDocRuntime} from '@tsp/platform';
import {createLabeling} from './labeling.ts';
import {memoryLocks} from './locks.ts';

const schema: Schema = {fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]};

async function setup(n: number, prefix: string) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  await catalog.insert('setup_versions', {id: 'sv_1', projectId: 'pr_1', number: 1, schemaVersion: 1, task: '', schema, thresholds: null, models: [], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  const v = await catalog.createPromptVersion({projectId: 'pr_1', structured: {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, fields: [], generalRules: '', images: []}, template: 'Label {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  const ids = Array.from({length: n}, (_, i) => `ex_${i}`);
  await catalog.insertMany('examples', ids.map((id, i) => ({id, snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, title: '', features: toFeatures({Description: `post ${i}`}), split: 'train' as const, optimiserHalf: false})));
  return {db, catalog, v, ids};
}

function fakeGateway(answer: (req: LabelCallRequest) => Promise<string>, stats = {inFlight: 0, maxInFlight: 0, calls: 0}): LlmGatewayContract {
  return {
    endpoints: () => [],
    labelingEndpoints: () => [],
    agentModel: () => {
      throw new Error('not used');
    },
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
  const {DocRepo} = await import('@tsp/platform');
  await new DocRepo(db).patch('labeling_tasks', t2.id, {state: 'running'});
  const listed = (await lab.listTasks('pr_1')).find(x => x.id === t2.id);
  assert.equal(listed?.state, 'paused');
  assert.equal(listed?.stopReason, 'closed');
});

test('tryTemplate labels a few examples with an unsaved template and saves nothing', async () => {
  const {db, catalog, v, ids} = await setup(3, 'try-');
  const labeling = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": ["Vlog"]}'), locks: memoryLocks()});
  const examples = await catalog.findByIds('examples', ids);
  const rows = await labeling.tryTemplate({template: 'Draft {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], schema, settings: {endpoint: 'A', maxOutputTokens: 100, temperature: 0}, examples});
  assert.deepEqual(rows.map(r => r.exampleId), ids);
  assert.ok(rows.every(r => r.answer?.format?.[0] === 'Vlog' && r.costUsd === 0.01));
  assert.equal((await labeling.listTasks('pr_1')).length, 0);
  // Nothing saved under the version that exists either.
  assert.equal(Object.keys(await labeling.predictions(v.id, 'A', 'any')).length, 0);
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
  const {DocRepo} = await import('@tsp/platform');
  const docs = await new DocRepo(db).find('predictions', {promptVersionId: v.id});
  assert.equal(docs.length, 12, 'one saved prediction per example');
});

test('a Stop from another tab is seen during a long model call, and an old Stop is ignored', async () => {
  const {db, catalog, v, ids} = await setup(4, 'lab-stop');
  // A call that only ends when it is aborted.
  const gateway: LlmGatewayContract = {
    ...fakeGateway(async () => '{"format": "Vlog"}'),
    label: req =>
      new Promise((_, reject) => {
        const open = setTimeout(() => reject(new Error('never stopped')), 10_000); // like an open request
        req.signal?.addEventListener('abort', () => (clearTimeout(open), reject(new DOMException('Stopped', 'AbortError'))), {once: true});
      }),
  };
  const tab1 = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const tab2 = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const t = await tab1.createTask(input(ids, v));
  // A Stop pressed before this run started is not for it.
  await tab2.stopTask(t.id);
  const {DocRepo} = await import('@tsp/platform');
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
  const {REASON_LINE} = await import('@tsp/domain');
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
  assert.deepEqual(preds['ex_0']?.answer, {format: ['Vlog']});
  assert.equal(preds['ex_1']?.reason, undefined);
});

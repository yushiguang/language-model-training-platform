import assert from 'node:assert/strict';
import test from 'node:test';
import type {LabelCallRequest, LabelCallResult, LlmGatewayContract, Schema} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {localDocRuntime} from '@tsp/platform';
import {createLabeling} from './labeling.ts';
import {memoryLocks} from './locks.ts';

const schema: Schema = {policy: '', fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]};

async function setup(n: number, prefix: string) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  await catalog.insert('setup_versions', {id: 'sv_1', projectId: 'pr_1', number: 1, schemaVersion: 1, task: '', schema, thresholds: null, models: [], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  const v = await catalog.createPromptVersion({projectId: 'pr_1', template: 'Label {{Description}}', features: {video: ['Description'], photo_text: [], metadata: []}, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  const ids = Array.from({length: n}, (_, i) => `ex_${i}`);
  await catalog.insertMany('examples', ids.map((id, i) => ({id, snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, title: '', features: {Description: `post ${i}`}, split: 'train' as const, optimiserHalf: false})));
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
  assert.equal(preds.size, 30);
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

test('pauses when cost passes 120% of the budget', async () => {
  const {db, catalog, v, ids} = await setup(40, 'lab-5');
  const lab = createLabeling({db, catalog, gateway: fakeGateway(async () => '{"format": "Vlog"}'), locks: memoryLocks()});
  const t = await lab.createTask(input(ids, v, {budgetUsd: 0.1}));
  const r = await lab.runTask(t.id);
  assert.equal(r?.state, 'paused');
  assert.equal(r?.stopReason, 'budget');
  assert.ok((r?.done ?? 0) < 40);
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
  assert.equal((await labeling.predictions(v.id, 'A', 'any')).size, 0);
});

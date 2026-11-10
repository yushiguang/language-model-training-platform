import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, ProjectState, Schema} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {createLabeling, memoryLocks} from '@tsp/labeling';
import {DocRepo, localDocRuntime} from '@tsp/platform';
import {configureBff} from './app.ts';
import {loadProjectState} from './projects.ts';
import {agentStart} from './starts.ts';
import {scoreNewVersion, tick, waitingStarts} from './work.ts';

const schema: Schema = {policy: '', fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]};
/** Output price only, so every estimate is 150 tokens x $200/M = $0.03 per example. */
const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const EVAL = 10;

/** A bff over the real catalog and labeling apps, with a fake model that costs `perCall` per example. */
interface WorldOpts {
  autoStart?: boolean;
  perCall?: number;
  delayMs?: number;
  /** Test and train examples besides the 10 eval ones (external ids t0.., r0..). */
  test?: number;
  train?: number;
  /** The model's reply for an example (by external id), on its nth call. */
  answer?: (externalId: string, n: number) => string;
}

async function world(prefix: string, opts: WorldOpts = {}) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const calls = {n: 0};
  const seen = new Map<string, number>();
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    agentModel: () => {
      throw new Error('not used');
    },
    async label(req: {traceId?: string}): Promise<LabelCallResult> {
      calls.n++;
      const n = (seen.get(req.traceId ?? '') ?? 0) + 1;
      seen.set(req.traceId ?? '', n);
      await new Promise(r => setTimeout(r, opts.delayMs ?? 1));
      return {text: opts.answer?.(req.traceId ?? '', n) ?? '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: opts.perCall ?? 0.03, endpointId: 'labeling-A', attempts: 1};
    },
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  configureBff({
    catalog,
    labeling,
    gateway,
    agents: {} as AgentRuntimeContract,
    identity: {currentUser: async () => ({id: 'u_1', name: 'Tester'})},
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
  });
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema, thresholds: null, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, autoStart: opts.autoStart ?? true, createdAt: '', createdBy: ''});
  const nTest = opts.test ?? 0;
  const nTrain = opts.train ?? 0;
  const total = EVAL + nTest + nTrain;
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: total, valid: total, invalid: 0, video: total, photoText: 0}, split: {eval: EVAL, test: nTest, train: nTrain}});
  const ex = (key: string, split: 'eval' | 'test' | 'train') => ({id: `ex_${prefix}_${key}`, snapshotId: `ds_${prefix}`, externalId: key, type: 'video' as const, title: '', features: {}, split, optimiserHalf: false});
  await catalog.insertMany('examples', [
    ...Array.from({length: EVAL}, (_, i) => ex(String(i), 'eval')),
    ...Array.from({length: nTest}, (_, i) => ex(`t${i}`, 'test')),
    ...Array.from({length: nTrain}, (_, i) => ex(`r${i}`, 'train')),
  ]);
  await catalog.insert('projects', {id: projectId, name: 'p', createdAt: '', createdBy: '', setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: []});
  const newVersion = () => catalog.createPromptVersion({projectId, template: 'Label this', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  const state = async () => (await loadProjectState(projectId))!;
  return {db, catalog, labeling, projectId, calls, seen, newVersion, state};
}

async function until(cond: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const autoStarts = async (w: Awaited<ReturnType<typeof world>>) => (await w.catalog.find('audit_log', {projectId: w.projectId, action: 'auto_start'})).length;

test('Save with automatic starts off: nothing is labeled, the version waits for a click', async () => {
  const w = await world('b1', {autoStart: false});
  await w.newVersion();
  const r = await scoreNewVersion(w.projectId);
  assert.deepEqual(r, {started: [], waiting: ['A']});
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.calls.n, 0);
  assert.equal(await autoStarts(w), 0);
  assert.deepEqual(waitingStarts(await w.state()).map(d => `${d.what}:${d.reason}`), ['score:off']);
});

test('Save with automatic starts on: scored within the caps, audited, and counted as automatic spend', async () => {
  const w = await world('b2');
  await w.newVersion();
  const r = await scoreNewVersion(w.projectId);
  assert.deepEqual(r, {started: ['A'], waiting: []});
  await until(async () => (await w.state()).runs[0]?.state === 'done', 'scoring');
  const s = await w.state();
  assert.equal(w.calls.n, EVAL);
  assert.equal(await autoStarts(w), 1);
  assert.ok(Math.abs((s.runs[0].autoCostUsd ?? 0) - 0.3) < 1e-9);
});

test('a start that would take automatic spend past $5 asks, counting try_template spend', async () => {
  const w = await world('b3');
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_template', costUsd: 4.8});
  await w.newVersion();
  const r = await scoreNewVersion(w.projectId);
  assert.deepEqual(r, {started: [], waiting: ['A']});
  assert.equal(w.calls.n, 0);
  assert.deepEqual(waitingStarts(await w.state()).map(d => d.reason), ['over_project_cap']);
});

test("an automatic run pauses past 120% of its estimate, and resuming it asks", async () => {
  const w = await world('b4', {perCall: 0.1});
  await w.newVersion();
  await scoreNewVersion(w.projectId);
  await until(async () => (await w.state()).runs[0]?.state === 'paused', 'the budget pause');
  const s = await w.state();
  assert.ok(s.runs[0].overBudget);
  assert.ok(w.calls.n < EVAL, `stopped early (${w.calls.n} calls)`);
  await tick(s);
  await new Promise(r => setTimeout(r, 30));
  const calls = w.calls.n;
  assert.deepEqual(waitingStarts(await w.state()).map(d => `${d.what}:${d.reason}`), ['resume:paused_over_budget']);
  assert.equal(w.calls.n, calls, 'not resumed by itself');
});

test('an automatic resume of a task the user started counts toward the $5', async () => {
  const w = await world('b5');
  const v = await w.newVersion();
  const s0 = await w.state();
  // The user started scoring, and the page closed after 4 examples.
  const task = await w.labeling.createTask({projectId: w.projectId, purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id).slice(0, 4), createdBy: 'Tester'});
  await w.labeling.runTask(task.id, 'user');
  const all = await w.labeling.createTask({projectId: w.projectId, purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'Tester'});
  await new DocRepo(w.db).patch('labeling_tasks', all.id, {state: 'paused', stopReason: 'closed', done: 4});
  const before = await w.state();
  assert.deepEqual(waitingStarts(before), []);
  await tick(before);
  await until(async () => (await w.state()).runs.find(r => r.id === all.id)?.state === 'done', 'the resume');
  const s = await w.state();
  const run = s.runs.find(r => r.id === all.id)!;
  assert.equal(run.auto, false, 'created by the user');
  assert.ok(Math.abs((run.autoCostUsd ?? 0) - 0.18) < 1e-9, `the 6 resumed examples count (${run.autoCostUsd})`);
});

test('agent start tools reserve their estimate: two scorings at $4.50 spent cannot both start', async () => {
  // Slow model calls, so the first scoring is still going when the second is checked.
  const w = await world('b6', {delayMs: 20});
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_template', costUsd: 4.5});
  const v1 = await w.newVersion();
  const v2 = await w.newVersion();
  const cards: never[] = [];
  const a = (await agentStart(w.projectId, 'prompt_agent', 'score_version', {version: v1.id, model: 'A'}, cards)) as Record<string, unknown>;
  const b = (await agentStart(w.projectId, 'prompt_agent', 'score_version', {version: v2.id, model: 'A'}, cards)) as Record<string, unknown>;
  assert.equal(a.started, true);
  assert.equal(b.asked_user, true, 'the second one asks: $4.50 + $0.30 reserved + $0.30 > $5');
  assert.equal((cards as {reason: string}[])[0].reason, 'over_project_cap');
  const state: ProjectState = await w.state();
  assert.ok(state.versions.length === 2);
});

test('Approve on a start card that can no longer start leaves the card open with the reason', async () => {
  const w = await world('b7');
  const {answerStartCard} = await import('./starts.ts');
  const card = {tool: 'score_version', agent: 'prompt_agent', label: 'Score v9', estimateUsd: 0.3, args: {version: 'v9', model: 'A'}, reason: 'off', state: 'open'};
  await w.catalog.insert('chat_messages', {id: 'cm_b7', projectId: w.projectId, role: 'agent', agent: 'prompt_agent', text: '', page: null, createdAt: '', startCard: card} as never);
  await answerStartCard(w.projectId, 'cm_b7', true);
  const msg = await w.catalog.get('chat_messages', 'cm_b7');
  assert.equal(msg?.startCard?.state, 'open');
  const events = (await w.catalog.find('chat_messages', {projectId: w.projectId})).filter(m => m.role === 'event');
  assert.match(events[0].text, /Couldn't start: There is no version/);
});

test('Get model answers after a re-split with the same count labels the new test set', async () => {
  const w = await world('b8', {test: 3, train: 2});
  const {labelTestSet} = await import('./training.ts');
  const v = await w.newVersion();
  const first = await labelTestSet(w.projectId, v, 'A', 1);
  await until(async () => (await w.labeling.getTask(first.id))?.state === 'done', 'test answers');
  // Swap one test example for a train one: still 3 test examples, but not the same ones.
  await w.catalog.patch('examples', 'ex_b8_t2', {split: 'train'});
  await w.catalog.patch('examples', 'ex_b8_r0', {split: 'test'});
  const second = await labelTestSet(w.projectId, v, 'A', 1);
  assert.notEqual(second.id, first.id);
  assert.deepEqual([...second.exampleIds].sort(), ['ex_b8_r0', 'ex_b8_t0', 'ex_b8_t1']);
  await until(async () => (await w.labeling.getTask(second.id))?.state === 'done', 'new test answers');
  assert.equal(w.seen.get('r0'), 1, 'the new member was labeled');
  assert.equal(w.seen.get('t0'), 1, 'answers already saved are reused');
});

test('the final run labels a test example whose saved answer is invalid, when the user ticks it', async () => {
  // t1's first answer is not valid; its second is.
  const w = await world('b9', {test: 3, train: 2, answer: (id, n) => (id === 't1' && n === 1 ? 'not json' : '{"format": "Vlog"}')});
  const {labelTestSet, startTrainingSet, trainingRows} = await import('./training.ts');
  const v = await w.newVersion();
  const answers = await labelTestSet(w.projectId, v, 'A', 1);
  await until(async () => (await w.labeling.getTask(answers.id))?.state === 'done', 'test answers');
  const ts = await startTrainingSet(w.projectId, v, 'A', null, 1, {labelTest: true});
  assert.deepEqual([ts.testWithAnswers, ts.testToLabel], [2, 1]);
  await until(async () => (await w.labeling.getTask(ts.taskId))?.state === 'done', 'the final run');
  assert.equal(w.seen.get('t1'), 2);
  assert.equal(w.seen.get('t0'), 1);
  const rows = await trainingRows(ts.id);
  const t1 = rows.find(r => r.exampleId === 'ex_b9_t1')!;
  assert.equal(t1.labelSource, 'model');
  assert.ok(t1.answer);
  assert.equal(rows.filter(r => r.split === 'train').length, 2);
});

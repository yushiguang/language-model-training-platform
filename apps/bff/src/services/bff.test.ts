import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, ProjectState, Schema} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {createLabeling, memoryLocks} from '@tsp/labeling';
import {DocRepo, localDocRuntime} from '@tsp/platform';
import {configureBff} from './app.ts';
import {loadProjectState} from './projects.ts';
import {agentStart} from './starts.ts';
import {tick} from './work.ts';

const schema: Schema = {fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]};
/** Output price only, so every estimate is 150 tokens x $200/M = $0.03 per example. */
const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const EVAL = 10;

/** A bff over the real catalog and labeling apps, with a fake model that costs `perCall` per example. */
interface WorldOpts {
  perCall?: number;
  delayMs?: number;
  /** Test and train examples besides the 10 eval ones (external ids t0.., r0..). */
  test?: number;
  train?: number;
  /** The model's reply for an example (by external id), on its nth call. */
  answer?: (externalId: string, n: number, prompt: string) => string;
  /** Pass/fail bar on the lowest field Macro-F1 (no thresholds when missing). */
  macroF1?: number;
  /** Gold labels for the eval set, by external id. */
  gold?: (externalId: string) => string;
  agents?: AgentRuntimeContract;
}

async function world(prefix: string, opts: WorldOpts = {}) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const calls = {n: 0};
  const seen = new Map<string, number>();
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    agentModel: () => ({}),
    async label(req: {traceId?: string; messages?: unknown}): Promise<LabelCallResult> {
      calls.n++;
      const n = (seen.get(req.traceId ?? '') ?? 0) + 1;
      seen.set(req.traceId ?? '', n);
      await new Promise(r => setTimeout(r, opts.delayMs ?? 1));
      return {text: opts.answer?.(req.traceId ?? '', n, JSON.stringify(req.messages ?? '')) ?? '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: opts.perCall ?? 0.03, endpointId: 'labeling-A', attempts: 1};
    },
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  configureBff({
    catalog,
    labeling,
    gateway,
    agents: opts.agents ?? ({} as AgentRuntimeContract),
    identity: {currentUser: async () => ({id: 'u_1', name: 'Tester'})},
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
  });
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema, thresholds: opts.macroF1 == null ? null : {mode: 'custom', macroF1: opts.macroF1, valueF1: null, invalidRate: null, accuracy: null, minEval: EVAL}, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  const nTest = opts.test ?? 0;
  const nTrain = opts.train ?? 0;
  const total = EVAL + nTest + nTrain;
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: total, valid: total, invalid: 0, video: total, photoText: 0}, split: {eval: EVAL, test: nTest, train: nTrain}});
  const ex = (key: string, split: 'eval' | 'test' | 'train') => ({id: `ex_${prefix}_${key}`, snapshotId: `ds_${prefix}`, externalId: key, type: 'video' as const, title: '', features: {}, split, optimiserHalf: split === 'eval' && Number(key) % 2 === 0});
  await catalog.insertMany('examples', [
    ...Array.from({length: EVAL}, (_, i) => ex(String(i), 'eval')),
    ...Array.from({length: nTest}, (_, i) => ex(`t${i}`, 'test')),
    ...Array.from({length: nTrain}, (_, i) => ex(`r${i}`, 'train')),
  ]);
  if (opts.gold) {
    for (let i = 0; i < EVAL; i++)
      await catalog.insert('gold_labels', {id: `gl_${prefix}_${i}`, projectId, exampleId: `ex_${prefix}_${i}`, schemaVersion: 1, answer: {format: [opts.gold(String(i))]}, source: 'labeled', revealed: false, createdAt: '', createdBy: 'Tester'});
  }
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

test('Save: the new version is scored by itself, audited, and counted as automatic spend', async () => {
  const w = await world('b2');
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).runs[0]?.state === 'done', 'scoring');
  const s = await w.state();
  assert.equal(w.calls.n, EVAL);
  assert.equal(await autoStarts(w), 1);
  assert.ok(Math.abs((s.runs[0].autoCostUsd ?? 0) - 0.3) < 1e-9);
});

test('there is no cost limit: a start goes ahead after a lot of automatic spend, and a costly run is not paused', async () => {
  const w = await world('b3', {perCall: 0.5});
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_template', costUsd: 50});
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).runs[0]?.state === 'done', 'scoring');
  assert.equal(w.calls.n, EVAL, 'every example labeled, though each costs far more than the estimate');
});

test('an automatic resume of a task the user started counts as automatic spend', async () => {
  const w = await world('b5');
  const v = await w.newVersion();
  const s0 = await w.state();
  // The user started scoring, and the page closed after 4 examples.
  const task = await w.labeling.createTask({projectId: w.projectId, purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id).slice(0, 4), createdBy: 'Tester'});
  await w.labeling.runTask(task.id, 'user');
  const all = await w.labeling.createTask({projectId: w.projectId, purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'Tester'});
  await new DocRepo(w.db).patch('labeling_tasks', all.id, {state: 'paused', stopReason: 'closed', done: 4});
  const before = await w.state();
  await tick(before);
  await until(async () => (await w.state()).runs.find(r => r.id === all.id)?.state === 'done', 'the resume');
  const s = await w.state();
  const run = s.runs.find(r => r.id === all.id)!;
  assert.equal(run.auto, false, 'created by the user');
  assert.ok(Math.abs((run.autoCostUsd ?? 0) - 0.18) < 1e-9, `the 6 resumed examples count (${run.autoCostUsd})`);
});

test('agent start tools start at once, with no card, and leave an action line', async () => {
  const w = await world('b6', {delayMs: 20});
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_template', costUsd: 50});
  const v1 = await w.newVersion();
  const v2 = await w.newVersion();
  const a = (await agentStart(w.projectId, 'prompt_agent', 'score_version', {version: v1.id, model: 'A'})) as Record<string, unknown>;
  const b = (await agentStart(w.projectId, 'prompt_agent', 'score_version', {version: v2.id, model: 'A'})) as Record<string, unknown>;
  assert.equal(a.started, true);
  assert.equal(b.started, true);
  await until(async () => (await w.state()).runs.filter(r => r.state === 'done').length === 2, 'both scorings');
  const state: ProjectState = await w.state();
  const lines = await w.catalog.find('chat_messages', {projectId: state.project.id}, 'createdAt');
  assert.deepEqual(
    lines.map(m => [m.role, m.event, m.text.replace(/ on .*$/, '')]),
    [
      ['event', 'start', 'Prompt helper started scoring v1'],
      ['event', 'start', 'Prompt helper started scoring v2'],
    ],
  );
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

test('a helper that joined keeps answering on its page; on another page the page helper answers, with a line', async () => {
  const seen: string[] = [];
  // The front desk always hands off to the schema agent; a specialist answers itself.
  const agents = {
    async runAgentTurn(input, _llm, _tools, progress) {
      seen.push(`${input.page.agent}:${input.page.intent}`);
      if (input.page.agent === 'front_desk') {
        progress?.({message: {role: 'event', agent: null, event: 'join', text: 'Labels helper joined to answer'}});
        progress?.({agent: 'schema_agent', reply: 'Sure'});
        progress?.({message: {role: 'agent', agent: 'schema_agent', text: 'Sure.'}});
        return {invocations: [{from: 'user', to: 'front_desk', intent: 'answer', note: ''}, {from: 'front_desk', to: 'schema_agent', intent: 'revise_schema', note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
      }
      progress?.({message: {role: 'agent', agent: input.page.agent, text: 'Again.'}});
      return {invocations: [{from: 'user', to: input.page.agent, intent: input.page.intent, note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
    },
    reflectPrompt: async () => ({template: '', change: ''}),
    draftImprovement: async () => ({template: '', changes: [], reply: ''}),
  } satisfies AgentRuntimeContract;
  const w = await world('b12', {agents});
  const {sendUserMessage, answeringAgent, agentLive} = await import('./agents.ts');
  const gold = {label: 'Gold Labels', agent: 'front_desk' as const, intent: 'answer', context: {}, where: {page: 'gold' as const, params: {}}};
  const dataset = {...gold, label: 'Dataset', where: {page: 'dataset' as const, params: {}}};
  await sendUserMessage(w.projectId, 'add a value', gold);
  assert.equal(answeringAgent(w.projectId, gold), 'schema_agent');
  await sendUserMessage(w.projectId, 'and another', gold);
  assert.equal(answeringAgent(w.projectId, dataset), 'front_desk');
  await sendUserMessage(w.projectId, 'hello', dataset);
  assert.deepEqual(seen, ['front_desk:answer', 'schema_agent:follow_up', 'front_desk:answer']);
  assert.equal(agentLive(w.projectId), null, 'nothing is live after the turn');
  const chat = await w.catalog.find('chat_messages', {projectId: w.projectId}, 'createdAt');
  assert.deepEqual(
    chat.map(m => (m.role === 'event' ? `-- ${m.text}` : `${m.agent ?? 'user'}: ${m.text}`)),
    ['user: add a value', '-- Labels helper joined to answer', 'schema_agent: Sure.', 'user: and another', 'schema_agent: Again.', '-- Assistant answers on Dataset', 'user: hello', '-- Labels helper joined to answer', 'schema_agent: Sure.'],
  );
});

/** Gold: Tutorial on 0-7, Vlog on 8-9. The model is right on example i when i < 5 x (rule lines). */
const goldOf = (id: string) => (Number(id) < 8 ? 'Tutorial' : 'Vlog');
const ruled = (id: string, _n: number, prompt: string) => {
  const k = (prompt.match(/RULE/g) ?? []).length;
  return JSON.stringify({format: Number(id) < 5 * k ? goldOf(id) : 'Vlog'});
};
// The Optimiser's picks (parent, dry-run examples) are fixed in these tests: in order, focus first.
const {setOptimiserRandom} = await import('./optimiser.ts');
setOptimiserRandom(() => 0);

const ruleAgent = (fail: {left: number} = {left: 0}): AgentRuntimeContract => ({
  runAgentTurn: async () => ({invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []}),
  async reflectPrompt(input) {
    if (fail.left > 0) {
      fail.left--;
      throw new Error('boom');
    }
    const k = (input.template.match(/RULE/g) ?? []).length + 1;
    return {template: `${input.template}\nRULE ${k}`, change: `rule ${k}`};
  },
  draftImprovement: async input => ({template: input.template, changes: [], reply: ''}),
});

test('Auto Optimise: dry run, full labeling, stops when a version passes; versions are minors of the run major', async () => {
  const w = await world('b20', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, train: 3, test: 1});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 10);
  const s = await w.state();
  const run = s.optimisation[0];
  assert.equal(run.state, 'done');
  assert.equal(run.stopReason, 'passes');
  assert.equal(run.major, 2);
  assert.deepEqual(
    run.history.map(h => [h.round, h.outcome, h.kind]),
    [
      [1, 'kept', 'change'],
      [2, 'kept', 'change'],
    ],
    'the start version is dominated once v2.1 is kept, so round 2 builds on v2.1',
  );
  assert.ok(run.history.every(h => h.dryRun && h.dryRun.passed > h.dryRun.parentPassed && h.dryRun.examples === 2));
  assert.deepEqual(s.versions.map(v => `${v.major}.${v.minor}`), ['2.2', '2.1', '1.0']);
  assert.ok(s.reports.some(r => r.promptVersionId === run.history[1].versionId && r.passed));
  const lines = (await w.catalog.find('chat_messages', {projectId: w.projectId}, 'createdAt')).map(m => m.text);
  assert.ok(lines.includes('Workflow started the training and test sets with v2.2'), lines.join('\n'));
  assert.ok(run.trainingSetId, 'the training set started with the passing version');
  assert.equal(s.trainingSets[0]?.promptVersionId, run.history[1].versionId);
});

test('Auto Optimise: a change that is no better in the dry run is dropped, unlabeled; 3 in a row end the run', async () => {
  const agents = ruleAgent();
  agents.reflectPrompt = async input => ({template: `${input.template}\nNOTE ${Math.random()}`, change: 'a note'});
  const w = await world('b21', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 10);
  const s = await w.state();
  const run = s.optimisation[0];
  assert.equal(run.stopReason, 'no_new_ideas');
  assert.deepEqual(run.history.map(h => h.outcome), ['dropped', 'dropped', 'dropped']);
  assert.equal(s.reports.length, 1, 'only the start version is scored');
  // Each dropped change was labeled on the dry-run examples only.
  assert.equal(w.calls.n, EVAL + 3 * 2);
});

test('Auto Optimise: a step that fails 3 times fails the run with the step named; Retry goes on', async () => {
  const fail = {left: 3};
  const w = await world('b22', {agents: ruleAgent(fail), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser, retryOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 10);
  let run = (await w.state()).optimisation[0];
  assert.equal(run.state, 'failed');
  assert.equal(run.error, 'Writing a change to v1 failed after 3 tries: boom');
  assert.deepEqual(run.history.map(h => [h.outcome, h.step]), [['failed', 'reflect']]);
  await retryOptimiser(run.id);
  run = (await w.state()).optimisation[0];
  assert.equal(run.state, 'done');
  assert.equal(run.stopReason, 'passes');
  assert.deepEqual(run.history.map(h => h.outcome), ['kept', 'kept']);
});

test('Auto Optimise: the round limit ends the run', async () => {
  const w = await world('b23', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 1);
  const run = (await w.state()).optimisation[0];
  assert.equal(run.stopReason, 'max_rounds');
  assert.equal(run.round, 1);
});

test('Auto Optimise starts from the chosen version, and the helper reads wrong examples of the optimiser half only', async () => {
  const agents = ruleAgent();
  const inputs: Parameters<AgentRuntimeContract['reflectPrompt']>[0][] = [];
  const reflect = agents.reflectPrompt;
  agents.reflectPrompt = async (input, ...rest) => (inputs.push(input), reflect(input, ...rest));
  const w = await world('b24', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  const v1 = await w.newVersion();
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 1, v1.id);
  const run = (await w.state()).optimisation[0];
  assert.equal(run.startVersionId, v1.id);
  assert.equal(run.history[0].parentId, v1.id);
  const ex = inputs[0].examples ?? [];
  assert.ok(ex.length > 0 && ex.length <= 8);
  assert.ok(
    ex.every(e => Number(e.externalId) % 2 === 0),
    'held-out examples never reach the helper',
  );
  assert.ok(ex.every(e => e.predicted?.format?.[0] !== e.gold.format?.[0]));
});

test('Auto Optimise: a pass is confirmed by labeling the held-out half again before the final labeling', async () => {
  const w = await world('b25', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, train: 3, test: 1});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 10);
  const run = (await w.state()).optimisation[0];
  assert.equal(run.stopReason, 'passes');
  assert.deepEqual(run.history.at(-1)?.confirm, {score: 1, passed: true});
  // Each held-out example was labeled twice for the passing version.
  const heldOut = ['1', '3', '5', '7', '9'];
  assert.ok(heldOut.every(id => (w.seen.get(id) ?? 0) >= 2));
});

test('Auto Optimise: a pass that the second labeling does not confirm does not end the run', async () => {
  // The held-out half is right the first time it is asked, wrong after (a lucky pass).
  const asked = new Map<string, number>();
  const lucky = (id: string, n: number, prompt: string) => {
    const k = `${id}|${prompt}`;
    asked.set(k, (asked.get(k) ?? 0) + 1);
    return Number(id) % 2 === 1 && asked.get(k)! > 1 ? JSON.stringify({format: goldOf(id) === 'Vlog' ? 'Tutorial' : 'Vlog'}) : ruled(id, n, prompt);
  };
  const w = await world('b26', {agents: ruleAgent(), answer: lucky, macroF1: 0.99, gold: goldOf, train: 3, test: 1});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 3);
  const s = await w.state();
  const run = s.optimisation[0];
  assert.notEqual(run.stopReason, 'passes');
  const passed = run.history.filter(h => h.passed);
  assert.ok(passed.length > 0 && passed.every(h => h.confirm?.passed === false));
  assert.equal(run.trainingSetId, null);
  assert.equal(s.trainingSets.length, 0);
});

test('read_doc: a link that cannot be opened says so, so the helper asks for the text', async () => {
  const w = await world('b28');
  const {agentTools} = await import('./page-views.ts');
  const out = (await agentTools(w.projectId).call({agent: 'schema_agent', name: 'read_doc', args: {url: 'https://docs.example.com/docx/abc'}})) as {error?: string};
  assert.match(out.error ?? '', /cannot be opened/);
});

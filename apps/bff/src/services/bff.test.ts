import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, ProjectState, Schema, StructuredPrompt} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {createLabeling, memoryLocks} from '@tsp/labeling';
import {createOptimiser} from '@tsp/optimiser';
import {DocRepo, localDocRuntime} from '@tsp/platform';
import {configureBff, emitChange} from './app.ts';
import {optimiserHost} from './optimiser-host.ts';
import {agentProgress} from './agents.ts';
import {loadProjectState} from './projects.ts';
import {agentStart} from './starts.ts';
import {tick} from './work.ts';
import {compilePrompt, DEFAULT_THRESHOLDS, versionLabel} from '@tsp/domain';

const schema: Schema = {fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]};
/** Output price only, so every estimate is 150 tokens x $200/M = $0.03 per example. */
const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const EVAL = 10;
/** A structured prompt over the test labels; `rules` become its general rules. */
const sp = (rules = ''): StructuredPrompt => ({taskSummary: 'Label this', features: {video: ['Description'], photo_text: [], metadata: []}, fields: schema.fields.map(f => ({...f, values: f.values.map(v => ({...v}))})), generalRules: rules, images: []});

/** A bff over the real catalog and labeling apps, with a fake model that costs `perCall` per example. */
interface WorldOpts {
  perCall?: number;
  delayMs?: number;
  /** The model's reply for an example (by external id), on its nth call. */
  answer?: (externalId: string, n: number, prompt: string) => string;
  /** Pass/fail bar on the lowest field Macro-F1 (no thresholds when missing). */
  macroF1?: number;
  /** Gold labels for the eval set, by external id (default: Vlog everywhere); null: none. */
  gold?: ((externalId: string) => string) | null;
  agents?: AgentRuntimeContract;
  /** Project Settings confirmed (default true). */
  confirmed?: boolean;
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
  const agents = opts.agents ?? ({} as AgentRuntimeContract);
  const optimiser = createOptimiser({catalog, labeling, agents, host: optimiserHost(), onChange: emitChange, random: () => optimiserRandom()});
  configureBff({
    catalog,
    labeling,
    gateway,
    agents,
    optimiser,
    identity: {currentUser: async () => ({id: 'u_1', name: 'Tester'})},
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
  });
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema, thresholds: opts.macroF1 == null ? null : {mode: 'custom', macroF1: opts.macroF1, valueF1: null, invalidRate: null, accuracy: null, minEval: EVAL}, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: EVAL, valid: EVAL, invalid: 0, video: EVAL, photoText: 0}, split: {eval: EVAL, test: 0, train: 0}});
  await catalog.insertMany('examples', Array.from({length: EVAL}, (_, i) => ({id: `ex_${prefix}_${i}`, snapshotId: `ds_${prefix}`, externalId: String(i), type: 'video' as const, title: '', features: {}, split: 'eval' as const, optimiserHalf: i % 2 === 0})));
  const gold = opts.gold === undefined ? () => 'Vlog' : opts.gold;
  if (gold) {
    for (let i = 0; i < EVAL; i++)
      await catalog.insert('gold_labels', {id: `gl_${prefix}_${i}`, projectId, exampleId: `ex_${prefix}_${i}`, schemaVersion: 1, answer: {format: [gold(String(i))]}, source: 'labeled', revealed: false, createdAt: '', createdBy: 'Tester'});
  }
  await catalog.insert('projects', {id: projectId, name: 'p', createdAt: '', createdBy: '', kind: 'prompt_tuning', settingsConfirmed: opts.confirmed ?? true, setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: []});
  const newVersion = (rules = '') => {
    const structured = sp(rules);
    return catalog.createPromptVersion({projectId, structured, template: compilePrompt(structured), features: structured.features, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  };
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
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_prompt', costUsd: 50});
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
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_prompt', costUsd: 50});
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

test('nothing is scored by itself until Project Settings are confirmed and enough gold labels exist (spec 2.5)', async () => {
  const unconfirmed = await world('b8', {confirmed: false});
  const first = await unconfirmed.newVersion();
  // The helpers' start tools keep the same guardrails (review 2026-11-13).
  await assert.rejects(agentStart(unconfirmed.projectId, 'prompt_agent', 'score_version', {version: first.id}), /Project Settings are not confirmed/);
  await tick(await unconfirmed.state());
  await new Promise(r => setTimeout(r, 30));
  assert.equal(unconfirmed.calls.n, 0);
  // Saving the settings is the confirmation; the next check starts scoring.
  const {saveSettings} = await import('./settings.ts');
  const s = await unconfirmed.state();
  await saveSettings(unconfirmed.projectId, {thresholds: DEFAULT_THRESHOLDS, model: s.setup!.models[0]});
  assert.equal((await unconfirmed.state()).facts.settingsConfirmed, true);
  await tick(await unconfirmed.state());
  await until(async () => (await unconfirmed.state()).runs[0]?.state === 'done', 'scoring after the confirmation');

  const noGold = await world('b9', {gold: null});
  const nv = await noGold.newVersion();
  await assert.rejects(agentStart(noGold.projectId, 'prompt_agent', 'start_optimiser', {}), /gold-labeled eval examples/);
  await assert.rejects(agentStart(noGold.projectId, 'prompt_agent', 'score_version', {version: nv.id}), /gold-labeled eval examples/);
  await tick(await noGold.state());
  await new Promise(r => setTimeout(r, 30));
  assert.equal(noGold.calls.n, 0);
});

test('a new project starts with default settings, unconfirmed; v1 sets the labels and the helper says what is next', async () => {
  const w = await world('b10');
  const {createProject} = await import('./projects.ts');
  const {createVersion} = await import('./prompts.ts');
  const p = await createProject('Fresh');
  let s = (await loadProjectState(p.id))!;
  assert.equal(s.project.kind, 'prompt_tuning');
  assert.equal(s.facts.settingsConfirmed, false);
  assert.deepEqual([s.setup?.thresholds?.mode, s.setup?.thresholds?.macroF1, s.setup?.models[0].endpoint, s.setup?.models[0].maxOutputTokens, s.setup?.schema], ['default', 0.8, 'A', 1024, null]);
  await assert.rejects(createVersion(p.id, {structured: {...sp(), features: {video: [], photo_text: [], metadata: []}}, parent: null, madeBy: 'user', change: '', kind: 'major'}), /at least one input feature/);
  const v1 = await createVersion(p.id, {structured: sp(), parent: null, madeBy: 'user', change: 'First prompt', kind: 'major'});
  s = (await loadProjectState(p.id))!;
  assert.equal(s.setup?.schemaVersion, 1);
  assert.deepEqual(s.setup?.schema?.fields.map(f => f.name), ['format']);
  // The text the model reads is compiled from the parts: features, the field's values, the output keys.
  assert.match(v1.template, /Description: \{\{Description\}\}[\s\S]*format[\s\S]*Vlog[\s\S]*Return JSON only/);
  const chat = await w.catalog.find('chat_messages', {projectId: p.id}, 'createdAt');
  assert.match(chat.at(-1)!.text, /v1 is saved\. Next, click "Next: Eval Dataset" at the top right/);
  assert.equal(chat.at(-1)!.agent, 'prompt_agent');

  // New wording: a new version, the same labels, gold labels stand.
  const reworded = sp('When unsure, choose Vlog.');
  reworded.fields[0].values[0].definition = 'a day in a life';
  const v2 = await createVersion(p.id, {structured: reworded, parent: v1, madeBy: 'user', change: '', kind: 'minor'});
  s = (await loadProjectState(p.id))!;
  assert.equal(v2.schemaVersion, 1);
  assert.equal(s.setup?.schema?.fields[0].values[0].definition, 'a day in a life');
  // A new value changes the label signature: the schema version goes up.
  const wider = sp();
  wider.fields[0].values.push({name: 'Clip', definition: ''});
  const v3 = await createVersion(p.id, {structured: wider, parent: v2, madeBy: 'user', change: '', kind: 'major'});
  assert.equal(v3.schemaVersion, 2);
  // The Optimiser may not do that.
  const widest = sp();
  widest.fields[0].values.push({name: 'Clip', definition: ''}, {name: 'Skit', definition: ''});
  await assert.rejects(createVersion(p.id, {structured: widest, parent: v3, madeBy: 'optimiser', change: '', kind: 'minor'}), /may not change the label fields/);
});

test('Delete project removes its records everywhere and leaves other projects alone', async () => {
  const w = await world('b11');
  const v = await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const {createProject, deleteProject, listProjects} = await import('./projects.ts');
  const {createVersion} = await import('./prompts.ts');
  const other = await createProject('Other');
  await createVersion(other.id, {structured: sp(), parent: null, madeBy: 'user', change: '', kind: 'major'});
  await deleteProject(w.projectId);
  assert.equal(await loadProjectState(w.projectId), null);
  assert.deepEqual((await listProjects()).map(p => p.id), [other.id]);
  for (const kind of ['prompt_versions', 'eval_reports', 'gold_labels', 'chat_messages', 'setup_versions'] as const) assert.equal((await w.catalog.find(kind, {projectId: w.projectId})).length, 0, kind);
  assert.equal((await w.catalog.find('examples', {snapshotId: 'ds_b11'})).length, 0);
  assert.equal((await w.labeling.listTasks(w.projectId)).length, 0);
  assert.equal(Object.keys(await w.labeling.predictions(v.id, 'A', 'x')).length, 0);
  assert.equal((await w.catalog.find('prompt_versions', {projectId: other.id})).length, 1);
  await assert.rejects(deleteProject(w.projectId), /does not exist/);
});

test('a helper that joined keeps answering on its page; on another page the page helper answers, with a line', async () => {
  const seen: string[] = [];
  // The front desk always hands off to the Prompt helper; a specialist answers itself.
  const agents = {
    async runTurn(input) {
      // The runtime publishes progress through the port it was built with (spec 7.1.3).
      const progress = (e: Parameters<typeof agentProgress.publish>[2]) => agentProgress.publish(input.workspace.projectId, input.turnId, e);
      seen.push(`${input.page.agent}:${input.page.intent}`);
      if (input.page.agent === 'front_desk') {
        progress?.({message: {role: 'event', agent: null, event: 'join', text: 'Prompt helper joined to answer'}});
        progress?.({agent: 'prompt_agent', reply: 'Sure'});
        progress?.({message: {role: 'agent', agent: 'prompt_agent', text: 'Sure.'}});
        return {invocations: [{from: 'user', to: 'front_desk', intent: 'answer', note: ''}, {from: 'front_desk', to: 'prompt_agent', intent: 'revise_prompt', note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
      }
      progress?.({message: {role: 'agent', agent: input.page.agent, text: 'Again.'}});
      return {invocations: [{from: 'user', to: input.page.agent, intent: input.page.intent, note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
    },
    reflectPrompt: async () => ({prompt: sp(), change: ''}),
    draftImprovement: async () => ({prompt: sp(), changes: [], reply: ''}),
    cancel: async () => {},
  } satisfies AgentRuntimeContract;
  const w = await world('b12', {agents});
  const {sendUserMessage, answeringAgent, agentLive} = await import('./agents.ts');
  const gold = {label: 'Gold Labels', agent: 'front_desk' as const, intent: 'answer', context: {}, where: {page: 'gold' as const, params: {}}};
  const dataset = {...gold, label: 'Dataset', where: {page: 'dataset' as const, params: {}}};
  await sendUserMessage(w.projectId, 'add a value', gold);
  assert.equal(answeringAgent(w.projectId, gold), 'prompt_agent');
  await sendUserMessage(w.projectId, 'and another', gold);
  assert.equal(answeringAgent(w.projectId, dataset), 'front_desk');
  await sendUserMessage(w.projectId, 'hello', dataset);
  assert.deepEqual(seen, ['front_desk:answer', 'prompt_agent:follow_up', 'front_desk:answer']);
  assert.equal(agentLive(w.projectId), null, 'nothing is live after the turn');
  const chat = await w.catalog.find('chat_messages', {projectId: w.projectId}, 'createdAt');
  assert.deepEqual(
    chat.map(m => (m.role === 'event' ? `-- ${m.text}` : `${m.agent ?? 'user'}: ${m.text}`)),
    ['user: add a value', '-- Prompt helper joined to answer', 'prompt_agent: Sure.', 'user: and another', 'prompt_agent: Again.', '-- Assistant answers on Dataset', 'user: hello', '-- Prompt helper joined to answer', 'prompt_agent: Sure.'],
  );
});

/** Gold: Tutorial on 0-7, Vlog on 8-9. The model is right on example i when i < 5 x (rule lines). */
const goldOf = (id: string) => (Number(id) < 8 ? 'Tutorial' : 'Vlog');
const ruled = (id: string, _n: number, prompt: string) => {
  const k = (prompt.match(/RULE/g) ?? []).length;
  return JSON.stringify({format: Number(id) < 5 * k ? goldOf(id) : 'Vlog'});
};
// The Optimiser's picks (parent, dry-run examples) are fixed in these tests: in order, focus first.
let optimiserRandom = () => 0;

const ruleAgent = (fail: {left: number} = {left: 0}): AgentRuntimeContract => ({
  runTurn: async () => ({invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []}),
  cancel: async () => {},
  async reflectPrompt(input) {
    if (fail.left > 0) {
      fail.left--;
      throw new Error('boom');
    }
    const k = (input.prompt.generalRules.match(/RULE/g) ?? []).length + 1;
    return {prompt: {...input.prompt, generalRules: `${input.prompt.generalRules}\nRULE ${k}`.trim()}, change: `rule ${k}`};
  },
  draftImprovement: async input => ({prompt: input.prompt, changes: [], reply: ''}),
});

test('Auto Optimise: dry run, full labeling, stops when a version passes; versions are minors of the run major', async () => {
  const w = await world('b20', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
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
});

test('Auto Optimise: a change that is no better in the dry run is dropped, unlabeled; 3 in a row end the run', async () => {
  const agents = ruleAgent();
  agents.reflectPrompt = async input => ({prompt: {...input.prompt, generalRules: `${input.prompt.generalRules}\nNOTE ${Math.random()}`.trim()}, change: 'a note'});
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
  agents.reflectPrompt = async input => (inputs.push(input), reflect(input));
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
  const w = await world('b25', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 10);
  const run = (await w.state()).optimisation[0];
  assert.equal(run.stopReason, 'passes');
  assert.deepEqual(run.history.at(-1)?.confirm, {score: 1, passed: true});
  // The helpers read it on the report (the Scores helper recommends a version only when its pass holds).
  const {agentTools} = await import('./page-views.ts');
  const s = await w.state();
  const label = (id: string | null) => versionLabel(s.versions.find(v => v.id === id)!);
  const rep = (v: string) => agentTools(w.projectId).call({agent: 'evaluation_agent', name: 'get_report', args: {version: v}}) as Promise<{report: {confirmed: boolean | null}}>;
  assert.equal((await rep(label(run.history.at(-1)!.versionId))).report.confirmed, true);
  assert.equal((await rep(label(run.startVersionId))).report.confirmed, null, 'no second labeling for the start version');
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
  const w = await world('b26', {agents: ruleAgent(), answer: lucky, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.projectId, 3);
  const s = await w.state();
  const run = s.optimisation[0];
  assert.notEqual(run.stopReason, 'passes');
  const passed = run.history.filter(h => h.passed);
  assert.ok(passed.length > 0 && passed.every(h => h.confirm?.passed === false));
  const {agentTools} = await import('./page-views.ts');
  const ref = versionLabel(s.versions.find(v => v.id === passed[0].versionId)!);
  const rep = (await agentTools(w.projectId).call({agent: 'evaluation_agent', name: 'get_report', args: {version: ref}})) as {report: {passed: boolean; confirmed: boolean | null}};
  assert.deepEqual([rep.report.passed, rep.report.confirmed], [true, false], 'the report says the pass was not confirmed');
});

test('read_doc: a link that cannot be opened says so, so the helper asks for the text', async () => {
  const w = await world('b28');
  const {agentTools} = await import('./page-views.ts');
  const out = (await agentTools(w.projectId).call({agent: 'prompt_agent', name: 'read_doc', args: {url: 'https://docs.example.com/docx/abc'}})) as {error?: string};
  assert.match(out.error ?? '', /cannot be opened/);
});

test('Mismatches: versions with answers on the whole eval set, wrong in the most versions first; keep or change leaves the list, and is recorded', async () => {
  // v1 answers Vlog everywhere; v2 (one RULE) is right on 0-4. Gold: Tutorial on 0-7, Vlog on 8-9.
  const w = await world('b30', {answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  await w.newVersion('RULE 1');
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 2, 'v2 scored');
  const {mismatches, reviewGold} = await import('./mismatches.ts');
  const s = await w.state();
  const id = (k: number) => `ex_b30_${k}`;
  let m = await mismatches(w.projectId);
  assert.equal(m.versions.length, 2);
  const best = s.versions[0];
  assert.equal(m.versionId, best.id, 'the best scored version is compared by default');
  assert.deepEqual(m.items.map(x => x.exampleId), [5, 6, 7].map(id), 'v2 is wrong on 5-7');
  assert.ok(m.items.every(x => x.wrongIn === 2 && x.of === 2));
  assert.equal(m.wrongEverywhere, 3);
  const v1 = s.versions[1].id;
  m = await mismatches(w.projectId, v1);
  assert.deepEqual(m.items.map(x => x.exampleId), [5, 6, 7, 0, 1, 2, 3, 4].map(id), 'examples wrong in both versions come first');
  await reviewGold(w.projectId, id(5), best.id, 'kept');
  await reviewGold(w.projectId, id(6), best.id, 'changed', {format: ['Vlog']});
  m = await mismatches(w.projectId);
  assert.deepEqual(m.items.map(x => x.exampleId), [id(7)]);
  assert.equal(m.reviewed, 2);
  const after = await w.state();
  assert.deepEqual(after.gold[id(6)]!.answer, {format: ['Vlog']});
  assert.equal(after.gold[id(5)]!.id, s.gold[id(5)]!.id, 'keeping a label saves no new label');
  const log = await w.catalog.find('audit_log', {projectId: w.projectId, action: 'gold.review'});
  assert.deepEqual(log.map(l => (l.data as {outcome: string}).outcome).sort(), ['changed', 'kept']);

  // R4-5 (2026-11-11): a review belongs to a gold label and a version. v1 still lists 5 (reviewed
  // for v2 only); 6 now has v1's answer as its label, so it is no mismatch for v1.
  m = await mismatches(w.projectId, v1);
  assert.deepEqual(m.items.map(x => x.exampleId).sort(), [5, 7, 0, 1, 2, 3, 4].map(id).sort());
  assert.equal(m.reviewed, 0);
  assert.equal(m.reviewedAll, 2);
  m = await mismatches(w.projectId);
  assert.deepEqual(
    m.reviewedItems.map(r => [r.exampleId, r.outcome]).sort(),
    [
      [id(5), 'kept'],
      [id(6), 'model'],
    ],
  );
  await reviewGold(w.projectId, id(5), best.id, 'kept', undefined, '  Its own words  ');
  // 1.0.0 (spec 5.4): the "Why" is now a comment on the example, kept with the version.
  let cs = (await w.state()).comments[id(5)] ?? [];
  assert.deepEqual(cs.map(c => [c.text, c.promptVersionId]), [['Its own words', best.id]]);
  // R6-3: editing a reviewed item appends a review; the newest stands, the rest is its history.
  await reviewGold(w.projectId, id(5), best.id, 'kept', undefined, 'Looked again');
  m = await mismatches(w.projectId);
  assert.equal(m.reviewed, 2);
  const five = m.reviewedItems.find(r => r.exampleId === id(5))!;
  assert.equal(five.earlier?.length, 2);
  // Comments are append-only: both stay, oldest first.
  cs = (await w.state()).comments[id(5)] ?? [];
  assert.deepEqual(cs.map(c => c.text), ['Its own words', 'Looked again']);

  // R5-4, R5-5: a gold change archives the reports; they are rebuilt from saved answers in one go.
  await reviewGold(w.projectId, id(7), best.id, 'changed', {format: ['Vlog']});
  let st = await w.state();
  assert.equal(st.scoresUpdating, true);
  assert.equal(st.reports.filter(r => !r.archivedNow).length, 0);
  // 2026-11-12: nothing rebuilds by itself; Rebuild scores on Prompt versions does, by hand.
  const tasksBefore = (await w.state()).runs.length;
  await tick(st);
  const {getPageView} = await import('./page-views.ts');
  await getPageView(w.projectId, {page: 'prompt', params: {}});
  assert.equal((await w.state()).scoresUpdating, true, 'neither the workflow check nor a reader rebuilds');
  const {rebuildReports} = await import('./mismatches.ts');
  assert.equal(await rebuildReports(w.projectId), 2);
  st = await w.state();
  assert.equal(st.scoresUpdating, false);
  assert.equal(st.reports.filter(r => !r.archivedNow).length, 2);
  assert.equal(st.runs.length, tasksBefore, 'nothing is labeled again');
  // Pressed again with nothing changed (say after a Setup change): each report is replaced, not doubled.
  const ids = st.reports.map(r => r.id).sort();
  assert.equal(await rebuildReports(w.projectId), 2);
  st = await w.state();
  assert.equal(st.reports.filter(r => !r.archivedNow).length, 2);
  assert.notDeepEqual(st.reports.map(r => r.id).sort(), ids);
});

test('Finding 3: no helper tool or helper input carries an example of the held-out half', async () => {
  const agents = ruleAgent();
  const improve: Parameters<AgentRuntimeContract['draftImprovement']>[0][] = [];
  agents.draftImprovement = async input => (improve.push(input), {prompt: input.prompt, changes: [], reply: ''});
  const w = await world('b31', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const s = await w.state();
  const heldOut = new Set(s.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).flatMap(e => [e.externalId, e.id]));
  assert.equal(heldOut.size, 10);
  const {agentTools} = await import('./page-views.ts');
  const tools = agentTools(w.projectId);
  const call = (name: string, args: Record<string, unknown> = {}) => tools.call({agent: 'prompt_agent', name: name as 'get_examples', args});
  const leaks = (x: unknown) => [...heldOut].filter(id => new RegExp(`"(id|externalId|exampleId)":"${id}"`).test(JSON.stringify(x)));

  const ex = (await call('get_examples', {split: 'eval', limit: 10})) as {total: number; note?: string};
  assert.equal(ex.total, 5);
  assert.match(ex.note ?? '', /held-out/);
  assert.deepEqual(leaks(ex), []);
  const byId = (await call('get_examples', {ids: ['1', '2']})) as {total: number};
  assert.equal(byId.total, 1, 'asking for a held-out example by id gives nothing');
  const gold = (await call('get_gold_labels', {split: 'eval', limit: 20})) as {labeled: number};
  assert.equal(gold.labeled, 5);
  assert.deepEqual(leaks(gold), []);
  const preds = (await call('get_predictions', {version: 'v1', model: 'A', limit: 20})) as {matching: number};
  assert.equal(preds.matching, 5);
  assert.deepEqual(leaks(preds), []);
  const report = (await call('get_report', {version: 'v1'})) as {report: {topMixUps: object[]}};
  assert.ok(report.report.topMixUps.length > 0 && report.report.topMixUps.every(m => !('examples' in m)), 'mix-ups as counts only');
  const tried = (await call('try_prompt', {n: 5})) as {rows: {id: string}[]};
  assert.equal(tried.rows.length, 5);
  assert.deepEqual(leaks(tried), []);

  const {improveWithAi} = await import('./agents.ts');
  await improveWithAi(w.projectId, s.versions[0].id);
  const input = improve[0];
  assert.ok(input.examples && input.examples.length > 0);
  assert.deepEqual(leaks(input), [], 'examples and mix-ups come from the optimiser half');
  assert.ok(input.mixUps.every(m => m.exampleIds.every(id => !heldOut.has(id))));
});

test('R4-4: the labeler\'s Why reaches the helpers for optimiser-half examples only', async () => {
  const agents = ruleAgent();
  const improve: Parameters<AgentRuntimeContract['draftImprovement']>[0][] = [];
  agents.draftImprovement = async input => (improve.push(input), {prompt: input.prompt, changes: [], reply: ''});
  const w = await world('b33', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const s = await w.state();
  const v = s.versions[0].id;
  const {mismatches, reviewGold, labelComments} = await import('./mismatches.ts');
  const wrong = new Set((await mismatches(w.projectId, v)).items.map(x => x.exampleId));
  const evalEx = s.examples.filter(e => e.split === 'eval' && wrong.has(e.id));
  const mine = evalEx.find(e => e.optimiserHalf)!;
  const held = evalEx.find(e => !e.optimiserHalf)!;
  assert.ok(mine && held);
  await reviewGold(w.projectId, mine.id, v, 'kept', undefined, 'Shown at work, so it is a Tutorial');
  await reviewGold(w.projectId, held.id, v, 'kept', undefined, 'A held-out note');
  const notes = await labelComments(w.projectId, (await w.state())!);
  assert.deepEqual([...notes], [[mine.id, ['Shown at work, so it is a Tutorial']]]);
  const {improveWithAi} = await import('./agents.ts');
  await improveWithAi(w.projectId, v);
  const briefs = improve[0].examples ?? [];
  assert.deepEqual(briefs.find(b => b.externalId === mine.externalId)?.comments, ['Shown at work, so it is a Tutorial']);
  assert.ok(!JSON.stringify(improve[0]).includes('A held-out note'));
});

test("Auto Optimise: the pool holds the user's other scored versions too, and the helper reads the model's reasons", async () => {
  const agents = ruleAgent();
  const inputs: Parameters<AgentRuntimeContract['reflectPrompt']>[0][] = [];
  const reflect = agents.reflectPrompt;
  agents.reflectPrompt = async input => (inputs.push(input), reflect(input));
  // The model gives its reason with every answer.
  const reasoned = (id: string, n: number, prompt: string) => JSON.stringify({reason: `why ${id}`, ...JSON.parse(ruled(id, n, prompt))});
  const w = await world('b32', {agents, answer: reasoned, macroF1: 0.99, gold: goldOf});
  const v1 = await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  // The user's own v1.1 has one rule: right on 0-4, where v1 is not. It is not part of any run.
  const mine = await w.newVersion('RULE 1');
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 2, 'the user version scored');
  const {startOptimiser} = await import('./work.ts');
  optimiserRandom = () => 0.99; // the last version of the front
  try {
    await startOptimiser(w.projectId, 2, v1.id);
  } finally {
    optimiserRandom = () => 0;
  }
  const run = (await w.state()).optimisation[0];
  assert.equal(run.startVersionId, v1.id);
  // R5-7: round 1 starts from the version the user picked; later rounds roam the front.
  assert.equal(run.history[0].parentId, v1.id, 'round 1 starts from the version the user picked');
  assert.equal(run.history[0].parentWins, null);
  assert.equal(run.history[1]?.parentId, mine.id, "the user's version is picked as a later parent");
  assert.ok((run.history[1].parentWins ?? 0) > 0, 'a later parent says on how many examples it is best');
  const ex = inputs[0].examples ?? [];
  assert.ok(ex.length > 0 && ex.every(e => e.reason === `why ${e.externalId}`), "each wrong example carries the model's reason");
});

// ---------------------------------------------------------------------------------------------
// 1.0.0 phase 3: eval dataset governance (spec sections 4 and 5).

test('appending examples keeps every score current: new ones are pending, and existing halves and gold labels stay', async () => {
  const w = await world('g1', {macroF1: 0.5});
  await w.newVersion();
  await tick(await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const before = await w.state();
  const halves = Object.fromEntries(before.examples.map(e => [e.id, e.optimiserHalf]));
  const {appendExamples} = await import('./governance.ts');
  const raws = Array.from({length: 6}, (_, i) => ({externalId: `new-${i}`, type: 'video' as const, title: '', features: {}}));
  // One id is already in the dataset: it is skipped.
  const r = await appendExamples(w.projectId, [...raws, {externalId: '0', type: 'video', title: '', features: {}}], 'upload');
  assert.deepEqual(r, {added: 6, duplicates: 1});
  const s = await w.state();
  assert.equal(s.examples.length, EVAL + 6);
  for (const e of before.examples) assert.equal(s.examples.find(x => x.id === e.id)?.optimiserHalf, halves[e.id], 'no existing example moves');
  assert.equal(s.examples.filter(e => e.externalId.startsWith('new-') && e.optimiserHalf).length, 3, 'new examples split evenly');
  assert.equal(s.reports[0].archivedNow, false, 'unlabeled examples do not make a score stale');
  assert.equal(s.examples.filter(e => !s.gold[e.id]).length, 6, 'six examples wait for gold labels');
  // A gold label on a new example does make the score stale (Rebuild scores brings it back).
  const {saveGold} = await import('./dataset.ts');
  await saveGold(w.projectId, s.examples.find(e => e.externalId === 'new-0')!.id, 1, {format: ['Vlog']}, false);
  assert.equal((await w.state()).reports[0].archivedNow, true);
});

test('removing examples leaves a trail with half and gold label, moves no other example, and can be undone', async () => {
  const w = await world('g2');
  const s0 = await w.state();
  const halves = Object.fromEntries(s0.examples.map(e => [e.id, e.optimiserHalf]));
  const {removeExamples, restoreExamples, pruneDataset} = await import('./governance.ts');
  const target = s0.examples[3];
  assert.equal(await removeExamples(w.projectId, [target.id], 'broken'), 1);
  let s = await w.state();
  assert.equal(s.examples.length, EVAL - 1);
  assert.equal(s.removals.length, 1);
  assert.deepEqual({half: s.removals[0].half, gold: s.removals[0].gold, reason: s.removals[0].reason, by: s.removals[0].removedBy}, {half: target.optimiserHalf ? 'optimiser' : 'held_out', gold: {format: ['Vlog']}, reason: 'broken', by: 'Tester'});
  for (const e of s.examples) assert.equal(e.optimiserHalf, halves[e.id]);
  await restoreExamples(w.projectId, [s.removals[0].id]);
  s = await w.state();
  assert.equal(s.examples.length, EVAL);
  assert.equal(s.removals.length, 0, 'a restored removal is no longer listed');
  assert.equal(s.examples.find(e => e.id === target.id)?.optimiserHalf, target.optimiserHalf, 'restored in its own half');
  // Downsampling a value keeps K of it, evenly from both halves.
  assert.equal(await pruneDataset(w.projectId, 'downsample', 4, 'format', 'Vlog'), EVAL - 4);
  s = await w.state();
  assert.equal(s.examples.length, 4);
  assert.equal(s.examples.filter(e => e.optimiserHalf).length, 2);
  assert.ok(s.removals.every(r => r.reason === 'downsample'));
});

test('halves: balanced by gold label until a helper reads examples, then locked; a held-out example never moves', async () => {
  const w = await world('g3', {gold: id => (id === '1' || id === '3' ? 'Tutorial' : 'Vlog')});
  // Examples 1 and 3 (the only Tutorials) start in the same half.
  const s0 = await w.state();
  assert.equal(s0.examples.find(e => e.externalId === '1')?.optimiserHalf, s0.examples.find(e => e.externalId === '3')?.optimiserHalf);
  const {balanceHalves, lockHoldout, appendExamples} = await import('./governance.ts');
  await balanceHalves(w.projectId);
  let s = await w.state();
  const tut = s.examples.filter(e => e.externalId === '1' || e.externalId === '3');
  assert.deepEqual(tut.map(e => e.optimiserHalf).sort(), [false, true], 'the rare value lands in both halves');
  assert.equal(s.examples.filter(e => e.optimiserHalf).length, EVAL / 2);
  await lockHoldout(w.projectId);
  const locked = Object.fromEntries(s.examples.map(e => [e.id, e.optimiserHalf]));
  // New gold labels after the lock move nothing.
  const {saveGold} = await import('./dataset.ts');
  await saveGold(w.projectId, s.examples.find(e => e.externalId === '5')!.id, 1, {format: ['Tutorial']}, false);
  assert.equal(await balanceHalves(w.projectId), 0);
  await appendExamples(w.projectId, [{externalId: 'n1', type: 'video', title: '', features: {}}], 'sample');
  s = await w.state();
  for (const e of s.examples) if (e.id in locked) assert.equal(e.optimiserHalf, locked[e.id]);
  assert.equal(s.project.holdoutLocked, true);
});

test('comments are append-only, cut to the limit, and reach helpers only for the readable half', async () => {
  const w = await world('g4');
  const s0 = await w.state();
  const {addComment} = await import('./governance.ts');
  const {labelComments} = await import('./mismatches.ts');
  const mine = s0.examples.find(e => e.optimiserHalf)!;
  const held = s0.examples.find(e => !e.optimiserHalf)!;
  await addComment(w.projectId, mine.id, '  first  ');
  await addComment(w.projectId, mine.id, 'x'.repeat(900));
  await addComment(w.projectId, held.id, 'held-out words');
  await assert.rejects(addComment(w.projectId, mine.id, '   '), /empty/);
  const s = await w.state();
  assert.deepEqual(s.comments[mine.id].map(c => c.text.length), [5, 500]);
  assert.equal(s.comments[mine.id][0].authorName, 'Tester');
  const seen = await labelComments(w.projectId, s);
  assert.deepEqual([...seen.keys()], [mine.id]);
});

test('the first read of examples by a helper locks the halves', async () => {
  const w = await world('g5');
  const {agentTools} = await import('./page-views.ts');
  assert.equal((await w.state()).project.holdoutLocked, undefined);
  await agentTools(w.projectId).call({agent: 'prompt_agent', name: 'get_dataset_stats', args: {}});
  assert.equal((await w.state()).project.holdoutLocked, undefined, 'counts only: no lock');
  const found = (await agentTools(w.projectId).call({agent: 'prompt_agent', name: 'search_examples', args: {text: ' '}}).catch(e => e)) as Error;
  assert.match(found.message, /words/);
  assert.equal((await w.state()).project.holdoutLocked, true);
});

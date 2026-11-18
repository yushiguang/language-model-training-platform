import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, AgentToolRequest, ClientDiagnostics, RequestContext, SharedStatePort, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, ProjectState, Schema, StructuredPrompt, TicketPort, TicketSubmission} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, labelingExecutor, memoryLocks} from '@yushiguang/sprint-labeling';
import {createOptimiser, optimiserExecutor} from '@yushiguang/sprint-optimiser';
import {DocRepo, localDocRuntime, memoryJobStore, memorySharedState} from '@yushiguang/sprint-platform';
import {createJobs} from '@yushiguang/sprint-jobs';
import {createInstance, systemContext} from './app.ts';
import {optimiserHost} from './optimiser-host.ts';
import {workflowExecutors} from './executors.ts';
import {agentProgress} from './agents.ts';
import {deleteProject, loadProjectState, projectStatus, renameProject} from './projects.ts';
import {addComment} from './governance.ts';
import {reportProblem} from './problems.ts';
import {beginTurn, endTurn, turnOf} from './turns.ts';
import {agentToolHost} from './page-views.ts';
import {agentStart} from './starts.ts';
import {scoreVersion, tick} from './work.ts';
import {compilePrompt, DEFAULT_THRESHOLDS, versionLabel} from '@yushiguang/sprint-domain';

const schema: Schema = {name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]};
/** Output price only, so every estimate is 150 tokens x $200/M = $0.03 per example. */
const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const EVAL = 10;
/** A structured prompt over the test labels; `rules` become its general rules. */
/** The prompt's rules as one text, and a prompt with one rule group holding that text. */
const rulesOf = (p: StructuredPrompt) => p.ruleGroups.map(g => g.content).join('\n');
const withRules = (p: StructuredPrompt, rules: string): StructuredPrompt => ({...p, ruleGroups: rules ? [{id: 'rg1', title: 'Rules', content: rules}] : []});
const sp = (rules = ''): StructuredPrompt => ({taskSummary: 'Label this', features: {video: ['Description'], photo_text: [], metadata: []}, label: {name: schema.name, kind: 'single', values: schema.values.map(v => ({...v}))}, ruleGroups: rules ? [{id: 'rg1', title: 'Rules', content: rules}] : [], images: []});

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
  goldApproved?: boolean;
  /** Where problem reports go (none: reports cannot be sent). */
  tickets?: TicketPort;
  sharedState?: SharedStatePort;
  /** The job module's wait before a retry (default its own). */
  retryDelayMs?: number;
}

/** The helpers' tools on the world's project, with no turn: calls run as the world's caller. */
function toolsOf(w: {inst: Parameters<typeof agentToolHost>[0]; projectId: string; ws: {ctx: RequestContext}}) {
  const host = agentToolHost(w.inst);
  return {call: (r: AgentToolRequest) => host.call({...r, projectId: w.projectId, turnId: null, ctx: w.ws.ctx})};
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
    cancel: async () => {},
    async label(req: {traceId?: string; messages?: unknown}): Promise<LabelCallResult> {
      calls.n++;
      const n = (seen.get(req.traceId ?? '') ?? 0) + 1;
      seen.set(req.traceId ?? '', n);
      await new Promise(r => setTimeout(r, opts.delayMs ?? 1));
      return {text: opts.answer?.(req.traceId ?? '', n, JSON.stringify(req.messages ?? '')) ?? '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: opts.perCall ?? 0.03, endpointId: 'labeling-A', attempts: 1};
    },
  } as unknown as LlmGatewayContract;
  // Labeling's writes reach the workflow's change events and revisions, as in the browser build.
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks(), onChange: id => inst.emitChange(id ?? null)});
  const agents = opts.agents ?? ({} as AgentRuntimeContract);
  // Background work runs through the job module, in this process, as in the browser build.
  const jobs = createJobs({store: memoryJobStore(), ...(opts.retryDelayMs ? {retryDelayMs: opts.retryDelayMs} : {})});
  const inst = createInstance({
    jobs: jobs.api,
    catalog,
    labeling,
    gateway,
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
    tickets: opts.tickets,
    appVersion: '1.1.0-test',
    sharedState: opts.sharedState ?? memorySharedState(),
  });
  const optimiser = createOptimiser({catalog, labeling, agents, host: optimiserHost(inst.scope(systemContext('optimiser'))), onChange: inst.emitChange, random: () => optimiserRandom()});
  inst.connect({agents, optimiser});
  for (const e of [labelingExecutor(labeling), optimiserExecutor(optimiser), ...workflowExecutors(inst)]) jobs.register(e);
  /** The scope the tests act in: one signed-in user. */
  const ws = inst.scope({requestId: 'rq_test', user: {id: 'u_1', name: 'Tester'}, caller: 'test'});
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema, thresholds: opts.macroF1 == null ? null : {mode: 'custom', macroF1: opts.macroF1, valueF1: null, invalidRate: null, accuracy: null, minEval: EVAL}, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: EVAL, valid: EVAL, invalid: 0, video: EVAL, photoText: 0}, split: {eval: EVAL, test: 0, train: 0}});
  await catalog.insertMany('examples', Array.from({length: EVAL}, (_, i) => ({id: `ex_${prefix}_${i}`, snapshotId: `ds_${prefix}`, externalId: String(i), type: 'video' as const, title: '', features: {}, split: 'eval' as const, optimiserHalf: i % 2 === 0})));
  const gold = opts.gold === undefined ? () => 'Vlog' : opts.gold;
  if (gold) {
    for (let i = 0; i < EVAL; i++)
      await catalog.insert('gold_labels', {id: `gl_${prefix}_${i}`, projectId, exampleId: `ex_${prefix}_${i}`, schemaVersion: 1, answer: [gold(String(i))], source: 'labeled', revealed: false, createdAt: '', createdBy: 'Tester'});
  }
  await catalog.insert('projects', {id: projectId, name: 'p', createdAt: '', createdBy: '', kind: 'prompt_tuning', settingsConfirmed: opts.confirmed ?? true, setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: opts.goldApproved === false ? [] : ['prompt_design', 'dataset', 'gold']});
  const newVersion = (rules = '') => {
    const structured = sp(rules);
    return catalog.createPromptVersion({projectId, structured, template: compilePrompt(structured), features: structured.features, images: [], madeBy: 'user', change: '', schemaVersion: 1, parentId: null, kind: 'minor'});
  };
  const state = async () => (await loadProjectState(ws, projectId))!;
  return {db, catalog, labeling, projectId, calls, seen, newVersion, state, inst, ws, jobs};
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
  await tick(w.ws, await w.state());
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
  await tick(w.ws, await w.state());
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
  await tick(w.ws, before);
  await until(async () => (await w.state()).runs.find(r => r.id === all.id)?.state === 'done', 'the resume');
  const s = await w.state();
  const run = s.runs.find(r => r.id === all.id)!;
  assert.equal(run.auto, false, 'created by the user');
  assert.ok(Math.abs((run.autoCostUsd ?? 0) - 0.18) < 1e-9, `the 6 resumed examples count (${run.autoCostUsd})`);
});

test('two paused tasks of one version and model both resume in one check, each as itself (#25)', async () => {
  const w = await world('b5b');
  const v = await w.newVersion();
  const s0 = await w.state();
  const make = (ids: string[]) => w.labeling.createTask({projectId: w.projectId, purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: ids, createdBy: 'Tester'});
  const all = await make(s0.examples.map(e => e.id));
  const subset = await make(s0.examples.map(e => e.id).slice(0, 3));
  const repo = new DocRepo(w.db);
  for (const t of [all, subset]) await repo.patch('labeling_tasks', t.id, {state: 'paused', stopReason: 'closed'});
  await tick(w.ws, await w.state());
  const queued = (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']})).map(j => j.args.taskId).sort();
  assert.deepEqual(queued, [all.id, subset.id].sort());
  await until(async () => (await w.state()).runs.every(r => r.state === 'done'), 'both resumes');
  assert.equal((await w.state()).runs.length, 2, 'no new task was made');
});

test('agent start tools start at once, with no card, and leave an action line', async () => {
  const w = await world('b6', {delayMs: 20});
  await w.catalog.audit(w.projectId, 'system', 'auto_spend', {what: 'try_prompt', costUsd: 50});
  const v1 = await w.newVersion();
  const v2 = await w.newVersion();
  const a = (await agentStart(w.ws, w.projectId, 'prompt_agent', 'score_version', {version: v1.id, model: 'A'})) as Record<string, unknown>;
  const b = (await agentStart(w.ws, w.projectId, 'prompt_agent', 'score_version', {version: v2.id, model: 'A'})) as Record<string, unknown>;
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
  await assert.rejects(agentStart(unconfirmed.ws, unconfirmed.projectId, 'prompt_agent', 'score_version', {version: first.id}), /Project Settings are not confirmed/);
  await tick(unconfirmed.ws, await unconfirmed.state());
  await new Promise(r => setTimeout(r, 30));
  assert.equal(unconfirmed.calls.n, 0);
  // Saving the settings is the confirmation; the next check starts scoring.
  const {saveSettings} = await import('./settings.ts');
  const s = await unconfirmed.state();
  await saveSettings(unconfirmed.ws, unconfirmed.projectId, {thresholds: DEFAULT_THRESHOLDS, model: s.setup!.models[0]});
  assert.equal((await unconfirmed.state()).facts.settingsConfirmed, true);
  await tick(unconfirmed.ws, await unconfirmed.state());
  await until(async () => (await unconfirmed.state()).runs[0]?.state === 'done', 'scoring after the confirmation');

  const noGold = await world('b9', {gold: null});
  const nv = await noGold.newVersion();
  await assert.rejects(agentStart(noGold.ws, noGold.projectId, 'prompt_agent', 'start_optimiser', {}), /gold-labeled eval examples/);
  await assert.rejects(agentStart(noGold.ws, noGold.projectId, 'prompt_agent', 'score_version', {version: nv.id}), /gold-labeled eval examples/);
  await tick(noGold.ws, await noGold.state());
  await new Promise(r => setTimeout(r, 30));
  assert.equal(noGold.calls.n, 0);
});

test('a new project starts with default settings, unconfirmed; v1 sets the labels and the helper says what is next', async () => {
  const w = await world('b10');
  const {createProject} = await import('./projects.ts');
  const {createVersion} = await import('./prompts.ts');
  const p = await createProject(w.ws, 'Fresh');
  let s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(s.project.kind, 'prompt_tuning');
  assert.equal(s.facts.settingsConfirmed, false);
  assert.deepEqual([s.setup?.thresholds?.mode, s.setup?.thresholds?.macroF1, s.setup?.models[0].endpoint, s.setup?.models[0].maxOutputTokens, s.setup?.schema], ['default', 0.8, 'A', 1024, null]);
  await assert.rejects(createVersion(w.ws, p.id, {structured: {...sp(), features: {video: [], photo_text: [], metadata: []}}, parent: null, madeBy: 'user', change: '', kind: 'major'}), /at least one input feature/);
  const v1 = await createVersion(w.ws, p.id, {structured: sp(), parent: null, madeBy: 'user', change: 'First prompt', kind: 'major'});
  s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(s.setup?.schemaVersion, 1);
  assert.equal(s.setup?.schema?.name, 'format');
  // The text the model reads is compiled from the parts: features, the label's values, the output key.
  assert.match(v1.template, /<feature name="Description">\{\{Description\}\}<\/feature>[\s\S]*<output_labels name="format"[\s\S]*Vlog[\s\S]*Return one JSON object only/);
  const chat = await w.catalog.find('chat_messages', {projectId: p.id}, 'createdAt');
  assert.match(chat.at(-1)!.text, /v1 is saved\. Next, click "Next: Eval Dataset" at the top right/);
  assert.equal(chat.at(-1)!.agent, 'prompt_agent');

  // New wording: a new version, the same labels, gold labels stand.
  const reworded = sp('When unsure, choose Vlog.');
  reworded.label.values[0].definition = 'a day in a life';
  const v2 = await createVersion(w.ws, p.id, {structured: reworded, parent: v1, madeBy: 'user', change: '', kind: 'minor'});
  s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(v2.schemaVersion, 1);
  assert.equal(s.setup?.schema?.values[0].definition, 'a day in a life');
  // A new value changes the label signature: the schema version goes up.
  const wider = sp();
  wider.label.values.push({name: 'Clip', definition: ''});
  const v3 = await createVersion(w.ws, p.id, {structured: wider, parent: v2, madeBy: 'user', change: '', kind: 'major'});
  assert.equal(v3.schemaVersion, 2);
  // The Optimiser may not do that.
  const widest = sp();
  widest.label.values.push({name: 'Clip', definition: ''}, {name: 'Skit', definition: ''});
  await assert.rejects(createVersion(w.ws, p.id, {structured: widest, parent: v3, madeBy: 'optimiser', change: '', kind: 'minor'}), /may not change the label or its values/);
});

test('Delete project removes its records everywhere and leaves other projects alone', async () => {
  const w = await world('b11');
  const v = await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const {createProject, deleteProject, listProjects} = await import('./projects.ts');
  const {createVersion} = await import('./prompts.ts');
  const other = await createProject(w.ws, 'Other');
  await createVersion(w.ws, other.id, {structured: sp(), parent: null, madeBy: 'user', change: '', kind: 'major'});
  await deleteProject(w.ws, w.projectId);
  // Accepted: the project is gone from every read at once; its records go in the background.
  assert.equal(await loadProjectState(w.ws, w.projectId), null);
  assert.deepEqual((await listProjects(w.ws)).map(p => p.id), [other.id]);
  await w.jobs.idle();
  assert.equal(await w.catalog.get('projects', w.projectId), null);
  for (const kind of ['prompt_versions', 'eval_reports', 'gold_labels', 'chat_messages', 'setup_versions'] as const) assert.equal((await w.catalog.find(kind, {projectId: w.projectId})).length, 0, kind);
  assert.equal((await w.catalog.find('examples', {snapshotId: 'ds_b11'})).length, 0);
  assert.equal((await w.labeling.listTasks(w.projectId)).length, 0);
  assert.equal(Object.keys(await w.labeling.predictions(v.id, 'A', 'x')).length, 0);
  assert.equal((await w.catalog.find('prompt_versions', {projectId: other.id})).length, 1);
  await assert.rejects(deleteProject(w.ws, w.projectId), /does not exist/);
});

test('Delete project mid-run: the running labeling ends first, so no answer or task is left behind (#24)', async () => {
  const w = await world('b11b', {delayMs: 30});
  const v = await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).runs[0]?.done >= 1, 'scoring under way');
  const {deleteProject, runDelete} = await import('./projects.ts');
  await deleteProject(w.ws, w.projectId);
  await w.jobs.idle();
  assert.equal((await w.labeling.listTasks(w.projectId)).length, 0);
  const repo = new DocRepo(w.db);
  assert.equal((await repo.find('predictions' as never, {})).length, 0);
  assert.equal(Object.keys(await w.labeling.predictions(v.id, 'A', 'x')).length, 0);
  // Safe to run again, and an answer a late runner elsewhere saved is found by its project.
  await repo.insert('predictions' as never, {id: 'pd_late', projectId: w.projectId, promptVersionId: v.id, endpoint: 'A', settingsHash: 'h', exampleId: 'ex_b11b_0', output: '', answer: null, invalidReason: null, costUsd: 0, createdAt: ''});
  await runDelete(w.ws, {id: 'job_again', projectId: w.projectId} as never);
  assert.equal((await repo.find('predictions' as never, {})).length, 0);
});

test('a helper that joined keeps answering on its page; on another page the page helper answers, with a line', async () => {
  const seen: string[] = [];
  // The front desk always hands off to the Prompt helper; a specialist answers itself.
  const agents = {
    async runTurn(input) {
      // The runtime publishes progress through the port it was built with (spec 7.1.3).
      const progress = (e: Parameters<ReturnType<typeof agentProgress>['publish']>[2]) => agentProgress(w.inst).publish(input.workspace.projectId, input.turnId, e);
      seen.push(`${input.page.agent}:${input.page.intent}`);
      if (input.page.agent === 'front_desk') {
        await progress({message: {role: 'event', agent: null, event: 'join', text: 'Prompt helper joined to answer'}});
        await progress({agent: 'prompt_agent', reply: 'Sure'});
        await progress({message: {role: 'agent', agent: 'prompt_agent', text: 'Sure.'}});
        return {invocations: [{from: 'user', to: 'front_desk', intent: 'answer', note: ''}, {from: 'front_desk', to: 'prompt_agent', intent: 'revise_prompt', note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
      }
      await progress({message: {role: 'agent', agent: input.page.agent, text: 'Again.'}});
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
  await sendUserMessage(w.ws, w.projectId, 'add a value', gold);
  await w.inst.turnsIdle();
  assert.equal(await answeringAgent(w.ws, w.projectId, gold), 'prompt_agent');
  await sendUserMessage(w.ws, w.projectId, 'and another', gold);
  await w.inst.turnsIdle();
  assert.equal(await answeringAgent(w.ws, w.projectId, dataset), 'front_desk');
  await sendUserMessage(w.ws, w.projectId, 'hello', dataset);
  await w.inst.turnsIdle();
  assert.deepEqual(seen, ['front_desk:answer', 'prompt_agent:follow_up', 'front_desk:answer']);
  assert.equal(await agentLive(w.ws, w.projectId), null, 'nothing is live after the turn');
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
    const k = (rulesOf(input.prompt).match(/RULE/g) ?? []).length + 1;
    return {prompt: withRules(input.prompt, `${rulesOf(input.prompt)}\nRULE ${k}`.trim()), change: `rule ${k}`};
  },
  draftImprovement: async input => ({prompt: input.prompt, changes: [], reply: ''}),
});

test('Auto Optimise: dry run, full labeling, stops when a version passes; versions are minors of the run major', async () => {
  const w = await world('b20', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
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

test('Auto Optimise: a tie in the dry run goes on to full labeling; 3 with no gain on the optimiser half end the run', async () => {
  const agents = ruleAgent();
  agents.reflectPrompt = async input => ({prompt: withRules(input.prompt, `${rulesOf(input.prompt)}\nNOTE ${Math.random()}`.trim()), change: 'a note'});
  const w = await world('b21', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  const s = await w.state();
  const run = s.optimisation[0];
  assert.equal(run.stopReason, 'no_new_ideas');
  assert.deepEqual(run.history.map(h => [h.outcome, h.gain, h.tied]), [
    ['kept', false, true],
    ['kept', false, true],
    ['kept', false, true],
  ]);
  assert.equal(s.reports.length, 4, 'each tied change is scored on the whole eval set');
});

test('Auto Optimise: a change that scores lower in the dry run is dropped, unlabeled', async () => {
  const agents = ruleAgent();
  // A rule the fake model reads as "answer Vlog everywhere": worse than the start version.
  agents.reflectPrompt = async input => ({prompt: withRules(input.prompt, `${rulesOf(input.prompt)}\nWORSE ${Math.random()}`.trim()), change: 'a worse rule'});
  const gold = (id: string) => (Number(id) % 2 ? 'Tutorial' : 'Vlog');
  const worse = (id: string, _n: number, prompt: string) => JSON.stringify({format: prompt.includes('WORSE') ? 'Vlog' : Number(id) < 6 ? gold(id) : 'Tutorial'});
  const w = await world('b21b', {agents, answer: worse, macroF1: 0.999, gold});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  const s = await w.state();
  const run = s.optimisation[0];
  assert.equal(run.stopReason, 'no_new_ideas');
  assert.deepEqual(run.history.map(h => h.outcome), ['dropped', 'dropped', 'dropped']);
  assert.ok(run.history.every(h => h.dryRun!.score! < h.dryRun!.parentScore!));
  assert.equal(s.reports.length, 1, 'only the start version is scored');
});

test('Auto Optimise: a step that fails 3 times fails the run with the step named; Retry goes on', async () => {
  const fail = {left: 3};
  const w = await world('b22', {agents: ruleAgent(fail), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser, retryOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  let run = (await w.state()).optimisation[0];
  assert.equal(run.state, 'failed');
  assert.equal(run.error, 'Writing a change to v1 failed after 3 tries: boom');
  assert.deepEqual(run.history.map(h => [h.outcome, h.step]), [['failed', 'reflect']]);
  // Another project's id reaches no run of this one (review G2).
  const {stopOptimiser} = await import('./work.ts');
  await assert.rejects(retryOptimiser(w.ws, 'pr_other', run.id), /does not exist/);
  await assert.rejects(stopOptimiser(w.ws, 'pr_other', run.id), /does not exist/);
  await retryOptimiser(w.ws, w.projectId, run.id);
  await w.jobs.idle();
  run = (await w.state()).optimisation[0];
  assert.equal(run.state, 'done');
  assert.equal(run.stopReason, 'passes');
  assert.deepEqual(run.history.map(h => h.outcome), ['kept', 'kept']);
});

test('Auto Optimise: the round limit ends the run', async () => {
  const w = await world('b23', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 1);
  await w.jobs.idle();
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
  await startOptimiser(w.ws, w.projectId, 1, v1.id);
  await w.jobs.idle();
  const run = (await w.state()).optimisation[0];
  assert.equal(run.startVersionId, v1.id);
  assert.equal(run.history[0].parentId, v1.id);
  const ex = inputs[0].examples ?? [];
  assert.ok(ex.length > 0 && ex.length <= 8);
  assert.ok(
    ex.every(e => Number(e.externalId) % 2 === 0),
    'held-out examples never reach the helper',
  );
  assert.ok(ex.every(e => e.predicted !== e.gold));
});

test('Auto Optimise: a pass is confirmed by labeling the held-out half again before the final labeling', async () => {
  const w = await world('b25', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  const run = (await w.state()).optimisation[0];
  assert.equal(run.stopReason, 'passes');
  assert.deepEqual(run.history.at(-1)?.confirm, {score: 1, passed: true});
  // The helpers read it on the report (the Scores helper recommends a version only when its pass holds).
  const s = await w.state();
  const label = (id: string | null) => versionLabel(s.versions.find(v => v.id === id)!);
  const rep = (v: string) => toolsOf(w).call({agent: 'evaluation_agent', name: 'get_report', args: {version: v}}) as Promise<{report: {confirmed: boolean | null}}>;
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
  await startOptimiser(w.ws, w.projectId, 3);
  await w.jobs.idle();
  const s = await w.state();
  const run = s.optimisation[0];
  assert.notEqual(run.stopReason, 'passes');
  const passed = run.history.filter(h => h.passed);
  assert.ok(passed.length > 0 && passed.every(h => h.confirm?.passed === false));
  const ref = versionLabel(s.versions.find(v => v.id === passed[0].versionId)!);
  const rep = (await toolsOf(w).call({agent: 'evaluation_agent', name: 'get_report', args: {version: ref}})) as {report: {passed: boolean; confirmed: boolean | null}};
  assert.deepEqual([rep.report.passed, rep.report.confirmed], [true, false], 'the report says the pass was not confirmed');
});

test('read_doc: a link that cannot be opened says so, so the helper asks for the text', async () => {
  const w = await world('b28');
  const out = (await toolsOf(w).call({agent: 'prompt_agent', name: 'read_doc', args: {url: 'https://docs.example.com/docx/abc'}})) as {error?: string};
  assert.match(out.error ?? '', /cannot be opened/);
});

test('Mismatches: versions with answers on the whole eval set, wrong in the most versions first; keep or change leaves the list, and is recorded', async () => {
  // v1 answers Vlog everywhere; v2 (one RULE) is right on 0-4. Gold: Tutorial on 0-7, Vlog on 8-9.
  const w = await world('b30', {answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  await w.newVersion('RULE 1');
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 2, 'v2 scored');
  const {mismatches, reviewGold} = await import('./mismatches.ts');
  const s = await w.state();
  const id = (k: number) => `ex_b30_${k}`;
  let m = await mismatches(w.ws, w.projectId);
  assert.equal(m.versions.length, 2);
  const best = s.versions[0];
  assert.equal(m.versionId, best.id, 'the best scored version is compared by default');
  assert.deepEqual(m.items.map(x => x.exampleId), [5, 6, 7].map(id), 'v2 is wrong on 5-7');
  assert.ok(m.items.every(x => x.wrongIn === 2 && x.of === 2));
  assert.equal(m.wrongEverywhere, 3);
  const v1 = s.versions[1].id;
  m = await mismatches(w.ws, w.projectId, v1);
  assert.deepEqual(m.items.map(x => x.exampleId), [5, 6, 7, 0, 1, 2, 3, 4].map(id), 'examples wrong in both versions come first');
  await reviewGold(w.ws, w.projectId, id(5), best.id, 'kept');
  await reviewGold(w.ws, w.projectId, id(6), best.id, 'changed', ['Vlog']);
  m = await mismatches(w.ws, w.projectId);
  assert.deepEqual(m.items.map(x => x.exampleId), [id(7)]);
  assert.equal(m.reviewed, 2);
  const after = await w.state();
  assert.deepEqual(after.gold[id(6)]!.answer, ['Vlog']);
  assert.equal(after.gold[id(5)]!.id, s.gold[id(5)]!.id, 'keeping a label saves no new label');
  const log = await w.catalog.find('audit_log', {projectId: w.projectId, action: 'gold.review'});
  assert.deepEqual(log.map(l => (l.data as {outcome: string}).outcome).sort(), ['changed', 'kept']);

  // R4-5 (2026-11-11): a review belongs to a gold label and a version. v1 still lists 5 (reviewed
  // for v2 only); 6 now has v1's answer as its label, so it is no mismatch for v1.
  m = await mismatches(w.ws, w.projectId, v1);
  assert.deepEqual(m.items.map(x => x.exampleId).sort(), [5, 7, 0, 1, 2, 3, 4].map(id).sort());
  assert.equal(m.reviewed, 0);
  assert.equal(m.reviewedAll, 2);
  m = await mismatches(w.ws, w.projectId);
  assert.deepEqual(
    m.reviewedItems.map(r => [r.exampleId, r.outcome]).sort(),
    [
      [id(5), 'kept'],
      [id(6), 'model'],
    ],
  );
  await reviewGold(w.ws, w.projectId, id(5), best.id, 'kept', undefined, '  Its own words  ');
  // 1.0.0 (spec 5.4): the "Why" is now a comment on the example, kept with the version.
  let cs = (await w.state()).comments[id(5)] ?? [];
  assert.deepEqual(cs.map(c => [c.text, c.promptVersionId]), [['Its own words', best.id]]);
  // R6-3: editing a reviewed item appends a review; the newest stands, the rest is its history.
  await reviewGold(w.ws, w.projectId, id(5), best.id, 'kept', undefined, 'Looked again');
  m = await mismatches(w.ws, w.projectId);
  assert.equal(m.reviewed, 2);
  const five = m.reviewedItems.find(r => r.exampleId === id(5))!;
  assert.equal(five.earlier?.length, 2);
  // Comments are append-only: both stay, oldest first.
  cs = (await w.state()).comments[id(5)] ?? [];
  assert.deepEqual(cs.map(c => c.text), ['Its own words', 'Looked again']);

  // R5-4, R5-5: a gold change archives the reports; they are rebuilt from saved answers in one go.
  await reviewGold(w.ws, w.projectId, id(7), best.id, 'changed', ['Vlog']);
  let st = await w.state();
  assert.equal(st.scoresUpdating, true);
  assert.equal(st.reports.filter(r => !r.archivedNow).length, 0);
  // 2026-11-12: nothing rebuilds by itself; Rebuild scores on Prompt versions does, by hand.
  const tasksBefore = (await w.state()).runs.length;
  await tick(w.ws, st);
  const {getPageView} = await import('./page-views.ts');
  await getPageView(w.ws, w.projectId, {page: 'prompt', params: {}});
  assert.equal((await w.state()).scoresUpdating, true, 'neither the workflow check nor a reader rebuilds');
  const {rebuildReports} = await import('./mismatches.ts');
  assert.equal(await rebuildReports(w.ws, w.projectId), 2);
  st = await w.state();
  assert.equal(st.scoresUpdating, false);
  assert.equal(st.reports.filter(r => !r.archivedNow).length, 2);
  assert.equal(st.runs.length, tasksBefore, 'nothing is labeled again');
  // Pressed again with nothing changed (say after a Setup change): each report is replaced, not doubled.
  const ids = st.reports.map(r => r.id).sort();
  assert.equal(await rebuildReports(w.ws, w.projectId), 2);
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
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const s = await w.state();
  const heldOut = new Set(s.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).flatMap(e => [e.externalId, e.id]));
  assert.equal(heldOut.size, 10);
  const tools = toolsOf(w);
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
  await improveWithAi(w.ws, w.projectId, s.versions[0].id);
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
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const s = await w.state();
  const v = s.versions[0].id;
  const {mismatches, reviewGold, labelComments} = await import('./mismatches.ts');
  const wrong = new Set((await mismatches(w.ws, w.projectId, v)).items.map(x => x.exampleId));
  const evalEx = s.examples.filter(e => e.split === 'eval' && wrong.has(e.id));
  const mine = evalEx.find(e => e.optimiserHalf)!;
  const held = evalEx.find(e => !e.optimiserHalf)!;
  assert.ok(mine && held);
  await reviewGold(w.ws, w.projectId, mine.id, v, 'kept', undefined, 'Shown at work, so it is a Tutorial');
  await reviewGold(w.ws, w.projectId, held.id, v, 'kept', undefined, 'A held-out note');
  const notes = await labelComments(w.ws, w.projectId, (await w.state())!);
  assert.deepEqual([...notes], [[mine.id, ['Shown at work, so it is a Tutorial']]]);
  const {improveWithAi} = await import('./agents.ts');
  await improveWithAi(w.ws, w.projectId, v);
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
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  // The user's own v1.1 has one rule: right on 0-4, where v1 is not. It is not part of any run.
  const mine = await w.newVersion('RULE 1');
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 2, 'the user version scored');
  const {startOptimiser} = await import('./work.ts');
  optimiserRandom = () => 0.99; // the last version of the front
  try {
    await startOptimiser(w.ws, w.projectId, 2, v1.id);
    await w.jobs.idle();
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
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const before = await w.state();
  const halves = Object.fromEntries(before.examples.map(e => [e.id, e.optimiserHalf]));
  const {appendExamples} = await import('./governance.ts');
  const raws = Array.from({length: 6}, (_, i) => ({externalId: `new-${i}`, type: 'video' as const, title: '', features: {}}));
  // One id is already in the dataset: it is skipped.
  const r = await appendExamples(w.ws, w.projectId, [...raws, {externalId: '0', type: 'video', title: '', features: {}}], 'upload');
  assert.deepEqual(r, {added: 6, duplicates: 1, notSaved: 0});
  const s = await w.state();
  assert.equal(s.examples.length, EVAL + 6);
  for (const e of before.examples) assert.equal(s.examples.find(x => x.id === e.id)?.optimiserHalf, halves[e.id], 'no existing example moves');
  assert.equal(s.examples.filter(e => e.externalId.startsWith('new-') && e.optimiserHalf).length, 3, 'new examples split evenly');
  assert.equal(s.reports[0].archivedNow, false, 'unlabeled examples do not make a score stale');
  assert.equal(s.examples.filter(e => !s.gold[e.id]).length, 6, 'six examples wait for gold labels');
  // A gold label on a new example does make the score stale (Rebuild scores brings it back).
  const {saveGold} = await import('./dataset.ts');
  await saveGold(w.ws, w.projectId, s.examples.find(e => e.externalId === 'new-0')!.id, 1, ['Vlog'], false);
  assert.equal((await w.state()).reports[0].archivedNow, true);
});

test('removing examples leaves a trail with half and gold label, moves no other example, and can be undone', async () => {
  const w = await world('g2');
  const s0 = await w.state();
  const halves = Object.fromEntries(s0.examples.map(e => [e.id, e.optimiserHalf]));
  const {removeExamples, restoreExamples, pruneDataset} = await import('./governance.ts');
  const target = s0.examples[3];
  assert.equal(await removeExamples(w.ws, w.projectId, [target.id], 'broken'), 1);
  let s = await w.state();
  assert.equal(s.examples.length, EVAL - 1);
  assert.equal(s.removals.length, 1);
  assert.deepEqual({half: s.removals[0].half, gold: s.removals[0].gold, reason: s.removals[0].reason, by: s.removals[0].removedBy}, {half: target.optimiserHalf ? 'optimiser' : 'held_out', gold: ['Vlog'], reason: 'broken', by: 'Tester'});
  for (const e of s.examples) assert.equal(e.optimiserHalf, halves[e.id]);
  await restoreExamples(w.ws, w.projectId, [s.removals[0].id]);
  s = await w.state();
  assert.equal(s.examples.length, EVAL);
  assert.equal(s.removals.length, 0, 'a restored removal is no longer listed');
  assert.equal(s.examples.find(e => e.id === target.id)?.optimiserHalf, target.optimiserHalf, 'restored in its own half');
  // Downsampling a value keeps K of it, evenly from both halves.
  assert.equal(await pruneDataset(w.ws, w.projectId, 'downsample', 4, 'Vlog'), EVAL - 4);
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
  await balanceHalves(w.ws, w.projectId);
  let s = await w.state();
  const tut = s.examples.filter(e => e.externalId === '1' || e.externalId === '3');
  assert.deepEqual(tut.map(e => e.optimiserHalf).sort(), [false, true], 'the rare value lands in both halves');
  assert.equal(s.examples.filter(e => e.optimiserHalf).length, EVAL / 2);
  await lockHoldout(w.ws, w.projectId);
  const locked = Object.fromEntries(s.examples.map(e => [e.id, e.optimiserHalf]));
  // New gold labels after the lock move nothing.
  const {saveGold} = await import('./dataset.ts');
  await saveGold(w.ws, w.projectId, s.examples.find(e => e.externalId === '5')!.id, 1, ['Tutorial'], false);
  assert.equal(await balanceHalves(w.ws, w.projectId), 0);
  await appendExamples(w.ws, w.projectId, [{externalId: 'n1', type: 'video', title: '', features: {}}], 'sample');
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
  await addComment(w.ws, w.projectId, mine.id, '  first  ');
  await addComment(w.ws, w.projectId, mine.id, 'x'.repeat(900));
  await addComment(w.ws, w.projectId, held.id, 'held-out words');
  await assert.rejects(addComment(w.ws, w.projectId, mine.id, '   '), /empty/);
  const s = await w.state();
  assert.deepEqual(s.comments[mine.id].map(c => c.text.length), [5, 500]);
  assert.equal(s.comments[mine.id][0].authorName, 'Tester');
  const seen = await labelComments(w.ws, w.projectId, s);
  assert.deepEqual([...seen.keys()], [mine.id]);
});

test('the first read of examples by a helper locks the halves', async () => {
  const w = await world('g5');
  assert.equal((await w.state()).project.holdoutLocked, undefined);
  await toolsOf(w).call({agent: 'prompt_agent', name: 'get_dataset_stats', args: {}});
  assert.equal((await w.state()).project.holdoutLocked, undefined, 'counts only: no lock');
  const found = (await toolsOf(w).call({agent: 'prompt_agent', name: 'search_examples', args: {text: ' '}}).catch(e => e)) as Error;
  assert.match(found.message, /words/);
  assert.equal((await w.state()).project.holdoutLocked, true);
});

test('once a version is scored the halves stay put, so a helper read never makes scores stale', async () => {
  const w = await world('g6', {gold: id => (id === '1' || id === '3' ? 'Tutorial' : 'Vlog')});
  await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const before = Object.fromEntries((await w.state()).examples.map(e => [e.id, e.optimiserHalf]));
  const {lockHoldout} = await import('./governance.ts');
  await lockHoldout(w.ws, w.projectId);
  const s = await w.state();
  for (const e of s.examples) assert.equal(e.optimiserHalf, before[e.id]);
  assert.equal(s.reports[0].archivedNow, false);
  assert.equal(s.project.holdoutLocked, true);
});


test('rename (1.1.0): trims, refuses an empty name, cuts long names, keeps the id and audits', async () => {
  const w = await world('rn1');
  assert.equal(await renameProject(w.ws, w.projectId, '  Short-video tags  '), 'Short-video tags');
  assert.equal((await w.state()).project.name, 'Short-video tags');
  await assert.rejects(renameProject(w.ws, w.projectId, '   '), /Give the project a name/);
  const long = await renameProject(w.ws, w.projectId, 'x'.repeat(200));
  assert.equal(long.length, 80);
  const audit = await w.catalog.find('audit_log', {projectId: w.projectId, action: 'project.rename'});
  assert.equal(audit.length, 2);
  assert.equal((await w.state()).project.id, w.projectId);
});

test('problem report (1.1.0): drafts first, sends only after the user answers, with diagnostics and no prompt unless asked', async () => {
  const sent: TicketSubmission[] = [];
  const tickets: TicketPort = {submit: async t => (sent.push(t), {ticketId: `T-TEST${sent.length}`})};
  const w = await world('pb1', {tickets});
  await w.newVersion('be careful');
  const client: ClientDiagnostics = {url: '/prompt?p=x', userAgent: 'test', viewport: '1440x900', screen: '1440x900', timeZone: 'UTC', language: 'en', at: '', pages: [{at: '', path: '/prompt'}], failedCalls: [{at: '', method: 'scoreVersion', callId: 'rq_1', message: 'down'}], errors: []};
  await beginTurn(w.ws, 'turn_pb1', {projectId: w.projectId, entry: 'front_desk', page: {label: 'Prompt Tuning', agent: 'front_desk', intent: 'answer', context: {}, where: {page: 'prompt', params: {}}}, locale: 'zh', client});
  const turn = await turnOf(w.ws, 'turn_pb1', w.projectId);
  assert.ok(turn && !(await turnOf(w.ws, 'turn_pb1', 'pr_other')), 'a turn belongs to its own project');
  // No draft yet: nothing to send.
  assert.match(String((await reportProblem(w.ws, w.projectId, 'front_desk', {send: true}, turn) as {error: string}).error), /no draft/);
  const draft = (await reportProblem(w.ws, w.projectId, 'front_desk', {summary: 'Save does nothing', expected: 'A new version', actual: 'Nothing happens'}, turn)) as {draft: {summary: string}; attached: string[]};
  assert.equal(draft.draft.summary, 'Save does nothing');
  assert.ok(draft.attached.some(a => a.includes('1 failed backend calls')));
  // The same turn cannot send: the user has not answered.
  assert.match(String((await reportProblem(w.ws, w.projectId, 'front_desk', {send: true}, turn) as {error: string}).error), /not answered/);
  assert.equal(sent.length, 0);
  await new Promise(r => setTimeout(r, 5));
  await w.catalog.insert('chat_messages', {id: 'cm_yes', projectId: w.projectId, createdAt: new Date().toISOString(), role: 'user', agent: null, text: 'yes', page: 'prompt'});
  const res = (await reportProblem(w.ws, w.projectId, 'front_desk', {send: true}, turn)) as {ticketId: string};
  assert.equal(res.ticketId, 'T-TEST1');
  const t = sent[0];
  assert.equal(t.summary, 'Save does nothing');
  assert.equal(t.locale, 'zh');
  assert.equal(t.filedBy, 'Assistant');
  assert.equal(t.where.page, 'prompt');
  assert.equal(t.where.appVersion, '1.1.0-test');
  assert.deepEqual(t.diagnostics?.failedCalls.map(c => c.callId), ['rq_1']);
  assert.equal(t.content, null, 'no prompt unless the user agreed');
  // The action line records the ticket, in any language.
  const line = (await w.catalog.find('chat_messages', {projectId: w.projectId, role: 'event'})).find(m => m.event === 'report');
  assert.equal(line?.text, 'You sent a problem report T-TEST1');
  assert.deepEqual(line?.msg, {key: '{who} sent a problem report {ticket}', params: {ticket: 'T-TEST1', who: 'You'}});
  // The draft is used up: a second send needs a new draft.
  assert.match(String((await reportProblem(w.ws, w.projectId, 'front_desk', {send: true}, turn) as {error: string}).error), /no draft/);
  // With the user's consent the prompt goes too.
  await reportProblem(w.ws, w.projectId, 'prompt_agent', {summary: 'Odd labels', includeContent: true}, turn);
  await new Promise(r => setTimeout(r, 5));
  await w.catalog.insert('chat_messages', {id: 'cm_yes2', projectId: w.projectId, createdAt: new Date().toISOString(), role: 'user', agent: null, text: 'yes, include it', page: 'prompt'});
  await reportProblem(w.ws, w.projectId, 'prompt_agent', {send: true}, turn);
  assert.ok(sent[1].content?.prompt.includes('be careful'));
  await endTurn(w.ws, 'turn_pb1');
});

test('problem report (1.1.0): without a ticket port the helper is told to send the user elsewhere', async () => {
  const w = await world('pb2');
  const res = (await reportProblem(w.ws, w.projectId, 'front_desk', {summary: 'x'}, null)) as {error: string};
  assert.match(res.error, /cannot be sent/);
});

/** Every item id is a video the example service knows, except ids starting with "gone". */
const knownItems = {lookup: async (ids: string[]) => ids.filter(id => !id.startsWith('gone')).map(externalId => ({externalId, type: 'video' as const, title: '', features: {}}))};

/** A data source of the world's tenant made from `ids`, imported. */
async function sourceOf(w: Awaited<ReturnType<typeof world>>, name: string, ids: string[]) {
  const {createDataSource} = await import('./sources.ts');
  const res = await createDataSource(w.ws, {name, fileName: `${name}.txt`, text: ids.join('\n')});
  assert.ok(res.source, res.error ?? 'no source');
  await w.jobs.idle();
  return res.source!.id;
}

test('data sources (#29): a file of ids becomes a tenant source; bad rows and repeats are counted; more files add to it; another tenant cannot see it', async () => {
  const w = await world('src1', {gold: null});
  const {addSourceFile, createDataSource, getDataSource, listDataSources} = await import('./sources.ts');
  assert.match((await createDataSource(w.ws, {name: ' ', fileName: 'a.csv', text: 'item_id\n1'})).error ?? '', /name/);
  assert.match((await createDataSource(w.ws, {name: 'x', fileName: 'a.xlsx', text: '1'})).error ?? '', /CSV, JSONL or TXT/);
  const res = await createDataSource(w.ws, {name: 'Weekly feed', fileName: 'feed.csv', text: 'item_id,creator\nv1,a\nv2,b\n,c\nv1,d\nbad id!,e\nv3,f\n'});
  assert.ok(res.file);
  assert.deepEqual([res.file!.rows, res.file!.bad, res.file!.repeats, res.file!.state], [6, 2, 1, 'importing']);
  assert.match((await createDataSource(w.ws, {name: 'weekly FEED', fileName: 'b.txt', text: 'v9'})).error ?? '', /already exists/);
  await w.jobs.idle();
  let d = (await getDataSource(w.ws, res.source!.id))!;
  assert.deepEqual([d.source.items, d.source.notUsed, d.source.files, d.source.importing, d.files[0].state], [3, 3, 1, null, 'done']);
  // A second file: ids already in the source are repeats; the rest join it.
  const more = await addSourceFile(w.ws, {sourceId: res.source!.id, fileName: 'more.txt', text: 'v3\nv4\nv5'});
  assert.equal(more.file!.repeats, 0, 'repeats against the source are known once the import ran');
  await w.jobs.idle();
  d = (await getDataSource(w.ws, res.source!.id))!;
  assert.deepEqual([d.source.items, d.source.files, d.files.find(f => f.name === 'more.txt')!.repeats, d.files.find(f => f.name === 'more.txt')!.items], [5, 2, 1, 2]);
  // Another tenant sees none of it.
  const other = w.inst.scope({...w.ws.ctx, tenantId: 't2'});
  assert.deepEqual(await listDataSources(other), []);
  assert.equal(await getDataSource(other, res.source!.id), null);
  await assert.rejects(addSourceFile(other, {sourceId: res.source!.id, fileName: 'x.txt', text: 'v8'}), /does not exist/);
  assert.equal((await listDataSources(w.ws)).length, 1);
});

test('data sources (#29): the sample data is a built-in source of every tenant, made once; files cannot be added to it', async () => {
  const w = await world('src2', {gold: null});
  const {addSourceFile, listDataSources} = await import('./sources.ts');
  Object.assign(w.inst, {examples: {...knownItems, builtIn: async () => ({name: 'Sample data', ids: ['s1', 's2', 's3', 's2']})}});
  const [a] = await Promise.all([listDataSources(w.ws), listDataSources(w.ws)]);
  const all = await listDataSources(w.ws);
  assert.equal(all.length, 1, 'two first reads make it once');
  assert.deepEqual([a[0].name, a[0].builtIn, all[0].items, all[0].createdBy], ['Sample data', true, 3, 'Sprint']);
  assert.equal((await listDataSources(w.inst.scope({...w.ws.ctx, tenantId: 't2'})))[0].builtIn, true);
  assert.match((await addSourceFile(w.ws, {sourceId: all[0].id, fileName: 'x.txt', text: 'z'})).error ?? '', /built-in/);
});

test('cuts (#30): continuous segments of an order shuffled once; two datasets never share an item; too many is refused with the counts; a deleted project is never reissued; a new file does not move earlier cuts', async () => {
  const w = await world('cut1', {gold: null});
  Object.assign(w.inst, {examples: knownItems});
  const {addSourceFile, allocate, getDataSource} = await import('./sources.ts');
  const {createProject} = await import('./projects.ts');
  const {takeExamples} = await import('./dataset.ts');
  const ids = Array.from({length: 40}, (_, i) => `i${String(i).padStart(2, '0')}`);
  const sourceId = await sourceOf(w, 'Feed', ids);
  const a = await allocate(w.ws, 'pr_a', {sourceId, count: 10}, new Set());
  const b = await allocate(w.ws, 'pr_b', {sourceId, count: 10}, new Set());
  const taken = (x: typeof a) => x.items.map(i => i.externalId);
  assert.deepEqual([a.cut.start, a.cut.end, b.cut.start, b.cut.end], [0, 10, 10, 20]);
  assert.equal(new Set([...taken(a), ...taken(b)]).size, 20, 'no item in both');
  assert.notDeepEqual(taken(a), ids.slice(0, 10), 'the file order was shuffled at import');
  // Two cuts at once still never overlap.
  const [c, e] = await Promise.all([allocate(w.ws, 'pr_c', {sourceId, count: 5}, new Set()), allocate(w.ws, 'pr_e', {sourceId, count: 5}, new Set())]);
  assert.equal(new Set([...taken(a), ...taken(b), ...taken(c), ...taken(e)]).size, 30);
  await assert.rejects(allocate(w.ws, 'pr_f', {sourceId, count: 11}, new Set()), /Only 10 unused items are left in Feed; 11 were asked for/);
  // A deleted project's segment is retired and never handed out again.
  const p = await createProject(w.ws, 'Doomed');
  await takeExamples(w.ws, p.id, [{sourceId, count: 4}]);
  await w.jobs.idle();
  const before = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([before.taken, before.projects, before.source.notUsed], [34, 5, 6]);
  await deleteProject(w.ws, p.id);
  await w.jobs.idle();
  const after = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([after.taken, after.projects, after.source.notUsed], [34, 4, 6]);
  const cuts = await w.catalog.find('source_cuts', {projectId: p.id});
  assert.ok(cuts.length === 1 && cuts[0].retired);
  // Items already in the dataset are skipped, and still use their positions.
  const left = await allocate(w.ws, 'pr_f', {sourceId, count: 2}, new Set(ids));
  assert.deepEqual([left.items.length, left.cut.start, left.cut.end], [0, 34, 40], 'every unused item was already in the dataset');
  // A new file joins at the end: earlier cuts keep their items.
  await addSourceFile(w.ws, {sourceId, fileName: 'more.txt', text: 'n1\nn2\ni00'});
  await w.jobs.idle();
  const again = await allocate(w.ws, 'pr_g', {sourceId, count: 2}, new Set());
  assert.deepEqual([again.cut.start, again.cut.end], [40, 42]);
  assert.deepEqual(taken(again).sort(), ['n1', 'n2'], 'only the new items; i00 was a repeat');
});

test('take examples (#29): a new dataset from two sources, each example knows its source; Add examples skips items already there; unknown items are counted', async () => {
  const w = await world('take1', {gold: null});
  Object.assign(w.inst, {examples: knownItems});
  const {takeExamples, getSamplingTask} = await import('./dataset.ts');
  const {createProject} = await import('./projects.ts');
  const one = await sourceOf(w, 'One', ['a1', 'a2', 'a3', 'a4', 'shared', 'gone1']);
  const two = await sourceOf(w, 'Two', ['b1', 'b2', 'b3', 'shared']);
  const p = await createProject(w.ws, 'Fresh');
  await assert.rejects(takeExamples(w.ws, p.id, []), /at least one/);
  await assert.rejects(takeExamples(w.ws, p.id, [{sourceId: one, count: 7}]), /Only 6 unused items are left in One; 7 were asked for/);
  const task = await takeExamples(w.ws, p.id, [{sourceId: one, count: 6}, {sourceId: two, count: 2}]);
  assert.deepEqual([task.state, task.total], ['running', 8], 'the command returns once the job is queued');
  await w.jobs.idle();
  assert.equal(await getSamplingTask(w.ws, p.id), null);
  let s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(s.snapshot?.source, 'sources');
  assert.equal(s.snapshot?.counts.invalid, 1, 'an item the example service does not know is counted');
  const ext = s.examples.map(e => e.externalId);
  assert.equal(new Set(ext).size, ext.length, 'no item twice, even one in both sources');
  assert.ok(s.examples.every(e => (e.sourceId === one || e.sourceId === two) && e.sourceFileId));
  assert.deepEqual(s.datasetSources.map(l => [l.name, l.examples]), [['One', 5], ['Two', 2]]);
  // Add examples: the rest of Two; "shared" (if still unused there) is skipped, not added twice.
  const left = (await (await import('./sources.ts')).getDataSource(w.ws, two))!.source.notUsed;
  await takeExamples(w.ws, p.id, [{sourceId: two, count: left}]);
  await w.jobs.idle();
  s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(new Set(s.examples.map(e => e.externalId)).size, s.examples.length);
  assert.ok(['b1', 'b2', 'b3', 'shared'].every(id => s.examples.some(e => e.externalId === id)));
  assert.equal(s.datasetSources.find(l => l.name === 'Two')!.examples + s.datasetSources.find(l => l.name === 'One')!.examples, s.examples.length);
});

test('take examples: progress stays on until the dataset is saved; a save that fails twice is skipped and counted apart, the halves stay even; nothing saved fails the job and retires its segment', async () => {
  const w = await world('take2', {gold: null});
  const {takeExamples, getSamplingTask} = await import('./dataset.ts');
  const {getDataSource} = await import('./sources.ts');
  const {createProject} = await import('./projects.ts');
  const app = w.inst;
  Object.assign(app, {examples: knownItems});
  const sourceId = await sourceOf(w, 'Feed', Array.from({length: 20}, (_, i) => `s${i}`));
  const p = await createProject(w.ws, 'Fresh');
  const tries = new Map<string, number>();
  const during: (boolean | undefined)[] = [];
  let failAll = false;
  let failOne = '';
  const insert = app.catalog.insert.bind(app.catalog);
  Object.assign(app, {
    catalog: Object.assign(Object.create(app.catalog), {
      insert: async (kind: string, rec: {externalId: string}) => {
        if (kind === 'examples') {
          during.push((await getSamplingTask(w.ws, p.id))?.saving);
          const n = (tries.get(rec.externalId) ?? 0) + 1;
          tries.set(rec.externalId, n);
          failOne ||= rec.externalId;
          if (failAll || rec.externalId === failOne) throw new Error('write failed');
        }
        return insert(kind as never, rec as never);
      },
    }),
  });
  await takeExamples(w.ws, p.id, [{sourceId, count: 10}]);
  await w.jobs.idle();
  assert.ok(during.length === 11 && during.every(Boolean), 'the page shows saving, never the empty start, while examples are saved');
  const snap = (await app.catalog.get('dataset_snapshots', (await app.catalog.get('projects', p.id))!.snapshotId!))!;
  assert.deepEqual([snap.counts.valid, snap.counts.notSaved], [9, 1]);
  assert.equal(tries.get(failOne), 2, 'a failed write is tried once more');
  const saved = await app.catalog.find('examples', {snapshotId: snap.id});
  assert.ok(Math.abs(2 * saved.filter(e => e.optimiserHalf).length - saved.length) <= 1, 'the halves are even over the saved examples');
  // Nothing saved: the job fails with the reason, and its segment is retired.
  failAll = true;
  const failing = await takeExamples(w.ws, p.id, [{sourceId, count: 3}]);
  await w.jobs.idle();
  const job = await w.jobs.api.get(w.ws.ctx, failing.id);
  assert.equal(job?.state, 'failed');
  assert.match(job?.error ?? '', /None of the examples could be saved/);
  const cuts = await app.catalog.find('source_cuts', {projectId: p.id});
  assert.deepEqual(cuts.map(c => !!c.retired), [false, true]);
  assert.equal((await getDataSource(w.ws, sourceId))!.source.notUsed, 7, 'a retired segment is not handed out again');
  // The Dataset page shows why the take failed, until the next take.
  const shown = (await loadProjectState(w.ws, p.id))!.samplingTask;
  assert.deepEqual([shown?.state, shown?.id], ['failed', failing.id]);
  assert.match(shown?.error ?? '', /None of the examples could be saved/);
  // The per-source count is the examples actually saved (one was not).
  let s = (await loadProjectState(w.ws, p.id))!;
  assert.deepEqual(s.datasetSources.map(l => l.examples), [9]);
  assert.equal(cuts[0].taken, 9, 'the segment records the examples saved, not the items found');
  // Removed examples leave the count; restored ones come back.
  const {removeExamples, restoreExamples} = await import('./governance.ts');
  await removeExamples(w.ws, p.id, s.examples.slice(0, 2).map(e => e.id), 'broken');
  s = (await loadProjectState(w.ws, p.id))!;
  assert.deepEqual(s.datasetSources.map(l => l.examples), [7]);
  await restoreExamples(w.ws, p.id, s.removals.map(r => r.id));
  s = (await loadProjectState(w.ws, p.id))!;
  assert.deepEqual(s.datasetSources.map(l => l.examples), [9]);
  // A new take clears the failure.
  failAll = false;
  await takeExamples(w.ws, p.id, [{sourceId, count: 2}]);
  await w.jobs.idle();
  assert.equal(await getSamplingTask(w.ws, p.id), null);
});

test('take examples (review): Add examples whose items are all in the dataset already succeeds and adds nothing', async () => {
  const w = await world('take3', {gold: null});
  Object.assign(w.inst, {examples: knownItems});
  const {takeExamples, getSamplingTask} = await import('./dataset.ts');
  const {getDataSource} = await import('./sources.ts');
  const {createProject} = await import('./projects.ts');
  const one = await sourceOf(w, 'One', ['x1', 'x2', 'x3']);
  const p = await createProject(w.ws, 'Fresh');
  await takeExamples(w.ws, p.id, [{sourceId: one, count: 3}]);
  await w.jobs.idle();
  // Every item of Two is in the dataset already.
  const two = await sourceOf(w, 'Two', ['x3', 'x1']);
  const job = await takeExamples(w.ws, p.id, [{sourceId: two, count: 2}]);
  await w.jobs.idle();
  assert.equal((await w.jobs.api.get(w.ws.ctx, job.id))?.state, 'done');
  assert.equal(await getSamplingTask(w.ws, p.id), null, 'no failure to show');
  const s = (await loadProjectState(w.ws, p.id))!;
  assert.equal(s.examples.length, 3);
  assert.deepEqual(s.datasetSources.map(l => [l.name, l.examples]), [['One', 3]]);
  assert.equal((await getDataSource(w.ws, two))!.source.notUsed, 0, 'the positions are used: the next take moves on');
});

/** The world's catalog with `insert` and `patch` going through `hook` first (it may throw). */
function hookCatalog(w: Awaited<ReturnType<typeof world>>, hook: {insert?: (kind: string, rec: Record<string, unknown>) => void; patch?: (kind: string, id: string, patch: Record<string, unknown>) => void}) {
  const app = w.inst;
  const insert = app.catalog.insert.bind(app.catalog);
  const patch = app.catalog.patch.bind(app.catalog);
  Object.assign(app, {
    catalog: Object.assign(Object.create(app.catalog), {
      insert: async (kind: string, rec: Record<string, unknown>) => (hook.insert?.(kind, rec), insert(kind as never, rec as never)),
      patch: async (kind: string, id: string, p: Record<string, unknown>) => (hook.patch?.(kind, id, p), patch(kind as never, id, p as never)),
    }),
  });
}

test('data sources (review): an import that keeps failing is tried again, then marked failed; what it wrote can be taken, the rest is skipped, and uploading it again adds the rest', async () => {
  const w = await world('ing1', {gold: null, retryDelayMs: 1});
  const {addSourceFile, allocate, getDataSource} = await import('./sources.ts');
  const sourceId = await sourceOf(w, 'Feed', Array.from({length: 30}, (_, i) => `a${i}`));
  const big = Array.from({length: 2500}, (_, i) => `b${i}`);
  let tries = 0;
  let failing = true;
  // Positions 30-1029 are written; the piece at 1030 never is.
  hookCatalog(w, {
    insert: (kind, rec) => {
      if (failing && kind === 'source_chunks' && !rec.staged && rec.start === 1030) {
        tries++;
        throw new Error('write failed');
      }
    },
  });
  const res = await addSourceFile(w.ws, {sourceId, fileName: 'big.txt', text: big.join('\n')});
  await until(async () => (await w.catalog.get('source_files', res.file!.id))?.state === 'failed', 'the import to fail');
  const file = (await w.catalog.get('source_files', res.file!.id))!;
  assert.equal(tries, 3, 'tried twice more before it failed');
  assert.deepEqual([file.start, file.items, file.done], [30, 2500, 1000]);
  assert.match(file.error ?? '', /write failed/);
  assert.equal((await w.catalog.find('source_chunks', {fileId: file.id})).filter(c => c.staged).length, 0, 'its staged ids are gone');
  let d = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([d.source.items, d.source.notUsed, d.source.importing], [1030, 1030, null], 'only written items count');
  // A later file goes after the failed one's positions; a cut skips the unwritten ones.
  failing = false;
  await addSourceFile(w.ws, {sourceId, fileName: 'last.txt', text: 'c1\nc2\nc3'});
  await w.jobs.idle();
  d = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([d.source.items, d.source.notUsed], [1033, 1033]);
  const cut = await allocate(w.ws, 'pr_x', {sourceId, count: 1033}, new Set());
  assert.equal(new Set(cut.items.map(i => i.externalId)).size, 1033);
  assert.ok(['c1', 'c2', 'c3'].every(id => cut.items.some(i => i.externalId === id)), 'the walk went past the hole');
  assert.deepEqual([cut.cut.start, cut.cut.end], [0, 2533]);
  await assert.rejects(allocate(w.ws, 'pr_x', {sourceId, count: 1}, new Set()), /Only 0 unused items/);
  // Uploading the file again adds what the failed import did not write.
  const again = await addSourceFile(w.ws, {sourceId, fileName: 'big.txt', text: big.join('\n')});
  await w.jobs.idle();
  const second = (await w.catalog.get('source_files', again.file!.id))!;
  assert.deepEqual([second.state, second.items, second.repeats], ['done', 1500, 1000]);
  d = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([d.source.items, d.source.notUsed, d.taken], [2533, 1500, 1033]);
});

test('data sources (review): an import cut short between reserving on the source and on the file goes on with the same positions; a file imported meanwhile goes after them', async () => {
  const w = await world('ing2', {gold: null, retryDelayMs: 150});
  const {addSourceFile, allocate, getDataSource} = await import('./sources.ts');
  const sourceId = await sourceOf(w, 'Feed', ['a1', 'a2', 'a3']);
  let crashed = false;
  hookCatalog(w, {
    patch: (kind, _id, p) => {
      if (kind === 'source_files' && 'start' in p && !crashed) {
        crashed = true;
        throw new Error('process stopped');
      }
    },
  });
  const one = await addSourceFile(w.ws, {sourceId, fileName: 'one.txt', text: 'b1\nb2\nb3\nb4'});
  await until(async () => crashed, 'the first import to stop');
  // Before the first one's retry, a second file is imported.
  const two = await addSourceFile(w.ws, {sourceId, fileName: 'two.txt', text: 'c1\nc2'});
  await until(async () => (await w.catalog.get('source_files', one.file!.id))?.state === 'done', 'the first import to go on');
  await w.jobs.idle();
  const [f1, f2] = await Promise.all([w.catalog.get('source_files', one.file!.id), w.catalog.get('source_files', two.file!.id)]);
  assert.deepEqual([f1!.start, f1!.items, f2!.start, f2!.items, f2!.state], [3, 4, 7, 2, 'done']);
  const d = (await getDataSource(w.ws, sourceId))!;
  assert.deepEqual([d.source.items, d.source.notUsed], [9, 9], 'no position reserved twice or lost');
  const all = await allocate(w.ws, 'pr_x', {sourceId, count: 9}, new Set());
  assert.deepEqual(all.items.map(i => i.externalId).sort(), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'b4', 'c1', 'c2']);
});

test('revision (G9): every change gives a new one, a burst of writes writes it once, and the light read carries the running work', async () => {
  const base = memorySharedState();
  const writes: string[] = [];
  const shared: SharedStatePort = {
    get: k => base.get(k),
    set: async (k, v, ttl) => {
      if (k.startsWith('revision:')) writes.push(k);
      await base.set(k, v, ttl);
    },
    delete: k => base.delete(k),
  };
  const w = await world('g9', {sharedState: shared});
  const s0 = (await projectStatus(w.ws, w.projectId))!;
  assert.equal(s0.revision, (await w.state()).revision, 'nothing changed between the two reads');
  assert.deepEqual(s0.runs, []);
  assert.equal(s0.samplingTask, null);

  // Five writes in a row: one new revision, written once.
  for (let i = 0; i < 5; i++) await addComment(w.ws, w.projectId, `ex_g9_${i}`, `note ${i}`);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(writes, [`revision:${w.projectId}`]);
  const s1 = (await projectStatus(w.ws, w.projectId))!;
  assert.notEqual(s1.revision, s0.revision);

  // A read right after a write in this instance sees the new revision at once.
  await addComment(w.ws, w.projectId, 'ex_g9_0', 'again');
  const s2 = (await projectStatus(w.ws, w.projectId))!;
  assert.notEqual(s2.revision, s1.revision);

  // Scoring: the light read shows the run and its counts, never the dataset.
  const v = await w.newVersion();
  await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  const s3 = (await projectStatus(w.ws, w.projectId))!;
  assert.equal(s3.runs.length, 1);
  assert.equal(s3.runs[0].state, 'done');
  assert.equal(s3.runs[0].done, EVAL);
  assert.notEqual(s3.revision, s2.revision);
  assert.deepEqual(Object.keys(s3).sort(), ['optimisation', 'projectId', 'revision', 'runs', 'samplingTask']);
  assert.equal((await w.state()).revision, s3.revision);

  // Another project's revision does not move with this one's writes.
  const other = await w.catalog.get('projects', w.projectId);
  await w.catalog.insert('projects', {...other!, id: 'pr_g9_other'});
  const o1 = (await projectStatus(w.ws, 'pr_g9_other'))!.revision;
  await addComment(w.ws, w.projectId, 'ex_g9_1', 'one more');
  assert.equal((await projectStatus(w.ws, 'pr_g9_other'))!.revision, o1);

  // A project being deleted, or one that never existed, has no status.
  await deleteProject(w.ws, w.projectId);
  assert.equal(await projectStatus(w.ws, w.projectId), null);
  assert.equal(await projectStatus(w.ws, 'pr_none'), null);
  await w.jobs.idle();
});

test('Upload labels: rows match examples already in the dataset, bad values are refused by row, a re-upload replaces and is audited (#31)', async () => {
  const w = await world('gl31', {gold: null});
  const {uploadGoldText} = await import('./dataset.ts');
  const up = async (name: string, text: string) => uploadGoldText(w.ws, w.projectId, schema, 1, (await w.state()).examples, name, text);
  const before = (await w.state()).examples.length;

  const first = await up('labels.csv', 'item_id,answer\n0,Vlog\n1,Tutorial\n99,Vlog\n2,Cooking\n3,"Vlog|Tutorial"\n');
  assert.deepEqual(
    {saved: first.saved, skipped: first.skipped, notInDataset: first.notInDataset, replaced: first.replaced},
    {saved: 2, skipped: 3, notInDataset: 1, replaced: 0},
  );
  assert.deepEqual(first.refused, [
    {row: 5, externalId: '2', reason: '"Cooking" isn\'t a value of format'},
    {row: 6, externalId: '3', reason: 'format needs exactly one value'},
  ]);
  // Uploading labels never adds examples.
  assert.equal((await w.state()).examples.length, before);
  assert.deepEqual((await w.state()).gold['ex_gl31_1']?.answer, ['Tutorial']);

  // Again: a changed label replaces the earlier one, the same label saves nothing.
  const again = await up('labels.jsonl', '{"item_id":"0","answer":"Vlog"}\n{"item_id":"1","answer":"Vlog"}\n');
  assert.deepEqual({saved: again.saved, replaced: again.replaced, unchanged: again.unchanged}, {saved: 1, replaced: 1, unchanged: 1});
  assert.deepEqual((await w.state()).gold['ex_gl31_1']?.answer, ['Vlog']);
  const audits = await w.catalog.find('audit_log', {projectId: w.projectId, action: 'gold_labels.uploaded'});
  assert.equal(audits.length, 2);

  // A file that is not CSV or JSONL, or a CSV without the columns, saves nothing.
  assert.match((await up('labels.txt', '0 Vlog')).error ?? '', /CSV or JSONL/);
  assert.match((await up('labels.csv', 'id,value\n0,Vlog')).error ?? '', /item_id column/);
});

test('frozen snapshots (#32): a take checks each item, counts what is left out per check, and freezes the features of the rest in one document per example; the examples carry none; reads go by id, for the project\'s own examples only', async () => {
  const {configureSystem} = await import('@yushiguang/sprint-domain');
  const w = await world('fz1', {gold: null});
  const lookups: number[] = [];
  let failOnce = 1;
  const problems: Record<string, 'missing' | 'minor_creator' | 'not_recommendable'> = {i01: 'minor_creator', i02: 'not_recommendable', i03: 'missing', i04: 'minor_creator'};
  const source: ExampleSource = {
    async lookup(ids) {
      lookups.push(ids.length);
      // The feature service fails once: the batch is tried again, the take goes on.
      if (failOnce-- > 0) throw new Error('feature service down');
      // i05 passes its checks but no features come back: kept, with none.
      return ids.filter(id => id !== 'i05').map(externalId => ({externalId, type: 'video' as const, title: `t ${externalId}`, features: {Description: {text: `about ${externalId}`}}}));
    },
    async check(ids) {
      return ids.map(externalId => ({externalId, type: externalId === 'i06' ? ('photo_text' as const) : problems[externalId] ? null : ('video' as const), problem: problems[externalId] ?? null}));
    },
  };
  Object.assign(w.inst, {examples: source});
  configureSystem({dataset: {featureBatch: 7}});
  try {
    const {createProject} = await import('./projects.ts');
    const {takeExamples} = await import('./dataset.ts');
    const {exampleFeatures} = await import('./features.ts');
    const ids = Array.from({length: 20}, (_, i) => `i${String(i).padStart(2, '0')}`);
    const sourceId = await sourceOf(w, 'Feed', ids);
    const p = await createProject(w.ws, 'Frozen');
    await takeExamples(w.ws, p.id, [{sourceId, count: 20}]);
    await w.jobs.idle();
    const state = (await loadProjectState(w.ws, p.id))!;
    const snap = state.snapshot!;
    assert.deepEqual(snap.counts.checks, {missing: 1, minorCreator: 2, notRecommendable: 1});
    assert.deepEqual([snap.counts.valid, snap.counts.invalid, state.examples.length], [16, 4, 16]);
    assert.ok(lookups.every(n => n <= 7), 'features are fetched a batch at a time');
    assert.ok(state.examples.every(e => !('features' in e)), 'project state carries the index only');
    assert.equal(state.examples.find(e => e.externalId === 'i06')?.type, 'photo_text', 'the kind comes from the checks');
    const stored = await w.catalog.find('examples', {snapshotId: snap.id});
    assert.ok(stored.every(e => !('features' in e)), 'example records hold no features');
    const docs = await w.catalog.find('example_features', {snapshotId: snap.id});
    assert.equal(docs.length, 16);
    assert.ok(docs.every(d => d.id === `${snap.id}:${d.externalId}`));
    assert.ok((snap.featureSizes?.Description?.chars ?? 0) > 0, 'average sizes are kept for estimates');
    const i07 = state.examples.find(e => e.externalId === 'i07')!;
    const i05 = state.examples.find(e => e.externalId === 'i05')!;
    assert.deepEqual(await exampleFeatures(w.ws, p.id, [i07.id, i05.id]), {[i07.id]: {Description: {text: 'about i07'}}, [i05.id]: {}});
    // Another project's examples are never read through this one.
    const other = await createProject(w.ws, 'Other');
    assert.deepEqual(await exampleFeatures(w.ws, other.id, [i07.id]), {});
    // Adding more: the counts add up.
    problems.j01 = 'missing';
    const more = await sourceOf(w, 'More', ['j00', 'j01', 'j02']);
    await takeExamples(w.ws, p.id, [{sourceId: more, count: 3}]);
    await w.jobs.idle();
    const after = (await loadProjectState(w.ws, p.id))!.snapshot!;
    assert.deepEqual([after.counts.valid, after.counts.checks], [18, {missing: 2, minorCreator: 2, notRecommendable: 1}]);
    assert.equal((await w.catalog.find('example_features', {snapshotId: snap.id})).length, 18);
  } finally {
    configureSystem();
  }
});

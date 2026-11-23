import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, AgentToolRequest, AgentTurnRequest, ClientDiagnostics, RequestContext, SharedStatePort, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, ObjectStorePort, ProjectState, Schema, StructuredPrompt, TicketPort, TicketSubmission, NotificationPort, TelemetryPort, AuthorizationPort} from '@yushiguang/sprint-contracts';
import {createCatalog, docFeatureStore, objectFeatureStore} from '@yushiguang/sprint-catalog';
import {createLabeling, labelingExecutor, memoryLocks} from '@yushiguang/sprint-labeling';
import {createOptimiser, optimiserExecutor} from '@yushiguang/sprint-optimiser';
import {DocRepo, localDocRuntime, logNotifications, memoryJobStore, memoryObjectStore, memorySharedState} from '@yushiguang/sprint-platform';
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
import {withQueue} from './queue.ts';
import {jobState, runView} from './views.ts';
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
  /** Object storage for frozen features (none: one document per example). */
  objects?: ObjectStorePort;
  notifications?: NotificationPort;
  telemetry?: TelemetryPort;
  authorization?: AuthorizationPort;
}

/** The helpers' tools on the world's project, with no turn: calls run as the world's caller. */
function toolsOf(w: {inst: Parameters<typeof agentToolHost>[0]; projectId: string; ws: {ctx: RequestContext}}) {
  const host = agentToolHost(w.inst);
  return {call: (r: AgentToolRequest) => host.call({...r, projectId: w.projectId, turnId: null, ctx: w.ws.ctx})};
}

async function world(prefix: string, opts: WorldOpts = {}) {
  const db = localDocRuntime(prefix);
  const features = opts.objects ? objectFeatureStore(opts.objects, docFeatureStore(db)) : undefined;
  const catalog = createCatalog(db, {features});
  const calls = {n: 0};
  const seen = new Map<string, number>();
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    labelingEndpointsFor: async () => [endpoint],
    forgetTenant: () => {},
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
  // Background work runs through the job module, in this process, as in the browser build.
  const jobs = createJobs({store: memoryJobStore(), ...(opts.retryDelayMs ? {retryDelayMs: opts.retryDelayMs} : {})});
  // As the composition root wires it: a task live as job work is never read as abandoned.
  const liveElsewhere = async (task: {id: string; projectId: string}) => (await jobs.api.list(systemContext('labeling'), {projectId: task.projectId, kinds: ['labeling.runTask'], states: ['queued', 'running']})).some(j => j.args.taskId === task.id);
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks(), liveElsewhere, onChange: id => inst.emitChange(id ?? null)});
  const agents = opts.agents ?? ({} as AgentRuntimeContract);
  const inst = createInstance({
    jobs: jobs.api,
    catalog,
    features,
    labeling,
    gateway,
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
    tickets: opts.tickets,
    notifications: opts.notifications,
    telemetry: opts.telemetry,
    authorization: opts.authorization,
    appVersion: '1.1.0-test',
    sharedState: opts.sharedState ?? memorySharedState(),
  });
  const optimiser = createOptimiser({catalog, labeling, agents, host: optimiserHost(inst), onChange: inst.emitChange, random: () => optimiserRandom()});
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
  await catalog.insert('projects', {id: projectId, tenantId: 'default', name: 'p', createdAt: '', createdBy: '', kind: 'prompt_tuning', settingsConfirmed: opts.confirmed ?? true, setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: opts.goldApproved === false ? [] : ['prompt_design', 'dataset', 'gold']});
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
  const task = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id).slice(0, 4), createdBy: 'Tester'});
  await w.labeling.runTask(task.id, 'user');
  const all = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'Tester'});
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
  const make = (ids: string[]) => w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: ids, createdBy: 'Tester'});
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

test('labeling waits for its endpoint: one labeling job per tenant and endpoint at a time; reports only compute (#66)', async () => {
  const w = await world('b5c', {delayMs: 5});
  const v = await w.newVersion();
  const s0 = await w.state();
  const make = (ids: string[]) => w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: ids, createdBy: 'Tester'});
  const repo = new DocRepo(w.db);
  const ids = s0.examples.map(e => e.id);
  for (const t of [await make(ids), await make(ids.slice(0, 3)), await make(ids.slice(0, 5))]) await repo.patch('labeling_tasks', t.id, {state: 'paused', stopReason: 'closed'});
  await tick(w.ws, await w.state());
  const labelJobs = () => w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']});
  await until(async () => (await labelJobs()).some(j => j.state === 'running'), 'the first task starts');
  const jobs = await labelJobs();
  assert.deepEqual(new Set(jobs.map(j => j.concurrencyKey)), new Set(['model:default:A']), "the project's tenant and the task's model");
  assert.deepEqual(jobs.map(j => j.state).sort(), ['queued', 'queued', 'running'], 'the others wait for the endpoint');
  const waiting = jobs.filter(j => j.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1));
  assert.deepEqual(await Promise.all(waiting.map(j => w.jobs.api.ahead(w.ws.ctx, j.id))), [0, 1]);
  // Pages see each waiting task's place; the state the workflow works from does not.
  const view = (await withQueue(w.ws, w.projectId, await w.state()))!;
  assert.deepEqual(waiting.map(j => view.runs.find(r => r.id === j.args.taskId)?.queue), [{ahead: 0}, {ahead: 1}]);
  assert.equal(view.runs.filter(r => r.queue).length, 2, 'the running task has no place in the queue');
  assert.ok((await w.state()).runs.every(r => !r.queue));
  // Stop on a waiting task ends it for good: the next check does not start it again.
  const stopped = String(waiting[1].args.taskId);
  const {stopRun} = await import('./evaluation.ts');
  await stopRun(w.ws, w.projectId, stopped);
  await tick(w.ws, await w.state());
  assert.equal((await w.state()).runs.find(r => r.id === stopped)?.state, 'stopped');
  assert.equal((await labelJobs()).filter(j => j.args.taskId === stopped && j.state !== 'cancelled').length, 0, 'not queued again');
  await until(async () => (await w.state()).runs.every(r => r.state === 'done' || r.id === stopped), 'the others, one after the other');
  assert.equal((await w.state()).runs.find(r => r.id === stopped)?.done, 0, 'the stopped task never labeled');
  const reports = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['report.build']});
  assert.ok(reports.length && reports.every(j => j.concurrencyKey === 'compute:default'));
});

test('a task that needs attention shows as Failed on pages, with its message (#66)', () => {
  const base = {id: 'lt_1', projectId: 'pr_1', promptVersionId: 'pv_1', endpoint: 'A', done: 8, total: 10, valid: 8, invalid: 0, failed: 2, costUsd: 0, error: 'Some examples could not be labeled.', createdAt: '', startedAt: '', finishedAt: null, createdBy: 'Tester', purpose: 'eval'};
  const view = runView({...base, state: 'needs_attention'} as unknown as Parameters<typeof runView>[0]);
  assert.deepEqual([view.state, view.error], ['failed', 'Some examples could not be labeled.']);
  assert.equal(jobState('failed'), 'failed');
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
        return {invocations: [{from: 'user', to: 'front_desk', intent: 'answer', note: ''}, {from: 'front_desk', to: 'prompt_agent', intent: 'revise_prompt', note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
      }
      await progress({message: {role: 'agent', agent: input.page.agent, text: 'Again.'}});
      return {invocations: [{from: 'user', to: input.page.agent, intent: input.page.intent, note: ''}], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
    reflectPrompt: async () => ({prompt: sp(), change: ''}),
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

test('Ask AI attachments (#45): examples named in an attachment come from the project only, the readable half only, with their frozen features', async () => {
  const seen: AgentTurnRequest[] = [];
  const agents = {
    async runTurn(input: AgentTurnRequest) {
      seen.push(input);
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
    reflectPrompt: async () => ({prompt: sp(), change: ''}),
    cancel: async () => {},
  } satisfies AgentRuntimeContract;
  const w = await world('b13', {agents});
  // The tenant source would hand back every id named, held-out and foreign alike, with live features.
  let lookups = 0;
  let checks = 0;
  const source: ExampleSource = {
    async lookup(ids) {
      lookups++;
      return ids.map(externalId => ({externalId, type: 'video' as const, title: `tenant ${externalId}`, features: {Description: {text: `tenant features of ${externalId}`}}}));
    },
    async check(ids) {
      checks++;
      return ids.map(externalId => ({externalId, type: 'video' as const, problem: null}));
    },
  };
  Object.assign(w.inst, {examples: source});
  const snapshotId = 'ds_b13';
  const frozen: Record<string, string> = {'123456': 'frozen features of the first', '123457': 'frozen features of the second'};
  for (const [externalId, optimiserHalf] of [['123456', true], ['123457', false]] as const) {
    await w.catalog.insert('examples', {id: `ex_b13_${externalId}`, snapshotId, externalId, type: 'video', title: `Project ${externalId}`, split: 'eval', optimiserHalf});
    await w.catalog.insert('example_features', {id: `${snapshotId}:${externalId}`, snapshotId, externalId, type: 'video', features: {Description: {text: frozen[externalId]}}, fetchedAt: ''});
  }
  assert.equal((await w.state()).project.holdoutLocked, undefined, 'not locked before the turn');
  const {sendUserMessage} = await import('./agents.ts');
  const page = {label: 'Gold Labels', agent: 'front_desk' as const, intent: 'answer', context: {}, where: {page: 'gold' as const, params: {}}};
  await sendUserMessage(w.ws, w.projectId, 'look at these', page, [{name: 'ids.txt', size: 30, content: 'please check 123456, 123457 and 999999'}]);
  await w.inst.turnsIdle();
  assert.equal(seen.length, 1);
  // The first read locks the halves and balances them one last time, so which of the two is
  // readable is read back from the locked state, not from the halves seeded above.
  const locked = await w.state();
  assert.equal(locked.project.holdoutLocked, true, 'naming a project example locks the holdout');
  const named = locked.examples.filter(e => e.externalId in frozen);
  const visible = named.filter(e => e.optimiserHalf);
  const heldOut = named.filter(e => !e.optimiserHalf);
  assert.deepEqual([visible.length, heldOut.length], [1, 1], 'the two named examples end one in each half');
  assert.deepEqual(seen[0].workspace.attachedExamples, visible.map(e => ({externalId: e.externalId, type: 'video', title: e.title, features: {Description: {text: frozen[e.externalId]}}})));
  assert.ok(!JSON.stringify(seen[0].workspace).includes(frozen[heldOut[0].externalId]), 'held-out features never reach the helper');
  assert.ok(!JSON.stringify(seen[0].workspace).includes('tenant features'), 'nothing is resolved from the tenant source');
  assert.deepEqual([lookups, checks], [0, 0], 'the tenant source is neither looked up nor checked');
});

test('Ask AI attachments (#45): an attachment naming no project example resolves nothing and does not lock the holdout', async () => {
  const seen: AgentTurnRequest[] = [];
  const agents = {
    async runTurn(input: AgentTurnRequest) {
      seen.push(input);
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
    reflectPrompt: async () => ({prompt: sp(), change: ''}),
    cancel: async () => {},
  } satisfies AgentRuntimeContract;
  const w = await world('b14', {agents});
  let lookups = 0;
  const source: ExampleSource = {
    async lookup(ids) {
      lookups++;
      return ids.map(externalId => ({externalId, type: 'video' as const, title: `tenant ${externalId}`, features: {Description: {text: `tenant features of ${externalId}`}}}));
    },
  };
  Object.assign(w.inst, {examples: source});
  const {sendUserMessage} = await import('./agents.ts');
  const page = {label: 'Gold Labels', agent: 'front_desk' as const, intent: 'answer', context: {}, where: {page: 'gold' as const, params: {}}};
  await sendUserMessage(w.ws, w.projectId, 'look at these', page, [{name: 'ids.txt', size: 22, content: 'please check 999999 and 888888'}]);
  await w.inst.turnsIdle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspace.attachedExamples, undefined);
  assert.equal(lookups, 0);
  assert.equal((await w.state()).project.holdoutLocked, undefined, 'no project example was read, so nothing locks');
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
  runTurn: async () => ({invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []}),
  cancel: async () => {},
  async reflectPrompt(input) {
    if (fail.left > 0) {
      fail.left--;
      throw new Error('boom');
    }
    const k = (rulesOf(input.prompt).match(/RULE/g) ?? []).length + 1;
    return {prompt: withRules(input.prompt, `${rulesOf(input.prompt)}\nRULE ${k}`.trim()), change: `rule ${k}`};
  },
});

test('an Optimiser run whose labeling waits for its model shows its place, and Stop ends it as stopped (#66, #79)', async () => {
  const w = await world('b5d', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, delayMs: 30});
  const v = await w.newVersion();
  const s0 = await w.state();
  // A labeling task holds the model.
  const task = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'Tester'});
  await new DocRepo(w.db).patch('labeling_tasks', task.id, {state: 'paused', stopReason: 'closed'});
  await tick(w.ws, await w.state());
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['running']})).length === 1, 'the labeling job');
  const {startOptimiser, stopOptimiser} = await import('./work.ts');
  const {runId} = await startOptimiser(w.ws, w.projectId, 10);
  // The run only computes (compute key): its first labeling is a job of its own, behind the model's.
  const queuedLabeling = async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['queued']})).find(j => j.args.optimiserRunId === runId);
  await until(async () => !!(await queuedLabeling()), "the run's labeling job");
  const labelingJob = (await queuedLabeling())!;
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['optimiser.run'], states: ['queued', 'running']})).length === 0, 'the run waits with no job of its own');
  assert.deepEqual([labelingJob.concurrencyKey, labelingJob.args.round, labelingJob.args.step], ['model:default:A', 0, 'parent']);
  const optimiserJobs = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['optimiser.run']});
  assert.ok(optimiserJobs.length >= 1 && optimiserJobs.every(j => j.concurrencyKey === 'compute:default'), 'the run itself waits for compute only');
  const view = (await withQueue(w.ws, w.projectId, await w.state()))!;
  assert.deepEqual(view.optimisation.find(o => o.id === runId)?.queue, {ahead: 0});
  // As if a round was under way when its earlier runner went away.
  await w.catalog.patch('optimisation_runs', runId, {history: [{round: 1, versionId: v.id, outcome: 'running'}] as never});
  await stopOptimiser(w.ws, w.projectId, runId);
  const after = (await w.state()).optimisation.find(o => o.id === runId)!;
  assert.deepEqual([after.state, after.stopReason], ['stopped', 'user'], 'it never started, and does not wait as running');
  assert.equal(after.history.at(-1)?.outcome, 'stopped', 'its round in progress ends too');
  assert.equal((await w.jobs.api.get(w.ws.ctx, labelingJob.id))?.state, 'cancelled', "the run's queued labeling is cancelled");
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation.find(o => o.id === runId)?.state, 'stopped');
});

test('Stop on an Optimiser run whose runner holds its lock asks it to stop; the runner ends the run as stopped (#66, #79)', async () => {
  const w = await world('b5e', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, delayMs: 30});
  await w.newVersion();
  const {stopOptimiser} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  // A runner in another process holds the run's lock: the Stop is saved as a request, never as
  // the state a runner's save could write over.
  await w.ws.locks.run(`optimiser:${w.projectId}:A`, async () => {
    await stopOptimiser(w.ws, w.projectId, runId);
    const asked = (await w.state()).optimisation.find(o => o.id === runId)!;
    assert.deepEqual([asked.state, asked.stopRequested], ['running', true]);
  });
  // The runner (here a later run of it) reads the request before its first save and ends the run as stopped.
  const run = await w.ws.optimiser!.execute(w.ws.ctx, runId);
  assert.deepEqual([run?.state, run?.stopReason], ['stopped', 'user']);
  assert.equal((await w.state()).optimisation.find(o => o.id === runId)?.state, 'stopped');
  await w.jobs.idle();
  assert.equal(w.calls.n, 0, 'nothing was labeled for it');
});

test('a runner that reads a Stop saved meanwhile ends the run as stopped and labels nothing more (#79)', async () => {
  const w = await world('b5g', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  // The Stop lands while the runner works (after it started, before its next save).
  const host = optimiserHost(w.inst);
  const labeling = (w.inst as unknown as {labeling: Parameters<typeof createOptimiser>[0]['labeling']}).labeling;
  const loadState = host.loadState;
  host.loadState = async (ctx, projectId) => {
    await w.catalog.patch('optimisation_runs', runId, {stopRequested: true});
    return loadState(ctx, projectId);
  };
  const opt = createOptimiser({catalog: w.catalog, labeling, agents: ruleAgent(), host, onChange: w.inst.emitChange, random: () => optimiserRandom()});
  const run = await opt.execute(w.ws.ctx, runId);
  assert.deepEqual([run?.state, run?.stopReason], ['stopped', 'user']);
  assert.equal((await w.state()).optimisation[0].state, 'stopped');
  await w.jobs.idle();
  assert.equal(w.calls.n, 0, 'no labeling of a stopped run');
});

test('a Stop asked while a round queues its dry run ends the run and the round as stopped, not failed (#79)', async () => {
  const w = await world('b5j', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  const v = await w.newVersion();
  // The start version is scored already, so round 1 begins at once.
  await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10, startVersionId: v.id});
  const host = optimiserHost(w.inst);
  const label = host.label;
  host.label = async (ctx, req) => {
    // The Stop lands while a runner holds the run, just before the dry run is queued.
    if (req.at.step === 'dry_run') await w.catalog.patch('optimisation_runs', runId, {stopRequested: true});
    return label(ctx, req);
  };
  const labeling = (w.inst as unknown as {labeling: Parameters<typeof createOptimiser>[0]['labeling']}).labeling;
  const opt = createOptimiser({catalog: w.catalog, labeling, agents: ruleAgent(), host, onChange: w.inst.emitChange, random: () => optimiserRandom()});
  const run = await opt.execute(w.ws.ctx, runId);
  assert.deepEqual([run?.state, run?.round, run?.history.at(-1)?.outcome], ['stopped', 1, 'stopped']);
  assert.equal((await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']})).filter(j => j.args.optimiserRunId === runId).length, 0, 'no labeling queued for it');
  await w.jobs.idle();
});

test('a run never waits on labeling another job does: it queues a task of its own, which goes on with it (#79)', async () => {
  const w = await world('b5h', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, delayMs: 20});
  const v = await w.newVersion();
  // Scoring of the start version is labeling it now; its job does not go on with any run.
  const {runIds} = await scoreVersion(w.ws, w.projectId, v);
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['running']})).length === 1, 'the scoring job');
  const {startOptimiser} = await import('./work.ts');
  const {runId} = await startOptimiser(w.ws, w.projectId, 10, v.id);
  await w.jobs.idle();
  const run = (await w.state()).optimisation[0];
  assert.deepEqual([run.state, run.stopReason], ['done', 'passes']);
  const parent = (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']})).find(j => j.args.optimiserRunId === runId && j.args.step === 'parent')!;
  assert.notEqual(parent.args.taskId, runIds[0], "the run's own task, behind the scoring job");
  assert.equal((await w.labeling.getTask(String(parent.args.taskId)))?.purpose, 'optimiser');
});

test('Stop on a run whose labeling waits, then a new run on the same version, runs to the end (#79)', async () => {
  const w = await world('b5i', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, delayMs: 30});
  const v = await w.newVersion();
  const s0 = await w.state();
  // A labeling task holds the model, so the first run's labeling waits in the queue.
  const task = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id).slice(0, 2), createdBy: 'Tester'});
  await new DocRepo(w.db).patch('labeling_tasks', task.id, {state: 'paused', stopReason: 'closed'});
  await tick(w.ws, await w.state());
  const {startOptimiser, stopOptimiser} = await import('./work.ts');
  const first = await startOptimiser(w.ws, w.projectId, 10, v.id);
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['queued']})).some(j => j.args.optimiserRunId === first.runId), "the first run's labeling");
  await stopOptimiser(w.ws, w.projectId, first.runId);
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation.find(o => o.id === first.runId)?.state, 'stopped');
  const firstLabeling = (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']})).find(j => j.args.optimiserRunId === first.runId)!;
  assert.equal((await w.labeling.getTask(String(firstLabeling.args.taskId)))?.state, 'stopped', "the first run's task is stopped, not left with a Stop pending");
  const second = await startOptimiser(w.ws, w.projectId, 10, v.id);
  await w.jobs.idle();
  const run = (await w.state()).optimisation.find(o => o.id === second.runId)!;
  assert.deepEqual([run.state, run.stopReason, run.error], ['done', 'passes', null], 'the stopped task of the first run never stops the second');
});

test('Stop on an Optimiser run never writes over a run its runner ended just before (#66)', async () => {
  const w = await world('b5f', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, delayMs: 30});
  const v = await w.newVersion();
  const s0 = await w.state();
  const task = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'Tester'});
  await new DocRepo(w.db).patch('labeling_tasks', task.id, {state: 'paused', stopReason: 'closed'});
  await tick(w.ws, await w.state());
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['running']})).length === 1, 'the labeling job');
  const {stopOptimiser} = await import('./work.ts');
  // A run with no job (as one whose runner holds it between jobs).
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  // The runner saves its last round and ends the run right after Stop's first read (which still saw it running).
  const optimiser = w.ws.optimiser!;
  const getRun = optimiser.getRun.bind(optimiser);
  let reads = 0;
  optimiser.getRun = async id => {
    const r = await getRun(id);
    if (id === runId && ++reads === 1) await w.catalog.patch('optimisation_runs', runId, {state: 'done', stopReason: 'passes'});
    return r;
  };
  try {
    await stopOptimiser(w.ws, w.projectId, runId);
  } finally {
    optimiser.getRun = getRun;
  }
  const after = (await w.state()).optimisation.find(o => o.id === runId)!;
  assert.deepEqual([after.state, after.stopReason], ['done', 'passes']);
  await w.jobs.idle();
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
  assert.ok(run.history.every(h => h.aimedAt && typeof h.aimedAt.value === 'string'), 'each round records the weakest value it aimed at (#39)');
  assert.ok(s.reports.some(r => r.promptVersionId === run.history[1].versionId && r.passed));
});

test('a Stop on running labeling ends its job cancelled, so its finally runs (#79)', async () => {
  const w = await world('b79d', {delayMs: 30});
  const v = await w.newVersion();
  const {runIds} = await scoreVersion(w.ws, w.projectId, v);
  await until(async () => (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['running']})).length === 1, 'the labeling job');
  const {stopRun} = await import('./evaluation.ts');
  await stopRun(w.ws, w.projectId, runIds[0]);
  await w.jobs.idle();
  const [job] = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']});
  assert.equal(job.state, 'cancelled');
  assert.equal((await w.labeling.getTask(runIds[0]))?.state, 'stopped');
  assert.equal((await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['notify.send']})).length, 1, 'its finally was queued (and sends nothing for a Stop)');
});

test('Auto Optimise as chained jobs (#79): each labeling step is a labeling job on the model key; the run itself only computes', async () => {
  const w = await world('b79a', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  const {runId} = await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  const run = (await w.state()).optimisation[0];
  assert.deepEqual([run.state, run.stopReason], ['done', 'passes']);
  const all = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId});
  const labeling = all.filter(j => j.kind === 'labeling.runTask' && j.args.optimiserRunId === runId).reverse();
  assert.deepEqual(
    labeling.map(j => [j.args.round, j.args.step, j.concurrencyKey]),
    [
      [0, 'parent', 'model:default:A'],
      [1, 'dry_run', 'model:default:A'],
      [1, 'full', 'model:default:A'],
      [2, 'dry_run', 'model:default:A'],
      [2, 'full', 'model:default:A'],
      [2, 'confirm', 'model:default:A'],
    ],
    'every labeling step is queued as its own job, in order',
  );
  const loops = all.filter(j => j.kind === 'optimiser.run');
  assert.ok(loops.every(j => j.concurrencyKey === 'compute:default'));
  assert.equal(loops.length, labeling.length + 1, 'one start, then one follow-up after each labeling job');
  assert.ok(loops.filter(j => j.args.step).every(j => j.idempotencyKey === `optimiser:${runId}:${j.args.round}:${j.args.step}`));
  assert.ok(all.every(j => j.state === 'done' || (j.kind === 'optimiser.run' && j.state === 'paused')), 'no job of the chain failed');
  // A job that leaves the run waiting ends paused (no end), so only the job that ended the run queues the notice.
  assert.equal(loops.filter(j => j.state === 'done').length, 1, 'one job ended the run');
  assert.equal(all.filter(j => j.kind === 'notify.send').length, 1, 'one notice is queued for the whole chain');
  assert.ok(run.history.every(h => h.dryRunIds?.length === 2), 'the dry run examples are saved on the round');
});

test('Auto Optimise as chained jobs (#79): the sweep goes on with a run left at a labeling step; its labeling never ran, so it fails, and Retry finishes it', async () => {
  const w = await world('b79b', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {retryOptimiser} = await import('./work.ts');
  // A run left waiting for its first labeling, whose jobs were lost (a closed page).
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  await w.catalog.patch('optimisation_runs', runId, {step: 'parent', stepStartedAt: new Date().toISOString()});
  await tick(w.ws, await w.state());
  const followUp = (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['optimiser.run']}))[0];
  // Its own key, so the follow-up a labeling job's end queues as the run's starter is never taken over.
  assert.deepEqual([followUp.args.round, followUp.args.step, followUp.idempotencyKey], [0, 'parent', `optimiser:${runId}:0:parent:sweep`]);
  await w.jobs.idle();
  const failed = (await w.state()).optimisation[0];
  assert.equal(failed.state, 'failed');
  assert.match(failed.error ?? '', /never started/);
  await retryOptimiser(w.ws, w.projectId, runId);
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation[0].state, 'done', 'Retry queues the labeling again and the run goes on');
});

test('Auto Optimise as chained jobs (#79): a run lost while its labeling waited is failed, and its task is never resumed as scoring', async () => {
  const w = await world('b79e', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  const v = await w.newVersion();
  const s0 = await w.state();
  const {retryOptimiser} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10, startVersionId: v.id});
  // Its first labeling task exists, but its job was lost (a closed page): left paused.
  const task = await w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'optimiser', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: s0.examples.map(e => e.id), createdBy: 'optimiser'});
  await new DocRepo(w.db).patch('labeling_tasks', task.id, {state: 'paused', stopReason: 'closed'});
  await w.catalog.patch('optimisation_runs', runId, {step: 'parent'});
  // Scoring the version is due too, but never by resuming the run's own task.
  await tick(w.ws, await w.state());
  const labeling = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask']});
  assert.ok(labeling.every(j => j.args.taskId !== task.id), "the run's task is not resumed by the sweep");
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation[0].state, 'failed', 'the run waits for Retry');
  await retryOptimiser(w.ws, w.projectId, runId);
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation[0].state, 'done');
});

test('Auto Optimise as chained jobs (#79): the sweep fails a run lost between labeling steps; Retry goes on', async () => {
  const w = await world('b79c', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {retryOptimiser} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  await w.catalog.patch('optimisation_runs', runId, {step: 'reflect', round: 1, history: [{round: 1, versionId: null, parentId: 'x', kind: 'change', change: '', outcome: 'running', score: null, passed: false, dryRun: null, step: 'reflect'}]});
  await tick(w.ws, await w.state());
  const failed = (await w.state()).optimisation[0];
  assert.deepEqual([failed.state, failed.history.at(-1)?.outcome, failed.history.at(-1)?.step], ['failed', 'failed', 'reflect']);
  assert.equal((await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['optimiser.run']})).length, 0, 'nothing to go on with: no follow-up is queued');
  await retryOptimiser(w.ws, w.projectId, runId);
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation[0].state, 'done');
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

  // Improve with AI's brief (#39): the skill reads it with get_mistakes.
  const brief = (await call('get_mistakes', {version: 'v1'})) as {examples: object[]; mixUps: object[]};
  assert.ok(brief.examples.length > 0);
  assert.deepEqual(leaks(brief), [], 'examples and mix-ups come from the optimiser half');
  assert.ok(brief.mixUps.every(m => !('exampleIds' in m)), 'mix-ups as counts only');
});

test('R4-4: the labeler\'s Why reaches the helpers for optimiser-half examples only', async () => {
  const agents = ruleAgent();
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
  const brief = (await toolsOf(w).call({agent: 'prompt_agent', name: 'get_mistakes', args: {version: 'v1'}})) as {examples: {externalId: string; comments?: string[]}[]};
  assert.deepEqual(brief.examples.find(b => b.externalId === mine.externalId)?.comments, ['Shown at work, so it is a Tutorial']);
  assert.ok(!JSON.stringify(brief).includes('A held-out note'));
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
const knownItems = {lookup: async (ids: string[]) => ids.filter(id => !id.startsWith('gone')).map(externalId => ({externalId, type: 'video' as const, title: '', features: {Description: {text: externalId}}}))};

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
  // Sample numbers (docs/design/server.md 4.2): 1..n with no repeat, the added ones after the first take.
  const numbers = s.examples.map(e => e.number!).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({length: numbers.length}, (_, i) => i + 1));
  assert.equal(s.snapshot?.numbered, true);
  assert.ok(['b1', 'b2', 'b3'].some(id => s.examples.find(e => e.externalId === id)!.number! > 7), 'the second take is numbered after the first');
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
  const numbers = () => saved.map(e => e.number!).sort((a, b) => a - b);
  assert.deepEqual(numbers(), [2, 3, 4, 5, 6, 7, 8, 9, 10], 'the sample that was not saved leaves its number unused; nothing is renumbered');
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
  const after = (await app.catalog.find('examples', {snapshotId: snap.id})).map(e => e.number!).sort((a, b) => a - b);
  assert.deepEqual(after.slice(-2), [11, 12], 'added samples follow the last number');
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
      // i05 passes its checks but no features come back: excluded as noFeatures (#48, superseding #32).
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
    assert.deepEqual(snap.counts.checks, {missing: 1, minorCreator: 2, notRecommendable: 1, noFeatures: 1});
    assert.deepEqual([snap.counts.valid, snap.counts.invalid, state.examples.length], [15, 5, 15]);
    assert.ok(lookups.every(n => n <= 7), 'features are fetched a batch at a time');
    assert.ok(state.examples.every(e => !('features' in e)), 'project state carries the index only');
    assert.equal(state.examples.find(e => e.externalId === 'i06')?.type, 'photo_text', 'the kind comes from the checks');
    assert.equal(state.examples.find(e => e.externalId === 'i05'), undefined, 'zero-feature item i05 is excluded');
    const stored = await w.catalog.find('examples', {snapshotId: snap.id});
    assert.ok(stored.every(e => !('features' in e)), 'example records hold no features');
    const docs = await w.catalog.find('example_features', {snapshotId: snap.id});
    assert.equal(docs.length, 15);
    assert.ok(docs.every(d => d.id === `${snap.id}:${d.externalId}`));
    assert.ok((snap.featureSizes?.video?.Description?.chars ?? 0) > 0, 'average sizes are kept for estimates');
    const i07 = state.examples.find(e => e.externalId === 'i07')!;
    assert.deepEqual(await exampleFeatures(w.ws, p.id, [i07.id]), {[i07.id]: {Description: {text: 'about i07'}}});
    // Another project's examples are never read through this one.
    const other = await createProject(w.ws, 'Other');
    assert.deepEqual(await exampleFeatures(w.ws, other.id, [i07.id]), {});
    // Adding more: the counts add up.
    problems.j01 = 'missing';
    const more = await sourceOf(w, 'More', ['j00', 'j01', 'j02']);
    await takeExamples(w.ws, p.id, [{sourceId: more, count: 3}]);
    await w.jobs.idle();
    const after = (await loadProjectState(w.ws, p.id))!.snapshot!;
    assert.deepEqual([after.counts.valid, after.counts.checks], [17, {missing: 2, minorCreator: 2, notRecommendable: 1, noFeatures: 1}]);
    assert.equal((await w.catalog.find('example_features', {snapshotId: snap.id})).length, 17);
  } finally {
    configureSystem();
  }
});

test('frozen features in object storage (#72): a take writes one segment file per batch, examples keep where their features are, reads come back by range, and deleting the project leaves no object behind', async () => {
  const {configureSystem} = await import('@yushiguang/sprint-domain');
  const objects = memoryObjectStore();
  const puts: string[] = [];
  const ranges: string[] = [];
  const watched: ObjectStorePort = {...objects, put: (k, b, o) => (puts.push(k), objects.put(k, b, o)), getRange: (k, off, len) => (ranges.push(k), objects.getRange(k, off, len))};
  const w = await world('fzo', {gold: null, objects: watched});
  let failOnce = 1;
  const source: ExampleSource = {
    async lookup(ids) {
      return ids.map(externalId => ({externalId, type: 'video' as const, title: `t ${externalId}`, features: {Description: {text: `about ${externalId} é`}}}));
    },
  };
  Object.assign(w.inst, {examples: source});
  // The first segment write fails on the way: tried once more, nothing is lost.
  const put = watched.put;
  watched.put = async (k, b, o) => {
    if (failOnce-- > 0) throw new Error('storage blip');
    return put(k, b, o);
  };
  configureSystem({dataset: {featureBatch: 4}});
  try {
    const {createProject, deleteProject} = await import('./projects.ts');
    const {takeExamples} = await import('./dataset.ts');
    const {exampleFeatures} = await import('./features.ts');
    const ids = Array.from({length: 10}, (_, i) => `o${i}`);
    const sourceId = await sourceOf(w, 'Feed', ids);
    const p = await createProject(w.ws, 'Objects');
    await takeExamples(w.ws, p.id, [{sourceId, count: 10}]);
    await w.jobs.idle();
    const state = (await loadProjectState(w.ws, p.id))!;
    assert.equal(state.examples.length, 10);
    assert.equal(puts.length, 3, `10 examples in batches of 4: 3 segment files (${puts.join(' ')})`);
    assert.ok(puts.every(k => k.startsWith(`features/${state.snapshot!.id}/`) && k.endsWith('.jsonl')));
    assert.equal((await w.catalog.find('example_features', {})).length, 0, 'no feature documents');
    const stored = await w.catalog.find('examples', {snapshotId: state.snapshot!.id});
    assert.ok(stored.every(e => e.featureRef && puts.includes(e.featureRef.key)), 'every example keeps where its features are');
    ranges.length = 0;
    const got = await exampleFeatures(w.ws, p.id, stored.map(e => e.id));
    assert.equal(Object.keys(got).length, 10);
    assert.deepEqual(got[stored.find(e => e.externalId === 'o7')!.id], {Description: {text: 'about o7 é'}});
    assert.equal(ranges.length, 3, 'one range read per segment file');
    await deleteProject(w.ws, p.id);
    await w.jobs.idle();
    assert.deepEqual(objects.keys(), [], 'the segment files are gone');
  } finally {
    configureSystem();
  }
});

test('frozen features in object storage (#72): a batch whose segment file cannot be written twice is skipped whole; no example of it is saved, the other batches are', async () => {
  const {configureSystem} = await import('@yushiguang/sprint-domain');
  const objects = memoryObjectStore();
  let puts = 0;
  // The second batch's segment fails both tries.
  const flaky: ObjectStorePort = {...objects, put: (k, b, o) => (++puts === 2 || puts === 3 ? Promise.reject(new Error('storage down')) : objects.put(k, b, o))};
  const w = await world('fzo2', {gold: null, objects: flaky});
  Object.assign(w.inst, {examples: {async lookup(ids: string[]) {
    return ids.map(externalId => ({externalId, type: 'video' as const, title: '', features: {Description: {text: `about ${externalId}`}}}));
  }} satisfies ExampleSource});
  configureSystem({dataset: {featureBatch: 4}});
  try {
    const {createProject} = await import('./projects.ts');
    const {takeExamples} = await import('./dataset.ts');
    const sourceId = await sourceOf(w, 'Feed', Array.from({length: 10}, (_, i) => `q${i}`));
    const p = await createProject(w.ws, 'Flaky');
    await takeExamples(w.ws, p.id, [{sourceId, count: 10}]);
    await w.jobs.idle();
    const state = (await loadProjectState(w.ws, p.id))!;
    assert.equal(state.examples.length, 6, '10 in batches of 4: the second batch (4) is skipped');
    assert.equal(objects.keys().length, 2);
    const stored = await w.catalog.find('examples', {snapshotId: state.snapshot!.id});
    assert.ok(stored.every(e => e.featureRef && objects.keys().includes(e.featureRef.key)), 'no example without its features');
  } finally {
    configureSystem();
  }
});

test('frozen snapshots (#32): adding items that are all in the dataset already still counts what the checks left out', async () => {
  const w = await world('fz2', {gold: null});
  const {appendExamples} = await import('./governance.ts');
  const before = (await loadProjectState(w.ws, w.projectId))!.snapshot!;
  const r = await appendExamples(w.ws, w.projectId, [{externalId: '0', type: 'video', title: '', features: {}}], 'sources', 2, {missing: 1, minorCreator: 1, notRecommendable: 0});
  assert.deepEqual([r.added, r.duplicates], [0, 1]);
  const after = (await loadProjectState(w.ws, w.projectId))!.snapshot!;
  assert.deepEqual(after.counts.checks, {missing: 1, minorCreator: 1, notRecommendable: 0});
  assert.deepEqual([after.counts.invalid, after.counts.valid], [before.counts.invalid + 2, before.counts.valid]);
});

test('frozen snapshots (#32): a new dataset whose items are all left out by the checks says which checks', async () => {
  const w = await world('fz3', {gold: null});
  Object.assign(w.inst, {examples: {lookup: async () => [], check: async (ids: string[]) => ids.map(externalId => ({externalId, type: null, problem: externalId === 'k0' ? 'missing' : 'minor_creator'}))}});
  const {createProject} = await import('./projects.ts');
  const {takeExamples, getSamplingTask} = await import('./dataset.ts');
  const sourceId = await sourceOf(w, 'Kids', ['k0', 'k1', 'k2']);
  const p = await createProject(w.ws, 'Left out');
  await takeExamples(w.ws, p.id, [{sourceId, count: 3}]);
  await w.jobs.idle();
  assert.match((await getSamplingTask(w.ws, p.id))?.error ?? '', /None of these items can be used: 1 not found, 2 from a creator under 18/);
});

test('agent abilities (#39): get_gates names what each step waits for, with the numbers behind it', async () => {
  const w = await world('ab1', {gold: null, goldApproved: false});
  const tools = toolsOf(w);
  const g = (await tools.call({agent: 'front_desk', name: 'get_gates', args: {}})) as {current: string; steps: {step: string; approved: boolean; canApprove: boolean; waitsFor: string | null}[]; numbers: {goldLabeled: number; goldLabeledPerHalf: {optimiser: number; heldOut: number}}};
  assert.equal(g.current, 'Prompt Design', 'no step approved yet');
  const gold = g.steps.find(s => s.step === 'Gold Labels')!;
  assert.deepEqual([gold.approved, gold.canApprove], [false, false]);
  assert.match(gold.waitsFor ?? '', /Label at least 4 examples/);
  assert.deepEqual([g.numbers.goldLabeled, g.numbers.goldLabeledPerHalf], [0, {optimiser: 0, heldOut: 0}]);
  assert.match(g.steps.find(s => s.step === 'Prompt Design')!.waitsFor ?? '', /Approve the first prompt/);
});

test('agent abilities (#39): get_running_work shows scoring while it runs, then nothing', async () => {
  const w = await world('ab2', {delayMs: 30});
  await w.newVersion();
  await tick(w.ws, await w.state());
  const tools = toolsOf(w);
  const busy = (await tools.call({agent: 'front_desk', name: 'get_running_work', args: {}})) as {labeling: {version: string; why: string; of: number; stoppable: boolean}[]; note?: string};
  assert.equal(busy.labeling.length, 1);
  assert.deepEqual([busy.labeling[0].version, busy.labeling[0].why, busy.labeling[0].of, busy.labeling[0].stoppable], ['v1', 'scoring', EVAL, true]);
  assert.equal(busy.note, undefined);
  await w.jobs.idle();
  const idle = (await tools.call({agent: 'front_desk', name: 'get_running_work', args: {}})) as {labeling: unknown[]; note?: string};
  assert.deepEqual(idle.labeling, []);
  assert.match(idle.note ?? '', /Nothing is running/);
});

test('agent abilities (#39): get_upload_result gives refused rows by number and reason, never their item ids', async () => {
  const w = await world('ab3', {gold: null});
  const s = await w.state();
  const {uploadGoldText} = await import('./dataset.ts');
  await uploadGoldText(w.ws, w.projectId, schema, 1, s.examples, 'labels.jsonl', '{"externalId":"0","answer":"Vlog"}\n{"externalId":"1","answer":"Cooking"}\n{"externalId":"nope","answer":"Vlog"}\nnot json\n');
  const tools = toolsOf(w);
  const r = (await tools.call({agent: 'front_desk', name: 'get_upload_result', args: {}})) as {labelUploads: {file: string; saved: number; notInDataset: number; refused: number; refusedRows: {row: number; reason: string}[]}[]; dataset: {examplesSaved: number}};
  assert.equal(r.labelUploads.length, 1);
  const u = r.labelUploads[0];
  assert.deepEqual([u.file, u.saved, u.notInDataset, u.refused], ['labels.jsonl', 1, 1, 2]);
  assert.deepEqual(u.refusedRows, [{row: 2, reason: '"Cooking" isn\'t a value of format'}, {row: 4, reason: 'The row is not valid JSON'}]);
  assert.ok(!JSON.stringify(r.labelUploads).includes('"1"'), 'no item id');
  assert.equal(r.dataset.examplesSaved, EVAL);
  // A file refused as a whole is listed too, newest first, with why.
  await new Promise(res => setTimeout(res, 5));
  const bad = await uploadGoldText(w.ws, w.projectId, schema, 1, s.examples, 'labels.pdf', 'x');
  assert.ok(bad.error);
  const again = (await tools.call({agent: 'front_desk', name: 'get_upload_result', args: {}})) as {labelUploads: {file: string; saved: number; rejectedWholeFile?: string}[]};
  assert.deepEqual([again.labelUploads.length, again.labelUploads[0].file, again.labelUploads[0].saved, again.labelUploads[0].rejectedWholeFile], [2, 'labels.pdf', 0, bad.error]);
});

test('agent abilities (#39): get_optimiser_run explains each round; numbering starts at the first run', async () => {
  const w = await world('ab4');
  const v1 = await w.newVersion();
  const round = (n: number, outcome: string, extra: object = {}) => ({round: n, versionId: null, parentId: v1.id, parentWins: n === 1 ? null : 3, kind: 'change', change: `change ${n}`, outcome, score: null, passed: false, dryRun: {examples: 4, passed: 1, parentPassed: 2}, aimedAt: {value: 'Tutorial', f1: 0.4321}, ...extra});
  const run = (id: string, startedAt: string, history: object[], stopReason: string) => ({id, projectId: w.projectId, endpoint: 'A', startVersionId: v1.id, major: 1, maxRounds: 5, round: history.length, state: 'done', step: null, stepStartedAt: null, stepVersionId: null, history, calls: 0, candidates: 0, costUsd: 0, stopReason, error: null, startedAt, finishedAt: startedAt});
  await w.catalog.insert('optimisation_runs', run('or_1', '2026-11-01T00:00:00.000Z', [round(1, 'dropped')], 'user') as never);
  await w.catalog.insert('optimisation_runs', run('or_2', '2026-11-02T00:00:00.000Z', [round(1, 'dropped'), round(2, 'repeat')], 'no_new_ideas') as never);
  const tools = toolsOf(w);
  const newest = (await tools.call({agent: 'evaluation_agent', name: 'get_optimiser_run', args: {}})) as {run: number; runs: number; rounds: {whyThatVersion: string; aimedAt: {value: string; f1: number}; outcomeMeans: string; dryRun: object}[]; stopReasonMeans: string};
  assert.deepEqual([newest.run, newest.runs, newest.rounds.length], [2, 2, 2]);
  assert.match(newest.rounds[0].whyThatVersion, /started from/);
  assert.match(newest.rounds[1].whyThatVersion, /best version on 3 examples/);
  assert.deepEqual(newest.rounds[0].aimedAt, {value: 'Tutorial', f1: 0.43});
  assert.match(newest.rounds[0].outcomeMeans, /did worse/);
  assert.match(newest.stopReasonMeans, /nothing better/);
  const first = (await tools.call({agent: 'evaluation_agent', name: 'get_optimiser_run', args: {run: 1}})) as {run: number; rounds: unknown[]};
  assert.deepEqual([first.run, first.rounds.length], [1, 1]);
  await assert.rejects(tools.call({agent: 'evaluation_agent', name: 'get_optimiser_run', args: {run: 3}}), /no run 3/);
});

test('agent abilities (#39): get_drafts recalls discarded drafts with their reasons, for the Prompt helper only', async () => {
  const w = await world('ab5');
  const v1 = await w.newVersion();
  await w.catalog.insert('agent_proposals', {id: 'ap_ab5', projectId: w.projectId, agent: 'prompt_agent', kind: 'prompt', payload: {structured: sp('Prefer Vlog.'), change: 'Prefer Vlog', changes: [{text: 'Prefer Vlog.', reason: '3 Vlogs were read as Tutorial'}], baseVersionId: v1.id, unmapped: []}, brief: 'Improve v1', state: 'discarded', createdAt: '2026-11-19T00:00:00.000Z'});
  const tools = toolsOf(w);
  const d = (await tools.call({agent: 'prompt_agent', name: 'get_drafts', args: {}})) as {total: number; drafts: {state: string; from: string; changes: {reason: string}[]}[]};
  assert.equal(d.total, 1);
  assert.deepEqual([d.drafts[0].state, d.drafts[0].from, d.drafts[0].changes[0].reason], ['discarded', 'v1', '3 Vlogs were read as Tutorial']);
  await assert.rejects(tools.call({agent: 'front_desk', name: 'get_drafts', args: {}}), /cannot use get_drafts/);
});

test('agent abilities (#39): read_guide finds a topic by name or by a word people use, and lists topics otherwise', async () => {
  const w = await world('ab6');
  const tools = toolsOf(w);
  const call = (topic?: string) => tools.call({agent: 'front_desk', name: 'read_guide', args: topic ? {topic} : {}}) as Promise<{topic?: string; text?: string; topics?: {topic: string}[]; error?: string}>;
  assert.equal((await call('held-out half')).topic, 'halves');
  assert.equal((await call('macro_f1')).topic, 'macro_f1');
  assert.equal((await call('Rebuild scores')).topic, 'rebuild_scores');
  const list = await call();
  assert.ok((list.topics?.length ?? 0) >= 10);
  const none = await call('quantum');
  assert.match(none.error ?? '', /No guide topic/);
  assert.ok(none.topics);
});

test('agent abilities (#39): get_flips and get_confusions read two scored versions, from the optimiser half only', async () => {
  // v1 answers Vlog everywhere; v2 (one RULE) is right on 0-4. Gold: Tutorial on 0-7, Vlog on 8-9.
  const w = await world('ab7', {answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  await w.newVersion('RULE 1');
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 2, 'v2 scored');
  const s = await w.state();
  const heldOut = new Set(s.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).flatMap(e => [e.externalId, e.id]));
  const leaks = (x: unknown) => [...heldOut].filter(id => new RegExp(`"(id|externalId|exampleId)":"${id}"`).test(JSON.stringify(x)));
  const tools = toolsOf(w);
  const f = (await tools.call({agent: 'evaluation_agent', name: 'get_flips', args: {a: 'v1', b: 'v2'}})) as {a: {version: string}; b: {version: string}; fixed: {id: string; a: string[]; b: string[]; gold: string[]}[]; broken: object[]; promptB: StructuredPrompt};
  assert.deepEqual([f.a.version, f.b.version], ['v1', 'v2']);
  assert.ok(f.fixed.length > 0);
  assert.ok(f.fixed.every(x => x.a[0] === 'Vlog' && x.b[0] === 'Tutorial' && x.gold[0] === 'Tutorial'));
  assert.equal(f.broken.length, 0);
  assert.match(f.promptB.ruleGroups[0].content, /RULE 1/);
  assert.deepEqual(leaks(f), [], 'flipped examples come from the optimiser half');
  // b defaults to the newest scored and a to the one before it.
  const d = (await tools.call({agent: 'evaluation_agent', name: 'get_flips', args: {}})) as {a: {version: string}; b: {version: string}};
  assert.deepEqual([d.a.version, d.b.version], ['v1', 'v2']);
  // A newer version still unscored (or dropped after a dry run) is skipped by the defaults, and
  // an empty name counts as left out.
  await w.newVersion('RULE 2');
  const later = (await tools.call({agent: 'evaluation_agent', name: 'get_flips', args: {a: '', b: ''}})) as {a: {version: string}; b: {version: string}};
  assert.deepEqual([later.a.version, later.b.version], ['v1', 'v2']);
  await assert.rejects(tools.call({agent: 'evaluation_agent', name: 'get_flips', args: {b: 'v1'}}), /No version older than v1 has scores/);
  await assert.rejects(tools.call({agent: 'evaluation_agent', name: 'get_flips', args: {a: 'v2', b: 'v2'}}), /two different versions/);
  await assert.rejects(tools.call({agent: 'front_desk', name: 'get_flips', args: {}}), /cannot use get_flips/);

  const c = (await tools.call({agent: 'prompt_agent', name: 'get_confusions', args: {}})) as {scoredVersions: number; mixUps: {gold: string; predicted: string; count: number; inVersions: string[]}[]; balance: {value: string}[]};
  assert.equal(c.scoredVersions, 2);
  const top = c.mixUps[0];
  assert.deepEqual([top.gold, top.predicted], ['Tutorial', 'Vlog']);
  assert.deepEqual(top.inVersions.sort(), ['v1', 'v2'], 'summed over the versions it comes back in');
  assert.ok(c.mixUps.every(m => !('exampleIds' in m)), 'counts only, never examples');
  assert.deepEqual(c.balance.map(b => b.value).sort(), [...schema.values.map(v => v.name)].sort());
  // On Prompt Design before v1 is approved there is no saved label: the review works from the
  // prompt on the page, with nothing scored.
  const {confusions} = await import('./agent-reads.ts');
  const st = await w.state();
  const early = confusions({...st, setup: {...st.setup!, schema: null}} as never) as {label: null; mixUps: unknown[]; note: string};
  assert.deepEqual([early.label, early.mixUps], [null, []]);
  assert.match(early.note, /prompt on the page/);
});

test('agent abilities (#39): Improve with AI is a Prompt helper turn, and its draft goes on the version it improves', async () => {
  const seen: AgentTurnRequest[] = [];
  const agents = ruleAgent();
  const w = await world('ab8', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  agents.runTurn = async input => {
    seen.push(input);
    // The skill reads its brief through the tool host, as the runtime does.
    const brief = (await toolsOf(w).call({agent: 'prompt_agent', name: 'get_mistakes', args: {version: (input.page.context as {version: string}).version}})) as {prompt: StructuredPrompt; versionId: string};
    const structured = {...brief.prompt, taskSummary: 'Label this, sharper.'};
    return {invocations: [{from: 'user', to: 'prompt_agent', intent: 'improve', note: ''}], messages: [], proposal: {kind: 'prompt', agent: 'prompt_agent', brief: 'Improve v1', payload: {structured, change: 'sharper', changes: [{text: 'sharper', reason: '5 Tutorials were read as Vlog'}], baseVersionId: brief.versionId, unmapped: []}}, skills: [{agent: 'prompt_agent', name: 'improve_from_mistakes'}], toolCalls: [], modelCalls: [], parseFailures: []};
  };
  const v1 = await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  await w.newVersion('RULE 1'); // the newest version is v2; the user improves v1
  const {improveWithAi, chatHistory, openProposals} = await import('./agents.ts');
  await assert.rejects(improveWithAi(w.ws, w.projectId, 'pv_none'), /not found/);
  const {turnId} = await improveWithAi(w.ws, w.projectId, v1.id, 'zh');
  assert.ok(turnId);
  await until(async () => (await openProposals(w.ws, w.projectId)).length === 1, 'the draft');
  assert.deepEqual([seen[0].page.agent, seen[0].page.intent, seen[0].page.context, seen[0].locale], ['prompt_agent', 'improve', {version: 'v1'}, 'zh']);
  assert.deepEqual(seen[0].page.where, {page: 'prompt_edit', params: {v: v1.id}});
  const [p] = await openProposals(w.ws, w.projectId);
  assert.equal(p.payload.baseVersionId, v1.id);
  assert.equal(p.payload.changes?.[0].reason, '5 Tutorials were read as Vlog');
  const chat = await chatHistory(w.ws, w.projectId);
  assert.equal(chat.filter(m => m.role === 'user').length, 0, 'a button, not a message');
  assert.deepEqual(chat.filter(m => m.role === 'event').map(m => m.msg?.key).slice(-2), ['{who} asked the Prompt helper to improve {version}', '{who} put a draft on {page}']);
  // Discard in the editor closes the draft as discarded, and the helper can recall it (T8).
  const {closeProposal} = await import('./agents.ts');
  await closeProposal(w.ws, p, 'discarded');
  const drafts = (await toolsOf(w).call({agent: 'prompt_agent', name: 'get_drafts', args: {}})) as {drafts: {state: string; from: string; changes: {reason: string}[]}[]};
  assert.deepEqual([drafts.drafts[0].state, drafts.drafts[0].from, drafts.drafts[0].changes[0].reason], ['discarded', 'v1', '5 Tutorials were read as Vlog']);
});

test('feature missingness (#48): take excludes zero-feature items, persists exact integer missingness, and names no-feature items when all are excluded', async () => {
  const w = await world('fm1', {gold: null});
  const items: Record<string, {type: 'video' | 'photo_text'; features: Record<string, {text?: string; items?: string[]}>} | null> = {
    v1: {type: 'video', features: {Description: {text: 'hello'}, ASR: {text: 'speech'}, Language: {text: 'en'}}},
    v2: {type: 'video', features: {Description: {text: 'only desc'}, ASR: {text: '   '}, Cover: {items: []}}},
    v3: {type: 'video', features: {Description: {text: '  '}, Cover: {items: []}}}, // zero non-empty features
    v4: null, // passes check as video, omitted by lookup -> zero-feature excluded
    p1: {type: 'photo_text', features: {Title: {text: 'pic'}, Images: {items: ['https://example.invalid/1.jpg']}, Language: {text: 'en'}}},
    p2: {type: 'photo_text', features: {}}, // zero non-empty features
  };
  Object.assign(w.inst, {
    examples: {
      async check(ids: string[]) {
        return ids.map(externalId => ({externalId, type: externalId.startsWith('p') ? ('photo_text' as const) : ('video' as const), problem: null}));
      },
      async lookup(ids: string[]) {
        return ids
          .filter(id => items[id] != null)
          .map(externalId => ({externalId, type: items[externalId]!.type, title: `t ${externalId}`, features: items[externalId]!.features}));
      },
    } satisfies ExampleSource,
  });
  const {createProject} = await import('./projects.ts');
  const {takeExamples, getSamplingTask} = await import('./dataset.ts');
  const p = await createProject(w.ws, 'Missingness');
  const src = await sourceOf(w, 'Mix', ['v1', 'v2', 'v3', 'v4', 'p1', 'p2']);
  await takeExamples(w.ws, p.id, [{sourceId: src, count: 6}]);
  await w.jobs.idle();
  const state = (await loadProjectState(w.ws, p.id))!;
  const snap = state.snapshot!;
  assert.deepEqual(state.examples.map(e => e.externalId).sort(), ['p1', 'v1', 'v2']);
  assert.deepEqual(snap.counts.checks, {missing: 0, minorCreator: 0, notRecommendable: 0, noFeatures: 3});
  assert.deepEqual([snap.counts.valid, snap.counts.invalid], [3, 3]);
  const fm = snap.featureMissingness!;
  assert.equal(fm.version, 1);
  assert.deepEqual(fm.zeroFeatureExcluded, {video: 2, photo_text: 1});
  assert.equal(fm.byType.video?.examples, 2);
  assert.equal(fm.byType.video?.missing.Description, 0);
  assert.equal(fm.byType.video?.missing.ASR, 1);
  assert.equal(fm.byType.video?.missing.Cover, 2);
  assert.equal(fm.byType.video?.missing.Language, 1);
  assert.equal(fm.byType.photo_text?.examples, 1);
  assert.equal(fm.byType.photo_text?.missing.Title, 0);
  assert.equal(fm.byType.photo_text?.missing.Images, 0);
  assert.equal(fm.byType.photo_text?.missing.Description, 1);
  assert.equal(fm.byType.photo_text?.missing.Language, 0);

  // When every item in a new dataset has no features, the error says "with no features".
  const pEmpty = await createProject(w.ws, 'AllEmpty');
  const emptySrc = await sourceOf(w, 'Empty', ['v3', 'v4', 'p2']);
  await takeExamples(w.ws, pEmpty.id, [{sourceId: emptySrc, count: 3}]);
  await w.jobs.idle();
  assert.match((await getSamplingTask(w.ws, pEmpty.id))?.error ?? '', /None of these items can be used: 3 with no features/);
});

test('feature missingness (#48): append merges missingness, zero-added append still accumulates exclusions, and legacy snapshots stay undefined', async () => {
  const w = await world('fm2', {gold: null});
  const items: Record<string, {type: 'video' | 'photo_text'; features: Record<string, {text?: string}>}> = {
    a1: {type: 'video', features: {Description: {text: 'one'}, ASR: {text: 'say'}}},
    a2: {type: 'video', features: {Description: {text: 'two'}}},
    a3: {type: 'video', features: {}},
    a4: {type: 'photo_text', features: {}},
  };
  Object.assign(w.inst, {
    examples: {
      async check(ids: string[]) {
        return ids.map(externalId => ({externalId, type: items[externalId]?.type ?? 'video', problem: null}));
      },
      async lookup(ids: string[]) {
        return ids.map(externalId => ({externalId, type: items[externalId].type, title: externalId, features: items[externalId].features}));
      },
    } satisfies ExampleSource,
  });
  const {createProject} = await import('./projects.ts');
  const {takeExamples} = await import('./dataset.ts');
  const p = await createProject(w.ws, 'Append');
  const s1 = await sourceOf(w, 'S1', ['a1']);
  await takeExamples(w.ws, p.id, [{sourceId: s1, count: 1}]);
  await w.jobs.idle();
  // Append usable + zero-feature item.
  const s2 = await sourceOf(w, 'S2', ['a2', 'a3']);
  await takeExamples(w.ws, p.id, [{sourceId: s2, count: 2}]);
  await w.jobs.idle();
  const mid = (await loadProjectState(w.ws, p.id))!.snapshot!;
  assert.equal(mid.featureMissingness?.byType.video?.examples, 2);
  assert.equal(mid.featureMissingness?.byType.video?.missing.ASR, 1);
  assert.deepEqual(mid.featureMissingness?.zeroFeatureExcluded, {video: 1});
  assert.equal(mid.counts.checks?.noFeatures, 1);
  // Zero-added append: duplicate a1 + zero-feature a4.
  const s3 = await sourceOf(w, 'S3', ['a1', 'a4']);
  await takeExamples(w.ws, p.id, [{sourceId: s3, count: 2}]);
  await w.jobs.idle();
  const after = (await loadProjectState(w.ws, p.id))!.snapshot!;
  assert.equal(after.featureMissingness?.byType.video?.examples, 2);
  assert.deepEqual(after.featureMissingness?.zeroFeatureExcluded, {video: 1, photo_text: 1});
  assert.equal(after.counts.checks?.noFeatures, 2);

  // Legacy snapshot (no featureMissingness, valid > 0) stays undefined after append.
  const {appendExamples} = await import('./governance.ts');
  const legacyBefore = (await loadProjectState(w.ws, w.projectId))!.snapshot!;
  assert.equal(legacyBefore.featureMissingness, undefined);
  await appendExamples(w.ws, w.projectId, [{externalId: 'leg1', type: 'video', title: 'L1', features: {Description: {text: 'hi'}}}], 'sources', 1, {missing: 0, minorCreator: 0, notRecommendable: 0, noFeatures: 1}, {video: 1});
  const legacyAfter = (await loadProjectState(w.ws, w.projectId))!.snapshot!;
  assert.equal(legacyAfter.featureMissingness, undefined);
  assert.equal(legacyAfter.counts.checks?.noFeatures, 1);
});

test('feature missingness (#48): remove, restore, and prune live-adjust byType, and stats failure never blocks removal', async () => {
  const w = await world('fm3', {gold: null});
  const items: Record<string, {type: 'video' | 'photo_text'; features: Record<string, {text?: string}>}> = {
    v1: {type: 'video', features: {Description: {text: 'd1'}, ASR: {text: 'a1'}}},
    v2: {type: 'video', features: {Description: {text: 'd2'}}},
    v3: {type: 'video', features: {Description: {text: 'd3'}}},
    p1: {type: 'photo_text', features: {Title: {text: 'p1'}}},
    z1: {type: 'video', features: {}},
  };
  Object.assign(w.inst, {
    examples: {
      async check(ids: string[]) {
        return ids.map(externalId => ({externalId, type: items[externalId].type, problem: null}));
      },
      async lookup(ids: string[]) {
        return ids.map(externalId => ({externalId, type: items[externalId].type, title: externalId, features: items[externalId].features}));
      },
    } satisfies ExampleSource,
  });
  const {createProject} = await import('./projects.ts');
  const {takeExamples} = await import('./dataset.ts');
  const {removeExamples, restoreExamples, pruneDataset} = await import('./governance.ts');
  const p = await createProject(w.ws, 'LiveAdjust');
  const src = await sourceOf(w, 'Src', ['v1', 'v2', 'v3', 'p1', 'z1']);
  await takeExamples(w.ws, p.id, [{sourceId: src, count: 5}]);
  await w.jobs.idle();

  const initial = (await loadProjectState(w.ws, p.id))!;
  assert.equal(initial.snapshot?.featureMissingness?.byType.video?.examples, 3);
  assert.equal(initial.snapshot?.featureMissingness?.byType.video?.missing.ASR, 2);
  assert.equal(initial.snapshot?.featureMissingness?.byType.photo_text?.examples, 1);
  assert.deepEqual(initial.snapshot?.featureMissingness?.zeroFeatureExcluded, {video: 1});

  // Remove v2 (missing ASR) and p1 (only photo_text example): byType updates, photo_text drops, zeroFeatureExcluded preserved.
  const v2 = initial.examples.find(e => e.externalId === 'v2')!;
  const p1 = initial.examples.find(e => e.externalId === 'p1')!;
  await removeExamples(w.ws, p.id, [v2.id, p1.id], 'broken');
  const afterRemove = (await loadProjectState(w.ws, p.id))!;
  assert.equal(afterRemove.snapshot?.featureMissingness?.byType.video?.examples, 2);
  assert.equal(afterRemove.snapshot?.featureMissingness?.byType.video?.missing.ASR, 1);
  assert.equal(afterRemove.snapshot?.featureMissingness?.byType.photo_text, undefined);
  assert.deepEqual(afterRemove.snapshot?.featureMissingness?.zeroFeatureExcluded, {video: 1});

  // Restore both: exact counts return.
  await restoreExamples(w.ws, p.id, afterRemove.removals.map(r => r.id));
  const afterRestore = (await loadProjectState(w.ws, p.id))!;
  assert.equal(afterRestore.snapshot?.featureMissingness?.byType.video?.examples, 3);
  assert.equal(afterRestore.snapshot?.featureMissingness?.byType.video?.missing.ASR, 2);
  assert.equal(afterRestore.snapshot?.featureMissingness?.byType.photo_text?.examples, 1);
  assert.deepEqual(afterRestore.snapshot?.featureMissingness?.zeroFeatureExcluded, {video: 1});

  // pruneDataset adjusts via removeExamples.
  const pruned = await pruneDataset(w.ws, p.id, 'unlabeled', 2);
  assert.equal(pruned, 2);
  const afterPrune = (await loadProjectState(w.ws, p.id))!;
  const liveTotal = (afterPrune.snapshot?.featureMissingness?.byType.video?.examples ?? 0) + (afterPrune.snapshot?.featureMissingness?.byType.photo_text?.examples ?? 0);
  assert.equal(liveTotal, 2);

  // Best-effort: if reading features fails during removal, removal still succeeds.
  const orig = w.catalog.exampleFeatures;
  w.catalog.exampleFeatures = async () => {
    throw new Error('store unavailable');
  };
  try {
    const victim = afterPrune.examples[0];
    assert.equal(await removeExamples(w.ws, p.id, [victim.id], 'broken'), 1);
    assert.equal((await loadProjectState(w.ws, p.id))!.examples.length, 1);
  } finally {
    w.catalog.exampleFeatures = orig;
  }
});

test('feature missingness (#48): buildReport stamps snapshotId and helpers expose aggregates only without locking holdout', async () => {
  const w = await world('fm4', {gold: goldOf});
  await w.newVersion();
  await tick(w.ws, await w.state());
  await until(async () => (await w.state()).reports.length === 1, 'v1 scored');
  const scored = await w.state();
  assert.equal(scored.reports[0].snapshotId, scored.snapshot!.id, 'EvalReport.snapshotId stamped from scored examples');

  // Create a fresh project via takeExamples so featureMissingness is populated and holdout is unlocked.
  const {createProject} = await import('./projects.ts');
  const {takeExamples} = await import('./dataset.ts');
  const {getPageView} = await import('./page-views.ts');
  Object.assign(w.inst, {
    examples: {
      async check(ids: string[]) {
        return ids.map(externalId => ({externalId, type: 'video' as const, problem: null}));
      },
      async lookup(ids: string[]) {
        return ids.map(externalId => ({externalId, type: 'video' as const, title: `t ${externalId}`, features: externalId === 'ex_zero_secret' ? ({} as Record<string, {text: string}>) : {Description: {text: `desc ${externalId}`}}}));
      },
    } satisfies ExampleSource,
  });
  const p = await createProject(w.ws, 'HelperAgg');
  const src = await sourceOf(w, 'S', ['ex_alpha_1', 'ex_beta_2', 'ex_zero_secret']);
  await takeExamples(w.ws, p.id, [{sourceId: src, count: 3}]);
  await w.jobs.idle();

  const host = agentToolHost(w.inst);
  const stats = (await host.call({agent: 'front_desk', name: 'get_dataset_stats', args: {}, projectId: p.id, turnId: null, ctx: w.ws.ctx})) as {
    featureMissingness: {
      totalExamples: number;
      zeroFeatureExcluded: Record<string, number>;
      byType: {video?: {examples: number; missingFeatures: {key: string; missing: number; total: number; rate: number}[]}};
    };
  };
  assert.equal(stats.featureMissingness.totalExamples, 2);
  assert.deepEqual(stats.featureMissingness.zeroFeatureExcluded, {video: 1});
  assert.equal(stats.featureMissingness.byType.video?.examples, 2);
  const asr = stats.featureMissingness.byType.video?.missingFeatures.find(f => f.key === 'ASR');
  assert.deepEqual(asr, {key: 'ASR', missing: 2, total: 2, rate: 1});
  assert.equal(stats.featureMissingness.byType.video?.missingFeatures.find(f => f.key === 'Description'), undefined, 'features with missing === 0 are omitted');
  const serialized = JSON.stringify(stats);
  for (const ex of (await loadProjectState(w.ws, p.id))!.examples) {
    assert.ok(!serialized.includes(ex.id), 'get_dataset_stats contains no example id');
    assert.ok(!serialized.includes(ex.externalId), 'get_dataset_stats contains no external id');
  }
  assert.ok(!serialized.includes('ex_zero_secret'), 'get_dataset_stats contains no excluded item id');
  assert.ok(!(await loadProjectState(w.ws, p.id))!.project.holdoutLocked, 'get_dataset_stats does not lock holdout');

  for (const page of ['dataset', 'prompt_design', 'prompt_edit'] as const) {
    const view = await getPageView(w.ws, p.id, {page, params: {}});
    const fm = view.data.featureMissingness as typeof stats.featureMissingness | null;
    assert.ok(fm, `${page} page view includes featureMissingness`);
    assert.equal(fm.totalExamples, 2);
    assert.ok(!JSON.stringify(fm).includes('ex_alpha_1'), `${page} featureMissingness contains no example ids`);
  }

  const upload = (await host.call({agent: 'front_desk', name: 'get_upload_result', args: {}, projectId: p.id, turnId: null, ctx: w.ws.ctx})) as {note: string};
  assert.match(upload.note, /noFeatures/);
});

test('Optimiser (#63): every host call and the helper run as the person who started the run, not a fixed Optimiser identity', async () => {
  const agents = ruleAgent();
  const asked: RequestContext[] = [];
  const reflect = agents.reflectPrompt;
  agents.reflectPrompt = async input => {
    asked.push(input.ctx);
    return reflect(input);
  };
  const w = await world('t63a', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const seen: string[] = [];
  const realHost = optimiserHost(w.inst);
  const watched = Object.fromEntries(Object.entries(realHost).map(([k, fn]) => [k, (ctx: RequestContext, ...a: unknown[]) => (seen.push(`${k}:${ctx.user.id}`), (fn as (...x: unknown[]) => unknown)(ctx, ...a))])) as unknown as typeof realHost;
  const labeling = (w.inst as unknown as {labeling: Parameters<typeof createOptimiser>[0]['labeling']}).labeling;
  const opt = createOptimiser({catalog: w.catalog, labeling, agents, host: watched, onChange: w.inst.emitChange, random: () => optimiserRandom()});
  const run = await opt.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 1});
  // Each call ends when the run waits for a labeling job; the job's follow-up goes on as the same caller.
  for (let i = 0; i < 20; i++) {
    const r = await opt.execute({...w.ws.ctx, requestId: 'rq_job'}, run.id);
    if (r && r.state !== 'running') break;
    await w.jobs.idle();
  }
  assert.ok(seen.length > 3);
  assert.ok(seen.every(s => s.endsWith(':u_1')), `every host call carries the run's caller: ${seen.filter(s => !s.endsWith(':u_1')).join(', ')}`);
  assert.ok(asked.length >= 1 && asked.every(c => c.user.id === 'u_1'), 'the helper is asked as the run caller');
});

test('projects saved before tenants (#63) are given the default tenant at the first read', async () => {
  const w = await world('t63b');
  const {tenantId: _t, ...old} = (await w.catalog.get('projects', w.projectId))!;
  await w.catalog.insert('projects', {...old, id: 'pr_t63b_old'} as never);
  const {listProjects, getProject} = await import('./projects.ts');
  const fresh = createInstance({...(w.inst as unknown as Parameters<typeof createInstance>[0])});
  const ws = fresh.scope(w.ws.ctx);
  assert.equal((await getProject(ws, 'pr_t63b_old'))?.tenantId, 'default');
  assert.ok((await listProjects(ws)).every(p => p.tenantId === 'default'));
  assert.equal((await w.catalog.get('projects', 'pr_t63b_old'))?.tenantId, 'default', 'written back, not only filled on read');
});

test('Optimiser with permission checks on (#63): a run started by a writer runs to the end, every step checked as that writer', async () => {
  const w = await world('t63c', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  const asked: string[] = [];
  Object.assign(w.inst, {
    authorization: {
      async allowed(ctx: RequestContext, r: {action: string; permission: string}) {
        asked.push(`${ctx.user.id}:${r.action}:${r.permission}`);
        return ctx.user.id === 'u_1';
      },
    },
  });
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  const run = (await w.state()).optimisation[0];
  assert.equal(run.state, 'done', run.error ?? '');
  assert.ok(asked.includes('u_1:optimiser.label:project_write') && asked.includes('u_1:optimiser.createVersion:project_write'));
  assert.ok(asked.every(a => a.startsWith('u_1:')));
  // A job runs later, so it is checked again as the person who queued it.
  await scoreVersion(w.ws, w.projectId, (await w.state()).versions.at(-1)!);
  await w.jobs.idle();
  assert.ok(asked.includes('u_1:job.report.build:project_write'));
  const bob = w.inst.scope({requestId: 'rq_bob', user: {id: 'u_2', name: 'Bob'}, caller: 'test'});
  const v = await w.newVersion();
  await scoreVersion(bob, w.projectId, v);
  await w.jobs.idle();
  assert.equal((await w.state()).reports.some(r => r.promptVersionId === v.id), false, "a job queued by someone without project write does not build the report");
});

test('Optimiser (#63): a run whose caller lost project write stops at its first step, before any paid helper call', async () => {
  const agents = ruleAgent();
  let reflections = 0;
  const reflect = agents.reflectPrompt;
  agents.reflectPrompt = async input => (reflections++, reflect(input));
  const w = await world('t63d', {agents, answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  // Allowed to start it, then project write is taken away before the job runs.
  let canWrite = true;
  Object.assign(w.inst, {authorization: {allowed: async (_ctx: RequestContext, r: {permission: string}) => r.permission === 'read' || canWrite}});
  const {runId} = await startOptimiser(w.ws, w.projectId, 3);
  canWrite = false;
  await w.jobs.idle();
  const run = (await w.state()).optimisation.find(o => o.id === runId)!;
  assert.equal(reflections, 0, 'no helper was asked');
  assert.notEqual(run.state, 'done');
  assert.equal(run.history.length, 0, 'no round was recorded');
});

test('a data source import whose caller lost tenant write (#63) fails at once, without retries, and its file shows failed', async () => {
  const w = await world('t63e');
  Object.assign(w.inst, {authorization: {allowed: async (_ctx: RequestContext, r: {permission: string}) => r.permission !== 'tenant_write'}});
  const {createDataSource} = await import('./sources.ts');
  const res = await createDataSource(w.ws, {name: 'Feed', fileName: 'feed.txt', text: 'a1\na2\n'});
  await w.jobs.idle();
  const jobs = await w.jobs.api.list(w.ws.ctx, {kinds: ['source.ingest']});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'failed');
  assert.equal(jobs[0].attempts, 1, 'not tried again');
  assert.equal((await w.catalog.get('source_files', res.file!.id))?.state, 'failed');
});

/** Notifications as the stand-in keeps them, and the notification metric's counts by kind and outcome. */
function notifications() {
  const port = logNotifications(100, () => {});
  const counts: string[] = [];
  const telemetry = {counter: (name: string, labels: Record<string, string>) => name === 'sprint_notifications_total' && counts.push(`${labels.notification}:${labels.outcome}`), event() {}, histogram() {}, gauge() {}, allowLabelValues() {}} as unknown as TelemetryPort;
  return {port, counts, telemetry};
}

test('notifications (#71): scoring that finishes tells the person who started it, once, with a link to Prompt Tuning', async () => {
  const n = notifications();
  const w = await world('nt1', {notifications: n.port, telemetry: n.telemetry});
  const v = await w.newVersion();
  await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  assert.equal((await w.state()).runs[0].state, 'done');
  const sent = n.port.sent();
  assert.equal(sent.length, 1);
  assert.deepEqual({...sent[0], msg: sent[0].msg?.key}, {
    userIds: ['u_1'],
    kind: 'scoring_finished',
    projectId: w.projectId,
    text: `Scoring ${versionLabel(v)} on Model A finished in p.`,
    link: `/prompt/?p=${w.projectId}`,
    title: 'Scoring finished',
    msg: 'Scoring {version} on {model} finished in {project}.',
  });
  assert.deepEqual(n.counts, ['scoring_finished:ok']);
  const notifyJobs = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['notify.send']});
  assert.deepEqual(notifyJobs.map(j => [j.state, j.concurrencyKey]), [['done', 'compute:default']]);
});

test('notifications (#71): scoring that fails says so; Retry that fails again says so again', async () => {
  const n = notifications();
  const w = await world('nt2', {notifications: n.port, answer: () => {
    throw new Error('the model is down');
  }});
  const v = await w.newVersion();
  const {runIds} = await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  assert.ok(['failed', 'needs_attention'].includes((await w.labeling.getTask(runIds[0]))!.state));
  assert.deepEqual(n.port.sent().map(x => [x.kind, x.title]), [['scoring_failed', 'Scoring failed']]);
  await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  assert.deepEqual(n.port.sent().map(x => x.kind), ['scoring_failed', 'scoring_failed'], 'a new run of the task is a new notification');
});

test("notifications (#71): a Stop sends nothing; work Sprint started on its own goes to the project's creator", async () => {
  const n = notifications();
  const w = await world('nt3', {notifications: n.port, delayMs: 20});
  const v = await w.newVersion();
  const {runIds} = await scoreVersion(w.ws, w.projectId, v);
  await until(async () => (await w.state()).runs[0]?.state === 'running', 'scoring starts');
  const {stopRun} = await import('./evaluation.ts');
  await stopRun(w.ws, w.projectId, runIds[0]);
  await w.jobs.idle();
  assert.equal((await w.labeling.getTask(runIds[0]))!.state, 'stopped');
  assert.deepEqual(n.port.sent(), [], 'the person who pressed Stop knows');
  // A page's check and the sweep queue work as Sprint itself: the creator hears, or nobody when
  // the project has none on record (made before creators were kept).
  const {systemScope} = await import('./access.ts');
  await scoreVersion(systemScope(w.inst, 'default'), w.projectId, await w.newVersion('another'));
  await w.jobs.idle();
  assert.equal((await w.state()).runs.filter(r => r.state === 'done').length, 1);
  assert.deepEqual(n.port.sent(), []);
  await w.catalog.patch('projects', w.projectId, {createdById: 'u_owner'});
  await scoreVersion(systemScope(w.inst, 'default'), w.projectId, await w.newVersion('a third'));
  await w.jobs.idle();
  assert.deepEqual(n.port.sent().map(x => [x.kind, x.userIds]), [['scoring_finished', ['u_owner']]]);
});

test('notifications (#71): a send that fails is counted and fails nothing', async () => {
  const n = notifications();
  const w = await world('nt4', {notifications: {send: async () => {
    throw new Error('the message tool is down');
  }}, telemetry: n.telemetry});
  const warn = console.warn;
  console.warn = () => {};
  try {
    await scoreVersion(w.ws, w.projectId, await w.newVersion());
    await w.jobs.idle();
  } finally {
    console.warn = warn;
  }
  const s = await w.state();
  assert.equal(s.runs[0].state, 'done');
  assert.equal(s.reports.length, 1, 'the report is built all the same');
  assert.deepEqual(n.counts, ['scoring_finished:error']);
  assert.deepEqual((await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['notify.send']})).map(j => j.state), ['done']);
});

test('notifications (#71): an Optimiser run that ends tells the person who started it', async () => {
  const n = notifications();
  const w = await world('nt5', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf, notifications: n.port});
  await w.newVersion();
  const {startOptimiser} = await import('./work.ts');
  await startOptimiser(w.ws, w.projectId, 10);
  await w.jobs.idle();
  assert.equal((await w.state()).optimisation[0].state, 'done');
  const ended = n.port.sent().filter(x => x.kind.startsWith('optimiser'));
  assert.deepEqual(ended.map(x => [x.kind, x.userIds, x.text, x.link]), [['optimiser_finished', ['u_1'], 'Auto Optimise finished in p.', `/prompt/?p=${w.projectId}`]]);
});

test('notifications (#71): Stop on a Retry still waiting for its model sends nothing, though the task still shows its earlier failure', async () => {
  const n = notifications();
  const w = await world('nt6', {notifications: n.port, delayMs: 40, answer: () => {
    throw new Error('the model is down');
  }});
  const v1 = await w.newVersion();
  const {runIds} = await scoreVersion(w.ws, w.projectId, v1);
  await w.jobs.idle();
  assert.equal(n.port.sent().length, 1);
  // Another version holds the model; the Retry of the first waits behind it, and is stopped there.
  const v2 = await w.newVersion('another');
  await scoreVersion(w.ws, w.projectId, v2);
  await scoreVersion(w.ws, w.projectId, v1);
  const retry = (await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['labeling.runTask'], states: ['queued']})).find(j => j.args.taskId === runIds[0]);
  assert.ok(retry, 'the Retry waits');
  const {stopRun} = await import('./evaluation.ts');
  await stopRun(w.ws, w.projectId, runIds[0]);
  await w.jobs.idle();
  const sent = n.port.sent().map(x => `${x.kind} ${(x.msg?.params as {version: string}).version}`);
  assert.deepEqual(sent, [`scoring_failed ${versionLabel(v1)}`, `scoring_failed ${versionLabel(v2)}`], 'the stopped Retry adds nothing');
});

test("notifications (#71): work Sprint started goes to the creator only while they can still read the project", async () => {
  const n = notifications();
  const readers = new Set(['u_1', 'u_owner']);
  const w = await world('nt7', {notifications: n.port, authorization: {allowed: async ctx => readers.has(ctx.user.id)}});
  await w.catalog.patch('projects', w.projectId, {createdById: 'u_owner'});
  const {systemScope} = await import('./access.ts');
  await scoreVersion(systemScope(w.inst, 'default'), w.projectId, await w.newVersion());
  await w.jobs.idle();
  assert.deepEqual(n.port.sent().map(x => x.userIds), [['u_owner']]);
  readers.delete('u_owner');
  await scoreVersion(systemScope(w.inst, 'default'), w.projectId, await w.newVersion('another'));
  await w.jobs.idle();
  assert.equal((await w.state()).runs.filter(r => r.state === 'done').length, 2);
  assert.equal(n.port.sent().length, 1, 'a creator who left is not told');
});

test('notifications (#71): a late notice of a failed try says nothing once a Retry finished; a caller who lost read access is not told', async () => {
  const n = notifications();
  const readers = new Set(['u_1']);
  let failing = true;
  const w = await world('nt8', {notifications: n.port, authorization: {allowed: async ctx => readers.has(ctx.user.id)}, answer: () => {
    if (failing) throw new Error('the model is down');
    return '{"format": "Vlog"}';
  }});
  const v = await w.newVersion();
  const {runIds} = await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  const [failedNotice] = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['notify.send']});
  failing = false;
  await scoreVersion(w.ws, w.projectId, v);
  await w.jobs.idle();
  assert.equal((await w.labeling.getTask(runIds[0]))!.state, 'done');
  assert.deepEqual(n.port.sent().map(x => x.kind), ['scoring_failed', 'scoring_finished']);
  // The failed try's notice, run again late (as a full compute queue would), says nothing now.
  const {runNotify} = await import('./notify.ts');
  await runNotify(w.ws, failedNotice);
  assert.equal(n.port.sent().length, 2);
  // A caller who lost read access while scoring ran hears nothing, and the notice ends done.
  readers.delete('u_1');
  const other = await w.newVersion('another');
  readers.add('u_1');
  await scoreVersion(w.ws, w.projectId, other);
  readers.delete('u_1');
  await w.jobs.idle();
  assert.equal(n.port.sent().length, 2);
  const notices = await w.jobs.api.list(w.ws.ctx, {projectId: w.projectId, kinds: ['notify.send']});
  assert.ok(notices.length === 3 && notices.every(j => j.state === 'done'));
});

test('sample numbers: an older dataset is numbered once in saved order; added samples follow; removing shifts nothing', async () => {
  const w = await world('num1');
  const {listSamples} = await import('./samples.ts');
  const {appendExamples, removeExamples, restoreExamples} = await import('./governance.ts');
  // An older dataset with a removal already standing: numbering keeps it removed.
  await w.catalog.patch('examples', 'ex_num1_5', {removed: true});
  await w.catalog.insert('dataset_removals', {id: 'rm_old', projectId: w.projectId, exampleId: 'ex_num1_5', externalId: '5', half: 'held_out', gold: ['Vlog'], reason: 'broken', removedBy: 'Tester', removedAt: '2026-11-01T00:00:00Z', restoredAt: null});
  const s0 = await w.state();
  assert.equal((await w.catalog.get('examples', 'ex_num1_5'))?.removed, true, 'a removed sample stays removed');
  await restoreExamples(w.ws, w.projectId, ['rm_old']);
  const numberOf = async () => Object.fromEntries((await w.catalog.find('examples', {snapshotId: s0.snapshot!.id})).map(e => [e.externalId, e.number]));
  assert.deepEqual(await numberOf(), Object.fromEntries(Array.from({length: EVAL}, (_, i) => [String(i), i + 1])), 'numbered in the order saved');
  assert.equal((await w.catalog.get('dataset_snapshots', s0.snapshot!.id))?.numbered, true);
  await w.state();
  assert.equal((await numberOf())['9'], 10, 'a second read changes nothing');

  const r = await appendExamples(w.ws, w.projectId, [{externalId: 'new-a', type: 'video', title: '', features: {}}, {externalId: 'new-b', type: 'video', title: '', features: {}}], 'upload');
  assert.equal(r.added, 2);
  assert.deepEqual([(await numberOf())['new-a'], (await numberOf())['new-b']], [11, 12]);

  const third = s0.examples.find(e => e.externalId === '2')!;
  await removeExamples(w.ws, w.projectId, [third.id], 'broken');
  const live = await listSamples(w.ws, {projectId: w.projectId});
  assert.equal(live.total, 11);
  assert.deepEqual(live.items.slice(0, 3).map(x => x.number), [1, 2, 4], 'no number shifts');
  assert.equal(live.items[0].labeled, true);
  assert.equal(live.items.at(-1)?.labeled, false, 'added samples have no gold label yet');
  const removed = await listSamples(w.ws, {projectId: w.projectId, filter: 'removed'});
  assert.deepEqual(removed.items.map(x => [x.number, x.externalId, x.removal?.reason]), [[3, '2', 'broken']]);
  await restoreExamples(w.ws, w.projectId, [removed.items[0].removal!.id]);
  assert.equal((await listSamples(w.ws, {projectId: w.projectId, filter: 'removed'})).total, 0);
  assert.equal((await numberOf())['2'], 3, 'restored with its own number');

  // Pages and lookups by number or sample ID.
  const page2 = await listSamples(w.ws, {projectId: w.projectId, offset: 5, limit: 5});
  assert.deepEqual([page2.total, page2.items.map(x => x.number)], [12, [6, 7, 8, 9, 10]]);
  assert.deepEqual((await listSamples(w.ws, {projectId: w.projectId, query: '#11'})).items.map(x => x.externalId), ['new-a']);
  assert.deepEqual((await listSamples(w.ws, {projectId: w.projectId, query: 'new-b'})).items.map(x => x.number), [12]);
  assert.deepEqual((await listSamples(w.ws, {projectId: w.projectId, query: '4'})).items.map(x => x.externalId), ['3', '4'], 'number 4, and the sample whose ID is 4');
});

test('a run labeling examples a done task already has uses it, even when a newer task over them did not finish (#79)', async () => {
  const w = await world('b79f', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  const v = await w.newVersion();
  const s0 = await w.state();
  const ids = s0.examples.map(e => e.id).slice(0, 3);
  const make = () => w.labeling.createTask({projectId: w.projectId, tenantId: 'default', purpose: 'eval', promptVersionId: v.id, setupVersionId: s0.setup!.id, endpoint: 'A', settings: s0.setup!.models[0], exampleIds: ids, createdBy: 'Tester'});
  const repo = new DocRepo(w.db);
  const done = await make();
  await repo.patch('labeling_tasks', done.id, {state: 'done', done: ids.length});
  const newer = await make();
  await repo.patch('labeling_tasks', newer.id, {state: 'failed', error: 'the model went away'});
  const {queueOptimiserLabeling} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  const version = (await w.state()).versions.find(x => x.id === v.id)!;
  const got = await queueOptimiserLabeling(w.ws, s0.setup!, version, {projectId: w.projectId, promptVersionId: v.id, endpoint: 'A', exampleIds: ids, runId, at: {round: 1, step: 'dry_run'}, start: false});
  assert.equal(got.state, 'done');
  assert.equal(got.state === 'done' && got.task.id, done.id);
});

test('Stop on a Failed run while another run of the same model holds the lock stops it; nothing is left asked (#79)', async () => {
  const w = await world('b79g', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {stopOptimiser, retryOptimiser} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  await w.catalog.patch('optimisation_runs', runId, {state: 'failed', error: 'the model went away'});
  await w.ws.locks.run(`optimiser:${w.projectId}:A`, async () => {
    await stopOptimiser(w.ws, w.projectId, runId);
  });
  const run = (await w.state()).optimisation.find(o => o.id === runId)!;
  assert.deepEqual([run.state, run.stopReason], ['stopped', 'user']);
  await assert.rejects(retryOptimiser(w.ws, w.projectId, runId), /has ended/);
});

test('Retry on a Failed run clears a Stop request left on it, so the retried run goes on (#79)', async () => {
  const w = await world('b79h', {agents: ruleAgent(), answer: ruled, macroF1: 0.99, gold: goldOf});
  await w.newVersion();
  const {retryOptimiser} = await import('./work.ts');
  const {id: runId} = await w.ws.optimiser!.startRun(w.ws.ctx, {projectId: w.projectId, endpoint: 'A', maxRounds: 10});
  await w.catalog.patch('optimisation_runs', runId, {state: 'failed', error: 'the model went away', stopRequested: true});
  await retryOptimiser(w.ws, w.projectId, runId);
  await w.jobs.idle();
  const run = (await w.state()).optimisation.find(o => o.id === runId)!;
  assert.deepEqual([run.state, run.stopReason], ['done', 'passes']);
});

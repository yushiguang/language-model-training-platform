import assert from 'node:assert/strict';
import test from 'node:test';
import {AccessDeniedError} from '@yushiguang/sprint-contracts';
import type {AuthorizationPort, AuthorizationRequest} from '@yushiguang/sprint-contracts';
import type {AgentRuntimeContract, AgentToolRequest, AgentTurnRequest, CallerUser, DocumentSource, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, PageContext, RequestContext, TicketSubmission, WorkflowContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, memoryLocks} from '@yushiguang/sprint-labeling';
import {createJobs} from '@yushiguang/sprint-jobs';
import {localDocRuntime, loopback, memoryJobStore, memoryPermissionAdmin, memorySharedState} from '@yushiguang/sprint-platform';
import {createWorkflow} from './workflow.ts';
import type {WorkflowDeps} from './services/app.ts';

/**
 * The workflow as a channel sees it (deployment readiness spec, 2): `createWorkflow` and its
 * contract, called through the loopback, as the bff calls it. Two users act in one process and
 * never see each other's identity, problem-report drafts or live turn.
 */

const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const alice: CallerUser = {id: 'u_alice', name: 'Alice'};
const bob: CallerUser = {id: 'u_bob', name: 'Bob'};
let n = 0;
const ctxOf = (user: CallerUser): RequestContext => ({requestId: `rq_${++n}`, user, caller: 'test', locale: 'en'});
const page = (agent: PageContext['agent'] = 'front_desk'): PageContext => ({label: 'Projects', agent, intent: 'answer', context: {}, where: {page: 'projects', params: {}}});

/** A workflow over the real catalog and labeling, with a fake model and the given helpers. */
function world(prefix: string, agents: (wf: ReturnType<typeof createWorkflow>) => AgentRuntimeContract, documents?: DocumentSource, access: Pick<WorkflowDeps, 'authorization' | 'permissionAdmin'> = {}) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    agentModel: () => ({}),
    cancel: async () => {},
    label: async (): Promise<LabelCallResult> => ({text: '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: 0.03, endpointId: 'labeling-A', attempts: 1}),
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const tickets: TicketSubmission[] = [];
  // No executors: queued work stays queued.
  const jobs = createJobs({store: memoryJobStore()}).api;
  const wf = createWorkflow({
    catalog,
    labeling,
    gateway,
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
    sharedState: memorySharedState(),
    jobs,
    ...(documents ? {documents} : {}),
    tickets: {submit: async t => (tickets.push(t), {ticketId: `T-${tickets.length}`})},
    grantRetryMs: 0,
    ...access,
  });
  wf.connect({agents: agents(wf)});
  return {wf, api: loopback(wf.api) as WorkflowContract, catalog, tickets, jobs, labeling};
}

/** The tools as the runtime binds them for one turn: every call carries the turn's project, id and context. */
const toolsOf = (wf: ReturnType<typeof createWorkflow>, input: AgentTurnRequest) => ({
  call: (r: AgentToolRequest) => wf.toolHost.call({...r, projectId: input.workspace.projectId, turnId: input.turnId, ctx: input.ctx}),
});

const noHelpers = (): AgentRuntimeContract => ({
  runTurn: async () => ({invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []}),
  reflectPrompt: async () => {
    throw new Error('not used');
  },
  cancel: async () => {},
});

test('two users in one process: each call acts as its own caller, even when the calls interleave', async () => {
  const {api, catalog} = world('wf-two-users', noHelpers);
  const [a, b] = await Promise.all([api.createProject(ctxOf(alice), 'From Alice'), api.createProject(ctxOf(bob), 'From Bob')]);
  assert.deepEqual([a.createdBy, a.createdById, b.createdBy, b.createdById], ['Alice', 'u_alice', 'Bob', 'u_bob']);
  await Promise.all([api.renameProject(ctxOf(bob), {projectId: a.id, name: 'Renamed by Bob'}), api.renameProject(ctxOf(alice), {projectId: b.id, name: 'Renamed by Alice'})]);
  const who = async (projectId: string, action: string) => (await catalog.find('audit_log', {projectId, action})).map(r => r.actor);
  assert.deepEqual(await who(a.id, 'project.create'), ['Alice']);
  assert.deepEqual(await who(a.id, 'project.rename'), ['Bob']);
  assert.deepEqual(await who(b.id, 'project.rename'), ['Alice']);
});

test("two users in one process: a problem-report draft and a live turn belong to their own project, and a ticket names the user whose turn sent it", async () => {
  // Each turn's helper drafts a report on its first message and sends it on the next. Bob's
  // first turn waits until Alice's first turn has started, so the two run at once.
  let release!: () => void;
  const aliceStarted = new Promise<void>(r => (release = r));
  const seen: Record<string, unknown> = {};
  const {wf, api, tickets} = world('wf-two-turns', w => ({
    ...noHelpers(),
    async runTurn(input: AgentTurnRequest) {
      const tools = toolsOf(w, input);
      const text = input.userText;
      if (text === 'alice: it broke') {
        seen.draftA = await tools.call({agent: 'front_desk', name: 'report_problem', args: {summary: 'Save does nothing'}});
        release();
        // Bob's turn runs while this one is still live.
        await new Promise(r => setTimeout(r, 30));
      }
      if (text === 'bob: it broke') {
        await aliceStarted;
        seen.bobSendsAlicesDraft = await tools.call({agent: 'front_desk', name: 'report_problem', args: {send: true}});
      }
      if (text.endsWith(': yes, send it')) seen[text] = await tools.call({agent: 'front_desk', name: 'report_problem', args: {send: true}});
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
  }));
  const a = await api.createProject(ctxOf(alice), 'Alice project');
  const b = await api.createProject(ctxOf(bob), 'Bob project');
  const turnA = api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'alice: it broke', page: page()});
  await aliceStarted;
  assert.notEqual(await api.getAgentLive(ctxOf(alice), a.id), null, "Alice's turn is live on her project");
  assert.equal(await api.getAgentLive(ctxOf(bob), b.id), null, "and not on Bob's");
  await api.sendUserMessage(ctxOf(bob), {projectId: b.id, text: 'bob: it broke', page: page()});
  await turnA;
  // The calls return once each turn started; the turns run on.
  await wf.turnsIdle();
  assert.match(String((seen.bobSendsAlicesDraft as {error: string}).error), /no draft/, "Bob's project has no draft: Alice's draft is not his");
  assert.ok((seen.draftA as {draft: unknown}).draft);
  assert.equal(await api.getAgentLive(ctxOf(alice), a.id), null, 'nothing is live once the turn ended');

  // Alice agrees in a new message; Bob's turn on his project runs in between.
  await Promise.all([api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'alice: yes, send it', page: page()}), api.sendUserMessage(ctxOf(bob), {projectId: b.id, text: 'bob: yes, send it', page: page()})]);
  await wf.turnsIdle();
  assert.deepEqual(seen['alice: yes, send it'], {ticketId: 'T-1', note: 'Tell the user the ticket id in one line; the team picks the report up from there.'});
  assert.match(String((seen['bob: yes, send it'] as {error: string}).error), /no draft/);
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].reporter, {id: 'u_alice', name: 'Alice'});
  assert.equal(tickets[0].where.projectId, a.id);
  // The chat of each project holds only its own messages.
  const textsOf = async (ctx: RequestContext, projectId: string) => (await api.chatHistory(ctx, projectId)).filter(m => m.role === 'user').map(m => m.text);
  assert.deepEqual(await textsOf(ctxOf(alice), a.id), ['alice: it broke', 'alice: yes, send it']);
  assert.deepEqual(await textsOf(ctxOf(bob), b.id), ['bob: it broke', 'bob: yes, send it']);
  // With no turn, a helper's tool runs as the context the call carried.
  await wf.toolHost.call({agent: 'prompt_agent', name: 'list_versions', args: {}, projectId: a.id, turnId: null, ctx: ctxOf(alice)});
});

test("two users in one process: a helper reads a linked document as the person it answers (gap G3)", async () => {
  const readers: string[] = [];
  const {wf, api} = world(
    'wf-docs',
    w => ({
      ...noHelpers(),
      async runTurn(input: AgentTurnRequest) {
        await toolsOf(w, input).call({agent: 'front_desk', name: 'read_doc', args: {url: 'https://docs.example/guide'}});
        return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
      },
    }),
    {read: async (ctx, url) => (readers.push(`${ctx.user.name}:${url}`), {title: 'Guide', text: 'Label carefully.'})},
  );
  const a = await api.createProject(ctxOf(alice), 'A');
  const b = await api.createProject(ctxOf(bob), 'B');
  await Promise.all([api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'read this', page: page()}), api.sendUserMessage(ctxOf(bob), {projectId: b.id, text: 'read this', page: page()})]);
  await wf.turnsIdle();
  assert.deepEqual(readers.sort(), ['Alice:https://docs.example/guide', 'Bob:https://docs.example/guide']);
});

test('two workflows in one process share nothing: each is its own instance', async () => {
  const one = world('wf-inst-1', noHelpers);
  const two = world('wf-inst-2', noHelpers);
  let heardOne = 0;
  let heardTwo = 0;
  one.wf.events.subscribe('changes', () => heardOne++);
  two.wf.events.subscribe('changes', () => heardTwo++);
  await one.api.createProject(ctxOf(alice), 'Only in one');
  assert.ok(heardOne > 0);
  assert.equal(heardTwo, 0, "the other instance's listeners hear nothing");
  assert.equal((await two.api.listProjects(ctxOf(alice))).length, 0);
});

test('loopback: arguments, results and errors cross as JSON, as they would over RPC', async () => {
  const impl = {
    async echo(ctx: RequestContext, x: {when?: string; keep: number}, extra?: string) {
      return {ctx: ctx.user.name, x, extra: extra ?? 'none', n: arguments.length};
    },
    async fails() {
      throw Object.assign(new Error('This version does not exist.'), {code: 'not_found'});
    },
    async nothing() {},
    async denied() {
      throw new AccessDeniedError('project_write');
    },
  };
  const api = loopback(impl);
  const arg = {when: undefined, keep: 1};
  const out = await api.echo(ctxOf(alice), arg, undefined);
  assert.deepEqual(out, {ctx: 'Alice', x: {keep: 1}, extra: 'none', n: 2}, 'undefined fields and trailing arguments are dropped');
  out.x.keep = 2;
  assert.equal(arg.keep, 1, 'the caller gets a copy');
  await assert.rejects(api.fails(), (e: Error & {code?: string}) => e.message === 'This version does not exist.' && e.code === 'not_found');
  assert.equal(await api.nothing(), null);
  await assert.rejects(api.denied(), (e: Error) => e instanceof AccessDeniedError && e.code === 'forbidden' && e.permission === 'project_write', 'a missing permission keeps its class and point');
});

test('the tool host enforces the guards (review P4): preset tools only, the turn\'s own project, no deleted project', async () => {
  const seen: Record<string, string> = {};
  const refused = (p: Promise<unknown>) => p.then(() => 'ran', (e: Error) => e.message);
  const {wf, api} = world('wf-guards', w => ({
    ...noHelpers(),
    async runTurn(input: AgentTurnRequest) {
      const other = input.userText;
      // A tool the front desk does not have.
      seen.notMine = await refused(toolsOf(w, input).call({agent: 'front_desk', name: 'start_optimiser', args: {}}));
      // This turn's id on another project.
      seen.otherProject = await refused(w.toolHost.call({agent: 'front_desk', name: 'get_page_view', args: {}, projectId: other, turnId: input.turnId, ctx: input.ctx}));
      seen.own = await refused(toolsOf(w, input).call({agent: 'front_desk', name: 'get_page_view', args: {}}));
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
  }));
  const a = await api.createProject(ctxOf(alice), 'A');
  const b = await api.createProject(ctxOf(bob), 'B');
  await api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: b.id, page: page()});
  await wf.turnsIdle();
  assert.match(seen.notMine, /cannot use start_optimiser/);
  assert.match(seen.otherProject, /turn has ended/);
  assert.equal(seen.own, 'ran');
  // A turn that ended no longer lends its user to a tool call.
  const call = {agent: 'front_desk' as const, name: 'get_page_view' as const, args: {}, ctx: ctxOf(alice)};
  assert.match(await refused(wf.toolHost.call({...call, projectId: a.id, turnId: 'turn_gone'})), /turn has ended/);
  await api.deleteProject(ctxOf(alice), {projectId: a.id});
  assert.match(await refused(wf.toolHost.call({...call, projectId: a.id, turnId: null})), /not found/);
});

test('sending a message returns once the turn started; the turn runs on, and a failed turn says so in the chat', async () => {
  let finish!: () => void;
  const held = new Promise<void>(r => (finish = r));
  const {wf, api} = world('wf-accept', () => ({
    ...noHelpers(),
    async runTurn(input: AgentTurnRequest) {
      if (input.userText === 'fail') throw new Error('model down');
      await held;
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], skills: [], parseFailures: []};
    },
  }));
  const a = await api.createProject(ctxOf(alice), 'A');
  const out = await api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'hello', page: page()});
  assert.match(out.turnId, /^turn_/);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'plain JSON');
  assert.ok(await api.getAgentLive(ctxOf(alice), a.id), 'the turn is live after the call returned');
  assert.deepEqual((await api.chatHistory(ctxOf(alice), a.id)).map(m => m.text), ['hello'], 'the message is saved before the call returns');
  finish();
  await wf.turnsIdle();
  assert.equal(await api.getAgentLive(ctxOf(alice), a.id), null);
  await api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'fail', page: page()});
  await wf.turnsIdle();
  assert.equal(await api.getAgentLive(ctxOf(alice), a.id), null, 'a failed turn ends too');
  const last = (await api.chatHistory(ctxOf(alice), a.id)).at(-1);
  assert.deepEqual([last?.role, last?.agent, last?.msg?.key], ['agent', 'front_desk', 'Sorry, I could not answer that. Please ask again.']);
});

// ---------------------------------------------------------------------------------------------
// Permissions and tenant isolation (#63, docs/design/server.md, 2)

const eve: CallerUser = {id: 'u_eve', name: 'Eve'};
const inTenant = (user: CallerUser, tenantId: string): RequestContext => ({...ctxOf(user), tenantId});

/** The permission platform as the stand-in store sees it: read = member, project write = granted, tenant write = admin. */
function checking(admin = memoryPermissionAdmin()) {
  const asked: AuthorizationRequest[] = [];
  const authorization: AuthorizationPort = {
    async allowed(ctx, r) {
      asked.push(r);
      const t = ctx.tenantId ?? 'default';
      const role = admin.roleOf(t, ctx.user.id);
      if (r.permission === 'read') return role !== null;
      if (r.permission === 'tenant_write') return role === 'admin';
      return role !== null && admin.canWrite(t, r.projectId!, ctx.user.id);
    },
  };
  return {admin, authorization, asked};
}

test('tenant isolation (#63): another tenant cannot list, read, change or point a helper at a project', async () => {
  const {wf, api} = world('wf-tenants', noHelpers);
  const mine = await api.createProject(inTenant(alice, 't1'), 'Mine');
  await api.createProject(inTenant(eve, 't2'), 'Theirs');
  assert.equal(mine.tenantId, 't1');
  assert.deepEqual((await api.listProjects(inTenant(alice, 't1'))).map(p => p.name), ['Mine']);
  assert.deepEqual((await api.listProjects(inTenant(eve, 't2'))).map(p => p.name), ['Theirs']);
  const evil = inTenant(eve, 't2');
  assert.equal(await api.getProject(evil, mine.id), null);
  assert.equal(await api.loadProjectState(evil, mine.id), null);
  await assert.rejects(api.renameProject(evil, {projectId: mine.id, name: 'x'}), /does not exist/);
  await assert.rejects(api.deleteProject(evil, {projectId: mine.id}), /does not exist/);
  await assert.rejects(api.chatHistory(evil, mine.id), /does not exist/);
  await assert.rejects(wf.toolHost.call({agent: 'front_desk', name: 'list_versions', args: {}, projectId: mine.id, turnId: null, ctx: evil}), /not found/);
  assert.equal((await api.getProject(inTenant(alice, 't1'), mine.id))?.name, 'Mine', 'untouched');
  // Another tenant's project and a missing one answer alike, read or write: ids cannot be probed.
  const answer = (p: Promise<unknown>) => p.then(v => ({ok: v}), (e: Error) => ({error: e.message}));
  const calls: [string, (id: string) => Promise<unknown>][] = [
    ['chatHistory', id => api.chatHistory(evil, id)],
    ['getAgentLive', id => api.getAgentLive(evil, id)],
    ['openProposals', id => api.openProposals(evil, id)],
    ['mismatches', id => api.mismatches(evil, id)],
    ['exampleMedia', id => api.exampleMedia(evil, id, 'ex_1')],
    ['tick', id => api.tick(evil, {projectId: id})],
    ['sendUserMessage', id => api.sendUserMessage(evil, {projectId: id, text: 'hi', page: page()})],
    ['projectStatus', id => api.projectStatus(evil, id)],
  ];
  for (const [name, call] of calls) assert.deepEqual(await answer(call(mine.id)), await answer(call('pr_missing')), name);
});

test('permissions (#63): the creator gets project write; a member only reads; a removed member is stopped, helper reads included', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'member');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  const {wf, api} = world('wf-perms', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const p = await api.createProject(inTenant(alice, 't1'), 'Formats');
  assert.deepEqual(await perms.admin.listProjectWriters('t1', p.id), [alice.id], 'the creator holds project write');
  await api.renameProject(inTenant(alice, 't1'), {projectId: p.id, name: 'Formats 2'});
  assert.ok(await api.loadProjectState(inTenant(bob, 't1'), p.id), 'a member reads');
  await assert.rejects(api.renameProject(inTenant(bob, 't1'), {projectId: p.id, name: 'x'}), {code: 'forbidden'});
  await assert.rejects(api.createDataSource(inTenant(alice, 't1'), {name: 's', fileName: 'a.csv', text: 'id\n1\n'}), {code: 'forbidden'});
  await assert.rejects(api.listProjects(inTenant(eve, 't1')), {code: 'forbidden'}, 'not a member: no read');
  const tool = (user: CallerUser, name: AgentToolRequest['name'], agent: AgentToolRequest['agent'] = 'front_desk') => wf.toolHost.call({agent, name, args: {}, projectId: p.id, turnId: null, ctx: inTenant(user, 't1')});
  assert.ok(await tool(bob, 'list_versions'), "a member's helper reads");
  for (const start of ['try_prompt', 'score_version', 'start_optimiser'] as const) await assert.rejects(tool(bob, start, 'prompt_agent'), {code: 'forbidden'}, `a reader's helper cannot ${start}`);
  // A caller without the permission learns nothing about ids: another tenant's project and a
  // missing one are refused alike, before any record is read.
  await perms.admin.addTenantMember(sys, 't2', eve.id, 'member');
  const theirs = await api.createProject(inTenant(eve, 't2'), 'Theirs');
  for (const id of [p.id, 'pr_missing']) {
    await assert.rejects(api.renameProject(inTenant(eve, 't2'), {projectId: id, name: 'x'}), {code: 'forbidden'});
    await assert.rejects(api.getProject(inTenant(eve, 't1'), id), {code: 'forbidden'}, 'not a member of t1: no read, whatever the id');
  }
  assert.equal(await api.getProject(inTenant(eve, 't2'), p.id), null, 'a member reads another tenant\'s project as missing');
  assert.ok(await api.getProject(inTenant(eve, 't2'), theirs.id));
  await perms.admin.removeTenantMember(sys, 't1', bob.id);
  await assert.rejects(tool(bob, 'list_versions'), {code: 'forbidden'}, 'removed from the tenant: the read tool is stopped too');
  // Every check names its permission point and project, from the workflow's table.
  assert.ok(perms.asked.some(r => r.action === 'workflow.renameProject' && r.permission === 'project_write' && r.projectId === p.id));
  assert.ok(perms.asked.some(r => r.action === 'tool.list_versions' && r.permission === 'read'));
});

test("permissions (#63): Sprint's own work (the sweep, a page's check) is checked for the tenant only", async () => {
  // Only Alice is let in. Sprint's own caller is never asked about, so its work goes on.
  const asked: string[] = [];
  const authorization: AuthorizationPort = {
    async allowed(ctx, r) {
      asked.push(`${ctx.user.id}:${r.action}`);
      return ctx.user.id === alice.id;
    },
  };
  const {wf, api} = world('wf-system', noHelpers, undefined, {authorization});
  const p = await api.createProject(inTenant(alice, 't1'), 'Formats');
  await api.tick(inTenant(alice, 't1'), {projectId: p.id});
  await wf.sweep();
  assert.ok(asked.length > 0 && asked.every(a => a.startsWith(`${alice.id}:`)), `only people are asked about: ${asked.join(', ')}`);
  await assert.rejects(api.tick(inTenant(bob, 't1'), {projectId: p.id}), {code: 'forbidden'}, "a page's check still needs its caller to read");
  // The system caller is held to the project's tenant all the same.
  await assert.rejects(api.renameProject({requestId: 'rq_x', user: {id: 'system', name: 'system'}, caller: 'system', tenantId: 't2'}, {projectId: p.id, name: 'x'}), /does not exist/);
});

test('creating a project (#63): a grant that keeps failing removes the new project; one that recovers keeps it', async () => {
  const admin = memoryPermissionAdmin();
  let failures = Infinity;
  const flaky = {
    ...admin,
    async grantProjectWrite(...a: Parameters<typeof admin.grantProjectWrite>) {
      if (failures-- > 0) throw new Error('permission platform down');
      return admin.grantProjectWrite(...a);
    },
  };
  const {api, catalog} = world('wf-grant', noHelpers, undefined, {permissionAdmin: flaky});
  await assert.rejects(api.createProject(inTenant(alice, 't1'), 'Lost'), /could not be created/);
  assert.deepEqual(await catalog.find('projects', {}), [], 'no project left that its creator cannot open');
  failures = 3;
  const p = await api.createProject(inTenant(alice, 't1'), 'Kept');
  assert.deepEqual(await admin.listProjectWriters('t1', p.id), [alice.id], 'three failed tries, then the fourth works');
});

test('page views carry the place of waiting work in its queue (#66)', async () => {
  const {api, catalog, jobs, labeling} = world('wf-queue', noHelpers);
  const ctx = inTenant(alice, 't1');
  const p = await api.createProject(ctx, 'Queued');
  const task = (n: number) => labeling.createTask({projectId: p.id, purpose: 'eval', promptVersionId: `pv_${n}`, setupVersionId: 'sv_1', endpoint: 'A', settings: {endpoint: 'A', maxOutputTokens: 150, temperature: null}, exampleIds: ['ex_1'], createdBy: 'Ann'});
  const [a, b] = [await task(1), await task(2)];
  await catalog.insert('optimisation_runs', {id: 'or_1', projectId: p.id, endpoint: 'A', startVersionId: 'pv_1', major: 2, maxRounds: 10, round: 0, state: 'running', step: null, stepStartedAt: null, stepVersionId: null, history: [], calls: 0, candidates: 0, costUsd: 0, stopReason: null, error: null, startedAt: '', finishedAt: null});
  const key = 'model:t1:A';
  for (const [kind, args] of [['labeling.runTask', {taskId: a.id}], ['labeling.runTask', {taskId: b.id}], ['optimiser.run', {runId: 'or_1'}]] as const) await jobs.enqueue(ctx, {kind, projectId: p.id, concurrencyKey: key, args});
  for (const view of [await api.loadProjectState(ctx, p.id), await api.projectStatus(ctx, p.id)]) {
    assert.deepEqual([a.id, b.id].map(id => view!.runs.find(r => r.id === id)?.queue), [{ahead: 0}, {ahead: 1}]);
    assert.deepEqual(view!.optimisation.find(o => o.id === 'or_1')?.queue, {ahead: 2});
  }
});

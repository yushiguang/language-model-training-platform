import assert from 'node:assert/strict';
import test from 'node:test';
import {AccessDeniedError} from '@yushiguang/sprint-contracts';
import type {AuthorizationPort, AuthorizationRequest} from '@yushiguang/sprint-contracts';
import type {AgentRuntimeContract, AgentToolRequest, AgentTurnRequest, CallerUser, DocumentSource, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, PageContext, RequestContext, TicketSubmission, WorkflowContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {configureSystem} from '@yushiguang/sprint-domain';
import {createLabeling, memoryLocks} from '@yushiguang/sprint-labeling';
import {createJobs} from '@yushiguang/sprint-jobs';
import {localDocRuntime, loopback, memoryAccessRequests, memoryJobStore, memoryPeople, memoryPermissionAdmin, memorySharedState} from '@yushiguang/sprint-platform';
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
function world(prefix: string, agents: (wf: ReturnType<typeof createWorkflow>) => AgentRuntimeContract, documents?: DocumentSource, access: Pick<WorkflowDeps, 'authorization' | 'permissionAdmin' | 'accessRequests' | 'people'> = {}) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const forgotten: string[] = [];
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    labelingEndpointsFor: async (tenantId: string) => [...(await catalog.find('tenant_models', {tenantId})).map(m => ({...endpoint, id: m.id, name: m.name, supportsTemperature: false})), endpoint],
    forgetTenant: (tenantId: string) => void forgotten.push(tenantId),
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
  return {wf, api: loopback(wf.api) as WorkflowContract, catalog, tickets, jobs, labeling, forgotten, gateway};
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

test('access (#91): the runtime says whether the caller is an admin; anyone signed in may ask the permission platform for access', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'admin');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  const requests = memoryAccessRequests();
  const {api} = world('wf-access', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin, accessRequests: requests});
  assert.equal((await api.runtimeInfo(inTenant(alice, 't1'))).tenantRole, 'admin');
  assert.equal((await api.runtimeInfo(inTenant(bob, 't1'))).tenantRole, 'member');
  assert.equal((await api.runtimeInfo(inTenant(eve, 't1'))).tenantRole, undefined, 'not in the tenant at all: no role (#94)');
  const p = await api.createProject(inTenant(alice, 't1'), 'Formats');
  // Eve is not even a member: she can still ask, for the tenant or for a project.
  assert.deepEqual(await api.requestAccess(inTenant(eve, 't1'), {permission: 'read'}), {});
  assert.deepEqual(await api.requestAccess(inTenant(bob, 't1'), {permission: 'project_write', projectId: p.id, reason: '  I label the Food examples  '}), {});
  assert.deepEqual(requests.sent, [
    {tenantId: 't1', permission: 'read', userId: eve.id},
    {tenantId: 't1', permission: 'project_write', projectId: p.id, reason: 'I label the Food examples', userId: bob.id},
  ]);
  await assert.rejects(api.requestAccess(inTenant(bob, 't1'), {permission: 'owner' as never}), /no such permission/);
  // Edit access names its project; a blank reason is left out and a long one is cut.
  await assert.rejects(api.requestAccess(inTenant(bob, 't1'), {permission: 'project_write', projectId: '   '}), /Name the project/);
  await api.requestAccess(inTenant(bob, 't1'), {permission: 'tenant_write', reason: '   '});
  await api.requestAccess(inTenant(bob, 't1'), {permission: 'tenant_write', reason: 'x'.repeat(1200)});
  assert.deepEqual(requests.sent.slice(2).map(r => r.reason?.length), [undefined, 1000]);
  // The platform's page for the request is passed on.
  const tracked = world('wf-access-track', noHelpers, undefined, {accessRequests: {request: async () => ({trackUrl: 'https://perm.example/r/1'})}});
  assert.deepEqual(await tracked.api.requestAccess(inTenant(bob, 't1'), {permission: 'read'}), {trackUrl: 'https://perm.example/r/1'});
  // Nothing is granted here: approvers decide on the platform.
  await assert.rejects(api.renameProject(inTenant(bob, 't1'), {projectId: p.id, name: 'x'}), {code: 'forbidden'});
  const bare = world('wf-access-none', noHelpers);
  await assert.rejects(bare.api.requestAccess(inTenant(bob, 't1'), {permission: 'read'}), /not set up/);
  assert.equal((await bare.api.runtimeInfo(inTenant(bob, 't1'))).tenantRole, 'admin', 'no permission checks: everyone may do everything');
});

test('label sets (#82): members read them; changing them needs project write', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'member');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  await perms.admin.addTenantMember(sys, 't2', eve.id, 'member');
  const {api} = world('wf-sets', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const p = await api.createProject(inTenant(alice, 't1'), 'Sets');
  const bobs = inTenant(bob, 't1');
  assert.deepEqual(await api.listLabelSets(bobs, p.id), {sets: [], unassigned: 0, labeled: 0, mismatch: 0}, 'a member reads');
  assert.deepEqual(await api.listSamples(bobs, {projectId: p.id}), {items: [], total: 0, model: null, counts: {live: 0, no_label: 0, mismatch: 0, removed: 0}});
  const structured = {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, label: {name: 'x', kind: 'single' as const, values: []}, ruleGroups: [], images: []};
  assert.equal(await api.goldLabelsCleared(bobs, {projectId: p.id, structured}), 0);
  for (const call of [api.createLabelSet(bobs, {projectId: p.id, count: 1}), api.createLabelSets(bobs, {projectId: p.id, sets: 1}), api.updateLabelSet(bobs, {projectId: p.id, labelSetId: 'ls_1', name: 'x'})]) await assert.rejects(call, {code: 'forbidden'});
  await assert.rejects(api.createLabelSet(inTenant(alice, 't1'), {projectId: p.id, count: 1}), /Add samples to the dataset first/, 'the writer passes the check');
  await assert.rejects(api.listLabelSets(inTenant(eve, 't2'), p.id), /does not exist/, 'another tenant cannot see them');
  // Rescore (#86) needs project write too; the writer passes and is told why nothing can be scored.
  await assert.rejects(api.rescore(bobs, p.id), {code: 'forbidden'});
  await assert.rejects(api.rescore(inTenant(eve, 't2'), p.id), {code: 'forbidden'}, 'another tenant cannot either');
  await assert.rejects(api.rescore(inTenant(alice, 't1'), p.id), /every label set is finished/);
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
  await assert.rejects(api.renameDataSource(inTenant(alice, 't1'), {sourceId: 'src_x', name: 'x'}), {code: 'forbidden'}, 'only admins rename data sources');
  await assert.rejects(api.deleteDataSource(inTenant(alice, 't1'), {sourceId: 'src_x'}), {code: 'forbidden'}, 'only admins delete data sources');
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

test('tenants (#94): anyone signed in creates one and becomes its admin; names are unique without case; the home page lists the caller\'s own', async () => {
  const perms = checking();
  const {api, catalog} = world('wf-tenant-records', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const made = await api.createTenant(ctxOf(alice), {name: '  Content   Safety '});
  assert.ok(made.tenant, made.error ?? 'no tenant');
  assert.deepEqual({...made.tenant, id: undefined}, {id: undefined, name: 'Content Safety', role: 'admin', projects: 0});
  assert.match(made.tenant.id, /^tn_/);
  assert.equal(perms.admin.roleOf(made.tenant.id, alice.id), 'admin', 'the creator is the first admin');
  // Blank names and taken names (any case, any spacing) come back as the form's error.
  assert.deepEqual(await api.createTenant(ctxOf(bob), {name: '   '}), {error: 'Enter a name. Spaces alone are not a name.'});
  assert.deepEqual(await api.createTenant(ctxOf(bob), {name: 'content safety'}), {error: 'A tenant with this name already exists. Pick another name.'});
  const other = (await api.createTenant(ctxOf(bob), {name: 'Ads'})).tenant!;
  // Inside a tenant it reads like any other: projects counted, the record names it in the runtime.
  const t1 = inTenant(alice, made.tenant.id);
  await api.createProject(t1, 'One');
  await api.createProject(t1, 'Two');
  await perms.admin.addTenantMember(ctxOf(bob), other.id, alice.id, 'member');
  assert.deepEqual(await api.listTenants(ctxOf(alice)), [
    {id: other.id, name: 'Ads', role: 'member', projects: 0},
    {id: made.tenant.id, name: 'Content Safety', role: 'admin', projects: 2},
  ]);
  assert.deepEqual(await api.listTenants(ctxOf(eve)), [], 'in no tenant yet');
  const info = await api.runtimeInfo(t1);
  assert.deepEqual([info.tenantRole, info.tenantName], ['admin', 'Content Safety']);
  assert.equal((await api.runtimeInfo(inTenant(eve, made.tenant.id))).tenantRole, undefined, 'not in it: no role');
  assert.equal((await catalog.find('tenants', {})).length, 2);
});

test('tenant members (#107): any member lists them by name, with the email the platform knows; a member without a name is named by the identity or the user id', async () => {
  const perms = checking(memoryPermissionAdmin({seed: [{tenantId: 't1', userId: bob.id, role: 'member', name: 'Bob Smith', email: 'bob@example.com'}]}));
  const {api} = world('wf-members', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  await perms.admin.addTenantMember(ctxOf(alice), 't1', alice.id, 'admin');
  await perms.admin.addTenantMember(ctxOf(alice), 't1', 'u_zed', 'member');
  const want = [
    {userId: alice.id, name: 'Alice', role: 'admin'},
    {userId: bob.id, name: 'Bob Smith', email: 'bob@example.com', role: 'member'},
    {userId: 'u_zed', name: 'u_zed', role: 'member'},
  ];
  assert.deepEqual(await api.listTenantMembers(inTenant(alice, 't1')), want);
  assert.deepEqual(await api.listTenantMembers(inTenant(bob, 't1')), [want[1], {...want[0], name: alice.id}, want[2]], "another member's name is the platform's to give; by name");
  await assert.rejects(api.listTenantMembers(inTenant(eve, 't1')), {code: 'forbidden'}, 'not a member: refused');
  const bare = world('wf-members-bare', noHelpers);
  assert.deepEqual(await bare.api.listTenantMembers(inTenant(alice, 't9')), [{userId: alice.id, name: 'Alice', role: 'admin'}], 'no platform: the caller alone');
  const withEmail = {...alice, email: 'alice@example.com'};
  assert.deepEqual(await bare.api.listTenantMembers(inTenant(withEmail, 't9')), [{userId: alice.id, name: 'Alice', email: 'alice@example.com', role: 'admin'}], "the caller's own email comes from the identity");
});

test('tenants (#94): an admin that cannot be written removes the new tenant; without a permission platform none is made', async () => {
  const admin = memoryPermissionAdmin();
  let failures = Infinity;
  const flaky = {
    ...admin,
    async addTenantMember(...a: Parameters<typeof admin.addTenantMember>) {
      if (failures-- > 0) throw new Error('permission platform down');
      return admin.addTenantMember(...a);
    },
  };
  const {api, catalog} = world('wf-tenant-grant', noHelpers, undefined, {permissionAdmin: flaky});
  await assert.rejects(api.createTenant(ctxOf(alice), {name: 'Lost'}), /could not be created/);
  assert.deepEqual(await catalog.find('tenants', {}), [], 'no tenant left that nobody is in');
  failures = 3;
  assert.ok((await api.createTenant(ctxOf(alice), {name: 'Lost'})).tenant, 'the name is free again, and the fourth try works');
  const bare = world('wf-tenant-bare', noHelpers);
  await assert.rejects(bare.api.createTenant(ctxOf(alice), {name: 'X'}), /cannot be created here/);
  assert.deepEqual(await bare.api.listTenants(inTenant(alice, 't9')), [{id: 't9', name: 't9', role: 'admin', projects: 0}], 'no platform: the current tenant alone');
});

test('tenant page (#103): project rows page by page, mine only, with step, score, running work and last change', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'admin');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  const {api} = world('wf-project-rows', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const a = inTenant(alice, 't1');
  const b = inTenant(bob, 't1');
  // Made a moment apart, so newest first is one order.
  const later = () => new Promise(r => setTimeout(r, 3));
  const one = await api.createProject(a, 'One');
  await later();
  const two = await api.createProject(b, 'Two');
  await later();
  const three = await api.createProject(a, 'Three');
  const all = await api.listProjectRows(b, {});
  assert.equal(all.total, 3);
  assert.deepEqual(all.rows.map(r => r.name), ['Three', 'Two', 'One'], 'newest first');
  const row = all.rows[2];
  assert.deepEqual({...row, updatedAt: undefined, createdAt: undefined}, {id: one.id, name: 'One', createdBy: 'Alice', createdById: alice.id, createdAt: undefined, step: 'prompt_design', best: null, running: 0, updatedAt: undefined});
  assert.ok(row.updatedAt >= row.createdAt, 'the last change: its creation, so far');
  assert.deepEqual((await api.listProjectRows(a, {mine: true})).rows.map(r => r.id), [three.id, one.id]);
  const page2 = await api.listProjectRows(a, {offset: 1, limit: 1});
  assert.deepEqual([page2.total, page2.rows.map(r => r.id)], [3, [two.id]]);
  // A rename is a change: the row says when.
  await api.renameProject(a, {projectId: one.id, name: 'First'});
  const renamed = (await api.listProjectRows(a, {})).rows.find(r => r.id === one.id)!;
  assert.equal(renamed.name, 'First');
  assert.ok(renamed.updatedAt >= row.updatedAt);
  await assert.rejects(api.listProjectRows(inTenant(eve, 't1'), {}), {code: 'forbidden'}, 'not a member');
});

test('tenant page (#103): the tenant and its counts; a new project takes the dialog\'s model and thresholds, confirmed', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'admin');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  const {api} = world('wf-new-project', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const a = inTenant(alice, 't1');
  const b = inTenant(bob, 't1');
  assert.deepEqual(await api.projectDefaults(b), {models: [{id: 'A', name: 'Model A'}], model: 'A', thresholds: {macroF1: 0.8, precision: null, recall: null}}, 'the configured default Macro-F1');
  const team = (await api.addModel(a, {name: 'Team', endpoint: 'https://models.example/team', qpm: 60, tpm: 100_000})).model!;
  const d = await api.projectDefaults(b);
  assert.deepEqual([d.models.map(m => m.id), d.model], [[team.id, 'A'], team.id], "the tenant's default comes first");

  assert.deepEqual(await api.newProject(b, {name: '   '}), {error: 'Enter a name. Spaces alone are not a name.'});
  assert.deepEqual(await api.newProject(b, {name: 'X', model: 'nope'}), {error: 'This model is not available.'});
  assert.deepEqual(await api.newProject(b, {name: 'X', thresholds: {macroF1: 1.5, precision: null, recall: null}}), {error: 'Thresholds are between 0% and 100%.'});
  assert.equal((await api.listProjects(b)).length, 0, 'nothing made on an error');

  const made = await api.newProject(b, {name: ' Ads  check ', model: 'A', thresholds: {macroF1: 0.9, precision: 0.8, recall: null}});
  assert.equal(made.project?.name, 'Ads check');
  assert.equal(made.project?.settingsConfirmed, true, 'the dialog confirmed the settings');
  const s = (await api.loadProjectState(b, made.project!.id))!;
  assert.deepEqual([s.setup!.models[0].endpoint, s.setup!.thresholds!.mode, s.setup!.thresholds!.macroF1, s.setup!.thresholds!.precision, s.setup!.thresholds!.recall], ['A', 'custom', 0.9, 0.8, null]);
  const plain = await api.newProject(b, {name: 'Plain', model: team.id, thresholds: {macroF1: 0.8, precision: null, recall: null}});
  assert.equal((await api.loadProjectState(b, plain.project!.id))!.setup!.thresholds!.mode, 'default', 'the default thresholds stay the default');
  const bare = await api.newProject(b, {name: 'Bare'});
  assert.equal(bare.project?.settingsConfirmed, false, 'no choices made: confirmed later, as before');

  const t = await api.getTenant(b);
  assert.deepEqual({...t, dataSources: undefined}, {id: 't1', name: 't1', role: 'member', projects: 3, dataSources: undefined, models: 1, members: 2});
  assert.equal(typeof t.dataSources, 'number');
  await assert.rejects(api.getTenant(inTenant(eve, 't1')), {code: 'forbidden'});
});

test('tenant settings (#111): admins rename the tenant, add people, change roles and remove members; the tenant always keeps an admin', async () => {
  const perms = checking();
  const {api, catalog} = world('wf-tenant-admin', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin, people: memoryPeople()});
  const made = (await api.createTenant(ctxOf(alice), {name: 'Safety'})).tenant!;
  await api.createTenant(ctxOf(bob), {name: 'Ads'});
  const a = inTenant(alice, made.id);
  assert.deepEqual(await api.renameTenant(a, {name: '  '}), {error: 'Enter a name. Spaces alone are not a name.'});
  assert.deepEqual(await api.renameTenant(a, {name: 'ads'}), {error: 'A tenant with this name already exists. Pick another name.'});
  assert.deepEqual(await api.renameTenant(a, {name: ' Content   Safety '}), {name: 'Content Safety'});
  assert.deepEqual(await api.renameTenant(a, {name: 'content safety'}), {name: 'content safety'}, 'its own name, another case');
  assert.equal((await catalog.get('tenants', made.id))?.name, 'content safety');
  // A tenant without a record gets one under its id.
  await perms.admin.addTenantMember(ctxOf(alice), 't-org', alice.id, 'admin');
  assert.deepEqual(await api.renameTenant(inTenant(alice, 't-org'), {name: 'Org'}), {name: 'Org'});
  assert.equal((await catalog.get('tenants', 't-org'))?.name, 'Org');

  // People come from the directory; a blank query finds no one.
  assert.deepEqual(await api.searchPeople(a, {query: ' '}), []);
  assert.deepEqual((await api.searchPeople(a, {query: 'MEI'})).map(p => p.id), ['u-mei']);
  assert.deepEqual(await api.addTenantMembers(a, {userIds: [], role: 'member'}), {error: 'Pick someone to add.'});
  assert.deepEqual(await api.addTenantMembers(a, {userIds: [bob.id, 'u-mei', alice.id, bob.id], role: 'member'}), {});
  assert.equal(perms.admin.roleOf(made.id, alice.id), 'admin', 'already in: keeps the role');
  assert.equal(perms.admin.roleOf(made.id, bob.id), 'member');
  // Members read and can search the directory; only admins change members.
  const b = inTenant(bob, made.id);
  await assert.rejects(api.addTenantMembers(b, {userIds: [eve.id], role: 'member'}), {code: 'forbidden'});
  await assert.rejects(api.renameTenant(b, {name: 'Mine'}), {code: 'forbidden'});
  assert.deepEqual((await api.searchPeople(b, {query: 'MEI'})).map(p => p.id), ['u-mei']);
  assert.deepEqual((await api.searchPeople(ctxOf(eve), {query: 'MEI'})).map(p => p.id), ['u-mei'], 'signed-in users outside a tenant can search to pick initial co-admins');

  const last = "The last admin can't be changed. Make someone else an admin first.";
  assert.deepEqual(await api.setTenantRole(a, {userId: alice.id, role: 'member'}), {error: last});
  assert.deepEqual(await api.removeTenantMember(a, {userId: alice.id}), {error: last});
  assert.deepEqual(await api.setTenantRole(a, {userId: bob.id, role: 'admin'}), {});
  assert.deepEqual(await api.setTenantRole(a, {userId: alice.id, role: 'member'}), {}, 'Bob is an admin now');
  assert.deepEqual(await api.removeTenantMember(b, {userId: 'u-mei'}), {});
  assert.deepEqual(await api.removeTenantMember(b, {userId: 'u-mei'}), {error: 'This person is not in the tenant.'});
  assert.deepEqual((await perms.admin.listTenantMembers(made.id)).map(m => [m.userId, m.role]).sort(), [[alice.id, 'member'], [bob.id, 'admin']]);
  assert.ok((await catalog.find('audit_log', {action: 'tenant.role'})).length === 2);
});

test('tenant settings (#111): deleting a tenant takes its projects, sources, models and members with it', async () => {
  const perms = checking();
  const {api, catalog, forgotten} = world('wf-tenant-delete', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const made = (await api.createTenant(ctxOf(alice), {name: 'Doomed'})).tenant!;
  const a = inTenant(alice, made.id);
  await api.addTenantMembers(a, {userIds: [bob.id], role: 'member'});
  const p = await api.createProject(a, 'One');
  await api.addModel(a, {name: 'Team', endpoint: 'https://models.example/team', qpm: 60, tpm: 100_000});
  await assert.rejects(api.deleteTenant(inTenant(bob, made.id), {name: 'Doomed'}), {code: 'forbidden'});
  assert.deepEqual(await api.deleteTenant(a, {name: 'doomed'}), {error: 'Type the tenant name to confirm.'});
  assert.deepEqual(await api.deleteTenant(a, {name: 'Doomed'}), {});
  assert.ok(!(await catalog.get('tenants', made.id)), 'its record is gone');
  assert.deepEqual(await catalog.find('tenant_models', {tenantId: made.id}), []);
  assert.ok(forgotten.includes(made.id), 'the gateway reads the models again');
  assert.equal((await catalog.get('projects', p.id))?.deleting, true, 'its project is on its way out');
  assert.deepEqual(await perms.admin.listTenantMembers(made.id), []);
  assert.deepEqual(await api.listTenants(ctxOf(alice)), [], 'gone from the home page');
  // A tenant without a record (the organization's own) cannot be deleted here.
  await perms.admin.addTenantMember(ctxOf(alice), 't-org', alice.id, 'admin');
  assert.deepEqual(await api.deleteTenant(inTenant(alice, 't-org'), {name: 't-org'}), {error: "This tenant comes with your organization. It can't be deleted."});
});

test('project editors (#118): the creator first and always; tenant members are added and removed; outsiders are not', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'member');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  const {api, catalog} = world('wf-editors', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const a = inTenant(alice, 't1');
  const b = inTenant(bob, 't1');
  const p = await api.createProject(a, 'Shared');
  assert.deepEqual(await api.listProjectEditors(b, {projectId: p.id}), [{userId: alice.id, name: 'Alice', creator: true, addedAt: null}], 'any member reads them; the creator is named by the project');
  await assert.rejects(api.addProjectEditors(b, {projectId: p.id, userIds: [bob.id]}), {code: 'forbidden'}, 'only editors add editors');
  assert.deepEqual(await api.addProjectEditors(a, {projectId: p.id, userIds: []}), {error: 'Pick someone to add.'});
  assert.deepEqual(await api.addProjectEditors(a, {projectId: p.id, userIds: [eve.id]}), {error: 'Only members of this tenant can edit its projects.'});
  assert.deepEqual(await api.addProjectEditors(a, {projectId: p.id, userIds: [bob.id, bob.id, alice.id]}), {});
  assert.ok(perms.admin.canWrite('t1', p.id, bob.id));
  const list = await api.listProjectEditors(b, {projectId: p.id});
  assert.deepEqual(list.map(e => [e.userId, e.creator]), [[alice.id, true], [bob.id, false]]);
  assert.ok(list[1].addedAt, 'when Bob was added');
  assert.equal((await catalog.find('audit_log', {projectId: p.id, action: 'project.editor_added'})).length, 1, 'the creator was not added again');
  // Bob edits now, so he can take himself off; the creator stays.
  assert.deepEqual(await api.removeProjectEditor(b, {projectId: p.id, userId: alice.id}), {error: 'The creator can always edit the project.'});
  assert.deepEqual(await api.removeProjectEditor(b, {projectId: p.id, userId: bob.id}), {});
  assert.ok(!perms.admin.canWrite('t1', p.id, bob.id));
  assert.deepEqual(await api.removeProjectEditor(a, {projectId: p.id, userId: bob.id}), {error: 'This person cannot edit the project.'});
  assert.deepEqual((await api.listProjectEditors(a, {projectId: p.id})).map(e => e.userId), [alice.id]);
});

test('page views carry the place of waiting work in its queue (#66)', async () => {
  const {api, catalog, jobs, labeling} = world('wf-queue', noHelpers);
  const ctx = inTenant(alice, 't1');
  const p = await api.createProject(ctx, 'Queued');
  const task = (n: number) => labeling.createTask({projectId: p.id, tenantId: 't1', purpose: 'eval', promptVersionId: `pv_${n}`, setupVersionId: 'sv_1', endpoint: 'A', settings: {endpoint: 'A', maxOutputTokens: 150, temperature: null}, exampleIds: ['ex_1'], createdBy: 'Ann'});
  const [a, b] = [await task(1), await task(2)];
  await catalog.insert('optimisation_runs', {id: 'or_1', projectId: p.id, endpoint: 'A', startVersionId: 'pv_1', major: 2, maxRounds: 10, round: 0, state: 'running', step: null, stepStartedAt: null, stepVersionId: null, history: [], calls: 0, candidates: 0, costUsd: 0, stopReason: null, error: null, startedAt: '', finishedAt: null});
  const key = 'model:t1:A';
  for (const [kind, args] of [['labeling.runTask', {taskId: a.id}], ['labeling.runTask', {taskId: b.id}], ['optimiser.run', {runId: 'or_1'}]] as const) await jobs.enqueue(ctx, {kind, projectId: p.id, concurrencyKey: key, args});
  for (const view of [await api.loadProjectState(ctx, p.id), await api.projectStatus(ctx, p.id)]) {
    assert.deepEqual([a.id, b.id].map(id => view!.runs.find(r => r.id === id)?.queue), [{ahead: 0}, {ahead: 1}]);
    assert.deepEqual(view!.optimisation.find(o => o.id === 'or_1')?.queue, {ahead: 2});
  }
});

test('tenant models (#69): admins manage them; the first is the default; new projects use the default; a used model cannot be removed', async () => {
  const perms = checking();
  const sys = {requestId: 'rq_setup', user: {id: 'u_admin', name: 'Admin'}};
  await perms.admin.addTenantMember(sys, 't1', alice.id, 'admin');
  await perms.admin.addTenantMember(sys, 't1', bob.id, 'member');
  await perms.admin.addTenantMember(sys, 't2', eve.id, 'admin');
  const {api, forgotten} = world('wf-models', noHelpers, undefined, {authorization: perms.authorization, permissionAdmin: perms.admin});
  const a = inTenant(alice, 't1');
  assert.deepEqual(await api.listModels(inTenant(bob, 't1')), [], 'a member sees the models');
  for (const call of [api.addModel(inTenant(bob, 't1'), {name: 'x', endpoint: 'e', qpm: 1, tpm: 1}), api.setDefaultModel(inTenant(bob, 't1'), {modelId: 'x'})]) await assert.rejects(call, {code: 'forbidden'}, 'a member does not change models');

  assert.equal((await api.addModel(a, {name: ' ', endpoint: 'e', qpm: 1, tpm: 1})).error, 'Give the model a name.');
  assert.equal((await api.addModel(a, {name: 'Team', endpoint: 'e', qpm: 0, tpm: 1})).error, 'QPM must be a whole number above 0.');
  const team = (await api.addModel(a, {name: 'Team', endpoint: ' https://models.example/team ', qpm: 60, tpm: 100_000})).model!;
  assert.deepEqual([team.endpoint, team.default, team.tenantId, team.usedBy], ['https://models.example/team', true, 't1', 0]);
  const second = (await api.addModel(a, {name: 'Second', endpoint: 'https://models.example/2', qpm: 10, tpm: 10_000})).model!;
  assert.equal(second.default, false, 'only the first model becomes the default');
  assert.equal((await api.addModel(a, {name: 'team', endpoint: 'e', qpm: 1, tpm: 1})).error, 'A model with this name already exists.');
  assert.ok(forgotten.filter(t => t === 't1').length >= 2, 'the gateway is told to read the models again');

  // Another tenant neither sees nor changes them.
  const e = inTenant(eve, 't2');
  assert.deepEqual(await api.listModels(e), []);
  assert.equal((await api.updateModel(e, {modelId: team.id, qpm: 1})).error, 'This model does not exist.');
  assert.equal((await api.removeModel(e, {modelId: team.id})).error, 'This model does not exist.');

  // A new project uses the tenant's default model; its page lists the tenant's models.
  const p1 = await api.createProject(a, 'One');
  const s1 = (await api.loadProjectState(a, p1.id))!;
  assert.equal(s1.setup!.models[0].endpoint, team.id);
  assert.deepEqual(s1.endpoints.map(x => x.id), [team.id, second.id, 'A']);
  assert.equal((await api.listModels(a)).find(m => m.id === team.id)!.usedBy, 1);
  assert.match((await api.removeModel(a, {modelId: team.id})).error!, /A project uses this model/);

  // Another default; the next project takes it. Settings accept the tenant's models and the platform's, not another tenant's.
  assert.equal((await api.setDefaultModel(a, {modelId: second.id})).model!.default, true);
  assert.deepEqual((await api.listModels(a)).map(m => [m.name, m.default]), [['Second', true], ['Team', false]]);
  const p2 = await api.createProject(a, 'Two');
  assert.equal((await api.loadProjectState(a, p2.id))!.setup!.models[0].endpoint, second.id);
  const theirs = (await api.addModel(e, {name: 'Theirs', endpoint: 'x', qpm: 1, tpm: 1})).model!;
  const settings = (endpointId: string) => ({projectId: p1.id, thresholds: s1.setup!.thresholds!, model: {endpoint: endpointId, maxOutputTokens: 100, temperature: 0.5}});
  await assert.rejects(api.saveSettings(a, settings(theirs.id)), /This model is not available/);
  await assert.rejects(api.saveSettings(a, settings('missing')), /This model is not available/);
  await api.saveSettings(a, settings('A'));
  assert.equal((await api.loadProjectState(a, p1.id))!.setup!.models[0].temperature, 0.5);
  await api.saveSettings(a, settings(second.id));
  assert.equal((await api.loadProjectState(a, p1.id))!.setup!.models[0].temperature, null, 'tenant models take no temperature');

  // No project uses Team any more: it can be removed. A change keeps the fields not given.
  assert.deepEqual(await api.removeModel(a, {modelId: team.id}), {});
  const changed = (await api.updateModel(a, {modelId: second.id, qpm: 120})).model!;
  assert.deepEqual([changed.name, changed.qpm, changed.tpm, changed.usedBy], ['Second', 120, 10_000, 2]);
  assert.deepEqual((await api.listModels(a)).map(m => m.name), ['Second']);
});

test('tenant models (#69): no default means the platform default; removing the default picks none; a deleted project frees its model', async () => {
  const {api} = world('wf-models-default', noHelpers);
  const a = inTenant(alice, 't1');
  const before = await api.createProject(a, 'Before');
  assert.equal((await api.loadProjectState(a, before.id))!.setup!.models[0].endpoint, 'A', 'no tenant model: the platform default');
  const m1 = (await api.addModel(a, {name: 'One', endpoint: 'e1', qpm: 1, tpm: 1})).model!;
  const m2 = (await api.addModel(a, {name: 'Two', endpoint: 'e2', qpm: 1, tpm: 1})).model!;
  assert.deepEqual([m1.default, m2.default], [true, false]);
  // The default removed: no other model becomes the default, and new projects use the platform's.
  assert.deepEqual(await api.removeModel(a, {modelId: m1.id}), {});
  assert.deepEqual((await api.listModels(a)).map(m => [m.name, m.default]), [['Two', false]]);
  const p = await api.createProject(a, 'After');
  assert.equal((await api.loadProjectState(a, p.id))!.setup!.models[0].endpoint, 'A');
  // With no default, the next model added becomes it.
  const m3 = (await api.addModel(a, {name: 'Three', endpoint: 'e3', qpm: 1, tpm: 1})).model!;
  assert.equal(m3.default, true);
  const uses = await api.createProject(a, 'Uses three');
  assert.match((await api.removeModel(a, {modelId: m3.id})).error!, /A project uses this model/);
  await api.deleteProject(a, {projectId: uses.id});
  assert.equal((await api.listModels(a)).find(m => m.id === m3.id)!.usedBy, 0, 'a project being deleted no longer holds its model');
  assert.deepEqual(await api.removeModel(a, {modelId: m3.id}), {});
});

test('tenant models (#69): a project page reads the models again when the gateway\'s cache lacks the one its settings use', async () => {
  const {api, gateway, forgotten, catalog} = world('wf-models-stale', noHelpers);
  const a = inTenant(alice, 't1');
  const m = (await api.addModel(a, {name: 'New', endpoint: 'e', qpm: 1, tpm: 1})).model!;
  const p = await api.createProject(a, 'Uses new');
  // Another process's gateway: its cache was read before the model was added, until it is told to forget.
  const fresh = gateway.labelingEndpointsFor.bind(gateway);
  let stale = true;
  Object.assign(gateway, {
    labelingEndpointsFor: async (tenantId: string) => (stale ? gateway.labelingEndpoints() : fresh(tenantId)),
    forgetTenant: (tenantId: string) => ((stale = false), void forgotten.push(tenantId)),
  });
  forgotten.length = 0;
  const s = (await api.loadProjectState(a, p.id))!;
  assert.equal(s.setup!.models[0].endpoint, m.id);
  assert.deepEqual(s.endpoints.map(x => x.id), [m.id, 'A'], 'the page lists the model the project uses');
  assert.deepEqual(forgotten, ['t1']);
  // Nothing missing: no second read.
  await api.loadProjectState(a, p.id);
  assert.deepEqual(forgotten, ['t1']);
  // A missing model that is not the tenant's (a platform model taken away) or a failing store: the cache is kept.
  await catalog.patch('setup_versions', s.setup!.id, {models: [{...s.setup!.models[0], endpoint: 'gone'}]});
  assert.deepEqual((await api.loadProjectState(a, p.id))!.endpoints.map(x => x.id), [m.id, 'A']);
  Object.assign(gateway, {labelingEndpointsFor: async () => { throw new Error('store down'); }});
  assert.deepEqual((await api.loadProjectState(a, p.id))!.endpoints.map(x => x.id), ['A']);
  assert.deepEqual(forgotten, ['t1'], 'the gateway is not told to forget');
});

test('access redirect mode and configurable min tenant admins (#120)', async () => {
  const perms = checking();
  const requests = memoryAccessRequests({
    mode: 'redirect',
    applyUrl: r => `https://perm.example/apply/${r.tenantId}/${r.permission}${r.projectId ? `/${r.projectId}` : ''}`,
  });
  configureSystem({tenant: {minAdmins: 2}});
  try {
    const {api} = world('wf-min-admins', noHelpers, undefined, {
      authorization: perms.authorization,
      permissionAdmin: perms.admin,
      accessRequests: requests,
    });
    const info = await api.runtimeInfo(inTenant(alice, 't1'));
    assert.equal(info.minTenantAdmins, 2);
    assert.equal(info.accessRequestMode, 'redirect');
    assert.deepEqual(await api.requestAccess(inTenant(bob, 't1'), {permission: 'read'}), {
      applyUrl: 'https://perm.example/apply/t1/read',
    });

    // Creator alone or duplicate creator in adminIds is rejected under minAdmins = 2.
    assert.deepEqual(await api.createTenant(ctxOf(alice), {name: 'Two Owners'}), {error: 'Pick at least one other admin.'});
    assert.deepEqual(await api.createTenant(ctxOf(alice), {name: 'Two Owners', adminIds: [alice.id, '  ']}), {error: 'Pick at least one other admin.'});

    // Duplicate co-admins are deduplicated; valid two admins succeed.
    const made = await api.createTenant(ctxOf(alice), {name: 'Two Owners', adminIds: [bob.id, bob.id]});
    assert.ok(made.tenant, made.error ?? 'tenant expected');
    assert.equal(perms.admin.roleOf(made.tenant.id, alice.id), 'admin');
    assert.equal(perms.admin.roleOf(made.tenant.id, bob.id), 'admin');

    const a = inTenant(alice, made.tenant.id);
    const keepTwo = 'A tenant must keep at least 2 admins. Make someone else an admin first.';
    assert.deepEqual(await api.setTenantRole(a, {userId: bob.id, role: 'member'}), {error: keepTwo});
    assert.deepEqual(await api.removeTenantMember(a, {userId: bob.id}), {error: keepTwo});

    // Adding a third admin allows demoting/removing down to 2, then stops again at 2.
    assert.deepEqual(await api.addTenantMembers(a, {userIds: [eve.id], role: 'admin'}), {});
    assert.deepEqual(await api.setTenantRole(a, {userId: bob.id, role: 'member'}), {});
    assert.deepEqual(await api.removeTenantMember(a, {userId: eve.id}), {error: keepTwo});
  } finally {
    configureSystem();
  }
  const defaults = world('wf-min-admins-default', noHelpers, undefined, {accessRequests: memoryAccessRequests()});
  const defaultInfo = await defaults.api.runtimeInfo(inTenant(alice, 't1'));
  assert.equal(defaultInfo.minTenantAdmins, undefined);
  assert.equal(defaultInfo.accessRequestMode, undefined);
});

test('permission platform lifecycle hooks (#120): custom hooks run and legacy adapters without hooks keep working', async () => {
  const calls: string[] = [];
  const inner = memoryPermissionAdmin();
  const hooked = {
    listTenantMembers: inner.listTenantMembers,
    listUserTenants: inner.listUserTenants,
    addTenantMember: inner.addTenantMember,
    removeTenantMember: inner.removeTenantMember,
    setTenantRole: inner.setTenantRole,
    listProjectWriters: inner.listProjectWriters,
    grantProjectWrite: inner.grantProjectWrite,
    revokeProjectWrite: inner.revokeProjectWrite,
    createTenant: async (ctx: RequestContext, t: {tenantId: string; name: string; adminIds: string[]}) => {
      calls.push(`createTenant:${t.tenantId}:${t.name}:${t.adminIds.join(',')}`);
      await inner.createTenant!(ctx, t);
    },
    deleteTenant: async (ctx: RequestContext, tenantId: string) => {
      calls.push(`deleteTenant:${tenantId}`);
      await inner.deleteTenant!(ctx, tenantId);
    },
    createProject: async (ctx: RequestContext, p: {tenantId: string; projectId: string; name: string; creatorId: string}) => {
      calls.push(`createProject:${p.tenantId}:${p.projectId}:${p.name}:${p.creatorId}`);
      await inner.createProject!(ctx, p);
    },
    deleteProject: async (ctx: RequestContext, tenantId: string, projectId: string) => {
      calls.push(`deleteProject:${tenantId}:${projectId}`);
      await inner.deleteProject!(ctx, tenantId, projectId);
    },
  };
  const {wf, api, jobs, catalog} = world('wf-perm-hooks', noHelpers, undefined, {permissionAdmin: hooked});
  const tn = (await api.createTenant(ctxOf(alice), {name: 'Hooked', adminIds: [bob.id]})).tenant!;
  const a = inTenant(alice, tn.id);
  const pr = await api.createProject(a, 'Project A');
  await api.deleteProject(a, {projectId: pr.id});
  const queued = await jobs.list(a, {projectId: pr.id, kinds: ['project.delete']});
  assert.equal(queued.length, 1);
  const exec = wf.executors.find(e => e.kind === 'project.delete')!;
  await exec.run(queued[0], {heartbeat: async () => {}} as never);
  assert.equal(await catalog.get('projects', pr.id), null, 'project record removed after deleteProject hook');
  await api.deleteTenant(a, {name: 'Hooked'});
  assert.deepEqual(calls, [
    `createTenant:${tn.id}:Hooked:${alice.id},${bob.id}`,
    `createProject:${tn.id}:${pr.id}:Project A:${alice.id}`,
    `deleteProject:${tn.id}:${pr.id}`,
    `deleteTenant:${tn.id}`,
  ]);

  // Minimal legacy adapter omitting all four optional hooks falls back cleanly.
  const minimal = memoryPermissionAdmin();
  const legacy = {
    listTenantMembers: minimal.listTenantMembers,
    listUserTenants: minimal.listUserTenants,
    addTenantMember: minimal.addTenantMember,
    removeTenantMember: minimal.removeTenantMember,
    setTenantRole: minimal.setTenantRole,
    listProjectWriters: minimal.listProjectWriters,
    grantProjectWrite: minimal.grantProjectWrite,
    revokeProjectWrite: minimal.revokeProjectWrite,
  };
  const leg = world('wf-perm-legacy', noHelpers, undefined, {permissionAdmin: legacy});
  const tn2 = (await leg.api.createTenant(ctxOf(alice), {name: 'Legacy'})).tenant!;
  const pr2 = await leg.api.createProject(inTenant(alice, tn2.id), 'Project L');
  assert.equal(minimal.roleOf(tn2.id, alice.id), 'admin');
  assert.equal(minimal.canWrite(tn2.id, pr2.id, alice.id), true);
  await leg.api.deleteTenant(inTenant(alice, tn2.id), {name: 'Legacy'});
  assert.deepEqual(await minimal.listTenantMembers(tn2.id), []);
});

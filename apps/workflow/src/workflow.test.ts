import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, AgentToolRequest, AgentTurnRequest, CallerUser, DocumentSource, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, PageContext, RequestContext, TicketSubmission, WorkflowContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, memoryLocks} from '@yushiguang/sprint-labeling';
import {createJobs} from '@yushiguang/sprint-jobs';
import {localDocRuntime, loopback, memoryJobStore, memorySharedState} from '@yushiguang/sprint-platform';
import {createWorkflow} from './workflow.ts';

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
function world(prefix: string, agents: (wf: ReturnType<typeof createWorkflow>) => AgentRuntimeContract, documents?: DocumentSource) {
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
  const wf = createWorkflow({
    catalog,
    labeling,
    gateway,
    files: {} as FileStore,
    examples: {} as ExampleSource,
    standIns: [],
    sharedState: memorySharedState(),
    jobs: createJobs({store: memoryJobStore()}).api,
    ...(documents ? {documents} : {}),
    tickets: {submit: async t => (tickets.push(t), {ticketId: `T-${tickets.length}`})},
  });
  wf.connect({agents: agents(wf)});
  return {wf, api: loopback(wf.api) as WorkflowContract, catalog, tickets};
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
  await wf.toolHost.call({agent: 'prompt_agent', name: 'get_project_summary', args: {}, projectId: a.id, turnId: null, ctx: ctxOf(alice)});
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
  };
  const api = loopback(impl);
  const arg = {when: undefined, keep: 1};
  const out = await api.echo(ctxOf(alice), arg, undefined);
  assert.deepEqual(out, {ctx: 'Alice', x: {keep: 1}, extra: 'none', n: 2}, 'undefined fields and trailing arguments are dropped');
  out.x.keep = 2;
  assert.equal(arg.keep, 1, 'the caller gets a copy');
  await assert.rejects(api.fails(), (e: Error & {code?: string}) => e.message === 'This version does not exist.' && e.code === 'not_found');
  assert.equal(await api.nothing(), null);
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

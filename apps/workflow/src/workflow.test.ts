import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, AgentTurnInput, CallerUser, DocumentSource, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract, PageContext, RequestContext, TicketSubmission, WorkflowContract} from '@sprint/contracts';
import {createCatalog} from '@sprint/catalog';
import {createLabeling, memoryLocks} from '@sprint/labeling';
import {localDocRuntime, loopback, memorySharedState} from '@sprint/platform';
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
    ...(documents ? {documents} : {}),
    tickets: {submit: async t => (tickets.push(t), {ticketId: `T-${tickets.length}`})},
  });
  wf.connect({agents: agents(wf)});
  return {wf, api: loopback(wf.api) as WorkflowContract, catalog, tickets};
}

const noHelpers = (): AgentRuntimeContract => ({
  runTurn: async () => ({invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []}),
  reflectPrompt: async () => {
    throw new Error('not used');
  },
  draftImprovement: async () => {
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
    async runTurn(input: AgentTurnInput) {
      const tools = w.agentTools(input.workspace.projectId);
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
      return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
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
  assert.match(String((seen.bobSendsAlicesDraft as {error: string}).error), /no draft/, "Bob's project has no draft: Alice's draft is not his");
  assert.ok((seen.draftA as {draft: unknown}).draft);
  assert.equal(await api.getAgentLive(ctxOf(alice), a.id), null, 'nothing is live once the turn ended');

  // Alice agrees in a new message; Bob's turn on his project runs in between.
  await Promise.all([api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'alice: yes, send it', page: page()}), api.sendUserMessage(ctxOf(bob), {projectId: b.id, text: 'bob: yes, send it', page: page()})]);
  assert.deepEqual(seen['alice: yes, send it'], {ticketId: 'T-1', note: 'Tell the user the ticket id in one line; the team picks the report up from there.'});
  assert.match(String((seen['bob: yes, send it'] as {error: string}).error), /no draft/);
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].reporter, {id: 'u_alice', name: 'Alice'});
  assert.equal(tickets[0].where.projectId, a.id);
  // The chat of each project holds only its own messages.
  const textsOf = async (ctx: RequestContext, projectId: string) => (await api.chatHistory(ctx, projectId)).filter(m => m.role === 'user').map(m => m.text);
  assert.deepEqual(await textsOf(ctxOf(alice), a.id), ['alice: it broke', 'alice: yes, send it']);
  assert.deepEqual(await textsOf(ctxOf(bob), b.id), ['bob: it broke', 'bob: yes, send it']);
  // With no turn running, a helper's tool still runs (as the helper, with a system context).
  await wf.agentTools(a.id).call({agent: 'prompt_agent', name: 'get_project_summary', args: {}});
});

test("two users in one process: a helper reads a linked document as the person it answers (gap G3)", async () => {
  const readers: string[] = [];
  const {api} = world(
    'wf-docs',
    w => ({
      ...noHelpers(),
      async runTurn(input: AgentTurnInput) {
        await w.agentTools(input.workspace.projectId).call({agent: 'front_desk', name: 'read_doc', args: {url: 'https://docs.example/guide'}});
        return {invocations: [], messages: [], proposal: null, toolCalls: [], modelCalls: [], parseFailures: []};
      },
    }),
    {read: async (ctx, url) => (readers.push(`${ctx.user.name}:${url}`), {title: 'Guide', text: 'Label carefully.'})},
  );
  const a = await api.createProject(ctxOf(alice), 'A');
  const b = await api.createProject(ctxOf(bob), 'B');
  await Promise.all([api.sendUserMessage(ctxOf(alice), {projectId: a.id, text: 'read this', page: page()}), api.sendUserMessage(ctxOf(bob), {projectId: b.id, text: 'read this', page: page()})]);
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

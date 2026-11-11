import type {
  AgentLive,
  AgentPreset,
  AgentProposal,
  AgentTurnOutput,
  AgentTurnProgress,
  AgentWorkspaceSnapshot,
  ChatAttachment,
  ChatMessage,
  PageContext,
  Schema,
  StartRequest,
} from '@tsp/contracts';
import {agentName, exampleBrief, fieldsRight, newId, promptKeys, settingsHash, versionLabel, visibleToAgents, wrongExamples} from '@tsp/domain';
import {loadProjectState} from './projects.ts';
import {emitChange, getApp, now, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {agentTools, getPageView} from './page-views.ts';
import {scoreOnOptimiserHalf} from './evaluation.ts';

export type {PageContext};

const busyProjects = new Set<string>();
export const isAgentBusy = (projectId: string): boolean => busyProjects.has(projectId);

/**
 * The turn running now, per project: who works, the live line and the reply so far. Kept apart
 * from the change feed, so a streaming reply doesn't reload the page's state (HTTP: an SSE stream).
 */
const live = new Map<string, AgentLive>();
const liveListeners = new Set<() => void>();
const setLive = (projectId: string, l: AgentLive | null) => {
  if (l) live.set(projectId, l);
  else live.delete(projectId);
  liveListeners.forEach(fn => fn());
};
export const agentLive = (projectId: string): AgentLive | null => live.get(projectId) ?? null;
export function subscribeAgentLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => void liveListeners.delete(listener);
}

/**
 * A helper that joined to answer keeps answering on that page: the user's next messages there go
 * straight to it, until they write from another page. Kept per project for this session.
 */
const stays = new Map<string, {agent: AgentPreset; page: string}>();
const pageKey = (page: PageContext) => page.where?.page ?? page.label;
/** The page's name in action lines: its label without the version or other detail. */
const pageName = (page: PageContext) => page.label.split(' · ')[0];

/** Which helper answers the next message on this page. */
export function answeringAgent(projectId: string, page: PageContext): AgentPreset {
  const s = stays.get(projectId);
  return s && s.page === pageKey(page) ? s.agent : page.agent;
}

export async function chatHistory(projectId: string): Promise<ChatMessage[]> {
  return getApp().catalog.find('chat_messages', {projectId}, 'createdAt');
}

async function post(projectId: string, m: Omit<ChatMessage, 'id' | 'projectId' | 'createdAt'>): Promise<ChatMessage> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), ...m};
  await getApp().catalog.insert('chat_messages', msg);
  emitChange();
  return msg;
}

async function loadWorkspaceSnapshot(
  projectId: string,
  page: PageContext,
  attachments?: ChatAttachment[],
): Promise<AgentWorkspaceSnapshot> {
  const {catalog, examples} = getApp();
  const project = await catalog.get('projects', projectId);
  const setup = project?.setupVersionId ? await catalog.get('setup_versions', project.setupVersionId) : null;
  const openSchemas = await openProposals(projectId, 'schema');
  const history = await chatHistory(projectId);

  const task = (typeof page.context.task === 'string' && page.context.task) || setup?.task || '';
  const schema =
    (page.context.schema as Schema | null | undefined) ??
    (openSchemas[0]?.payload as Schema | undefined) ??
    setup?.schema ??
    null;

  let attachedExamples = undefined;
  if (attachments?.length) {
    const idCandidates = new Set<string>();
    for (const a of attachments) {
      if (!a.content) continue;
      for (const m of a.content.matchAll(/\b(?:ext_\d+|\d{3,})\b/g)) {
        idCandidates.add(m[0]);
      }
    }
    if (idCandidates.size > 0) {
      const found = await examples.lookup([...idCandidates].slice(0, 10));
      if (found.length > 0) attachedExamples = found;
    }
  }

  // The page's unsaved edits go to the agent as the page's `context`; the view holds saved data.
  // What the page holds that isn't saved (the editor's draft template, ticked features, images) goes
  // into the view's `unsaved` block too, so every helper reads the same workspace (R3-3).
  const {schema: _s, task: _t, ...unsaved} = (page.context ?? {}) as Record<string, unknown>;
  const pageView = await getPageView(projectId, page.where ?? {page: 'projects', params: {}}, unsaved);

  return {
    projectId,
    task,
    schema,
    pageView,
    history: history.map(({role, agent, text, page: p, createdAt}) => ({role, agent, text, page: p, createdAt})),
    attachedExamples,
  };
}

/**
 * BFF dispatcher for assistant turns:
 * 1. Persists the user's message and loads the project's workspace snapshot from the catalog.
 * 2. Calls the stateless Agent Runtime service (`@tsp/agents`) with `AgentTurnInput`, which
 *    includes the view of the page the user is on, and lends it the read tools.
 * 3. Persists start requests, emitted agent/event messages, and any new proposal to the catalog.
 */
export async function sendUserMessage(
  projectId: string,
  text: string,
  page: PageContext,
  attachments?: ChatAttachment[],
  /** A helper the user called by a button: it joins with a line and keeps answering on this page. */
  join?: boolean,
): Promise<AgentProposal | null> {
  busyProjects.add(projectId);
  const started = Date.now();
  const pageId = page.where?.page ?? 'other';
  // Back from another page: the page's own helper answers again, and the chat says so.
  const stay = stays.get(projectId);
  if (stay && stay.page !== pageKey(page)) {
    stays.delete(projectId);
    if (stay.agent !== page.agent) await postEvent(projectId, 'page', page.agent, `answers on ${pageName(page)}`);
  }
  if (join) stays.delete(projectId);
  const turnPage: PageContext = stays.has(projectId) ? {...page, agent: stays.get(projectId)!.agent, intent: 'follow_up'} : page;
  const entry = turnPage.agent;
  setLive(projectId, {agent: entry, working: 'Thinking…', reply: null});
  let outcome = 'error';
  tm().event('chat_message_sent', {entry_agent: entry, chars: text.length, attachments: attachments?.length ?? 0});
  const cleanAttachments = attachments?.map(({name, size, url}) => ({name, size, ...(url ? {url} : {})}));
  await post(projectId, {
    role: 'user',
    agent: null,
    text,
    page: page.label,
    ...(cleanAttachments?.length ? {attachments: cleanAttachments} : {}),
  });
  if (join) await post(projectId, {role: 'event', agent: null, event: 'join', text: `${agentName(page.agent)} joined to answer`, page: page.label});

  try {
    const {catalog, agents, gateway} = getApp();
    const workspace = await loadWorkspaceSnapshot(projectId, turnPage, attachments);
    // Messages are saved the moment they are final; the live line and the streamed reply show
    // what the turn is doing until then.
    let saving = Promise.resolve();
    const progress: AgentTurnProgress = p => {
      if ('message' in p) {
        const msg = p.message;
        saving = saving.then(() =>
          post(projectId, {role: msg.role, agent: msg.agent, text: msg.text, page: page.label, ...(msg.event ? {event: msg.event} : {}), ...(msg.choices ? {choices: msg.choices} : {})}).then(() => undefined),
        );
        setLive(projectId, msg.role === 'agent' ? null : {agent: agentLive(projectId)?.agent ?? entry, working: 'Thinking…', reply: null});
      } else if ('working' in p) setLive(projectId, {agent: p.agent, working: p.working, reply: null});
      else setLive(projectId, {agent: p.agent, working: null, reply: p.reply});
    };
    const turnOut = await agents.runAgentTurn({userText: text, page: turnPage, attachments, workspace}, gateway.agentModel(), agentTools(projectId), progress);
    await saving;
    outcome = 'ok';
    recordTurn(turnOut, entry, started);
    const joined = turnOut.invocations.filter(i => i.from !== 'user').at(-1);
    if (joined) stays.set(projectId, {agent: joined.to, page: pageKey(page)});
    else if (join) stays.set(projectId, {agent: page.agent, page: pageKey(page)});

    for (const inv of turnOut.invocations) {
      const start: StartRequest = {
        id: newId('sr'),
        projectId,
        createdAt: now(),
        from: inv.from,
        to: inv.to,
        intent: inv.intent,
        refs: {},
        userRequest: text,
        note: inv.note,
      };
      await catalog.insert('start_requests', start);
    }

    if (turnOut.proposal) {
      const previousOpen = await openProposals(projectId, turnOut.proposal.kind);
      for (const prev of previousOpen) {
        await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
      }
      const proposal: AgentProposal = {
        id: newId('ap'),
        projectId,
        agent: turnOut.proposal.agent,
        kind: turnOut.proposal.kind,
        payload: turnOut.proposal.payload,
        brief: turnOut.proposal.brief,
        state: 'open',
        createdAt: now(),
      };
      await catalog.insert('agent_proposals', proposal);
      await postEvent(projectId, 'draft', proposal.agent, proposal.kind === 'schema' ? 'put a draft on Schema settings' : `put a draft on ${page.where?.page === 'prompt' && !page.label.startsWith('First') ? 'Edit prompt' : pageName(page)}`, draftLink(proposal.kind, page));
      emitChange();
      return proposal;
    }
    return null;
  } finally {
    busyProjects.delete(projectId);
    setLive(projectId, null);
    tm().counter('tsp_agent_turns_total', {agent: entry, page: pageId, outcome});
    tm().histogram('tsp_agent_turn_duration_seconds', (Date.now() - started) / 1000, {agent: entry});
    emitChange();
  }
}

/** Metrics and events for one answered turn. Only counts and names; never the text. */
function recordTurn(out: AgentTurnOutput, entry: string, started: number) {
  const t = tm();
  for (const c of out.modelCalls) t.counter('tsp_agent_model_calls_total', {agent: c.agent, model: c.model});
  for (const f of out.parseFailures) t.counter('tsp_agent_parse_failures_total', {agent: f.agent, intent: f.intent});
  const handoff = out.invocations.find(i => i.from !== 'user' && i.from !== 'system');
  if (handoff) t.counter('tsp_agent_handoffs_total', {from: handoff.from, to: handoff.to, outcome: 'joined'});
  const last = out.invocations[out.invocations.length - 1]?.to ?? entry;
  t.histogram('tsp_agent_tool_calls_per_turn', out.toolCalls.length, {agent: last});
  for (const c of out.toolCalls) {
    t.counter('tsp_agent_tool_calls_total', {agent: c.agent, tool: c.name, outcome: c.ok ? 'ok' : 'error'});
    t.histogram('tsp_agent_tool_duration_seconds', c.ms / 1000, {tool: c.name});
    t.event('agent_tool_called', {agent: c.agent, tool: c.name, ok: c.ok, ms: c.ms});
  }
  if (out.proposal) {
    t.counter('tsp_agent_proposals_total', {agent: out.proposal.agent, kind: out.proposal.kind, outcome: 'shown'});
    if (out.proposal.kind === 'prompt') t.event('prompt_proposal_shown', {agent: out.proposal.agent});
    else {
      const s = out.proposal.payload as {fields?: {values?: unknown[]}[]};
      t.event('schema_proposal_shown', {agent: out.proposal.agent, fields: s.fields?.length ?? 0, values: (s.fields ?? []).reduce((n, f) => n + (f.values?.length ?? 0), 0), revision: 0});
    }
  }
  t.event('agent_replied', {agent: last, seconds: (Date.now() - started) / 1000, handoff_to: handoff?.to ?? null, tool_calls: out.toolCalls.length, proposal_kind: out.proposal?.kind ?? null});
}

/** Where a draft lands: the schema on Setup, a prompt in the editor (or the first prompt). */
function draftLink(kind: AgentProposal['kind'], page: PageContext) {
  if (kind === 'schema') return {path: '/setup'};
  if (page.where?.page === 'prompt_edit') return {path: '/prompt/edit', params: page.where.params};
  return page.label.startsWith('First') ? {path: '/prompt'} : {path: '/prompt/edit'};
}

export async function openProposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]> {
  return getApp().catalog.find('agent_proposals', {projectId, kind, state: 'open'}, 'createdAt desc');
}

/** Open and approved proposals, oldest first: Ask AI shows each as a card (an approved one as one line). */
export async function proposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]> {
  const all = await getApp().catalog.find('agent_proposals', {projectId, kind}, 'createdAt desc');
  return all.filter(p => p.state !== 'discarded').reverse();
}

export async function closeProposal(p: AgentProposal, state: 'approved' | 'discarded') {
  // Closing twice (two checks racing on the page) changes nothing and is not counted twice.
  const fresh = await getApp().catalog.get('agent_proposals', p.id);
  if (fresh && fresh.state !== 'open') return;
  await getApp().catalog.patch('agent_proposals', p.id, {state});
  // A prompt draft is "approved" when the editor takes it in; the user's own act there is Save.
  if (p.kind === 'schema') await postEvent(p.projectId, state, 'user', `${state} the schema`, {path: '/setup'});
  tm().counter('tsp_agent_proposals_total', {agent: p.agent, kind: p.kind, outcome: state});
  if (p.kind === 'schema' && state === 'discarded') tm().event('schema_discarded', {revision: 0});
  if (p.kind === 'prompt') tm().event(state === 'approved' ? 'prompt_proposal_approved' : 'prompt_proposal_discarded', state === 'approved' ? {agent: p.agent, edited_before_approve: false} : {agent: p.agent});
  emitChange();
}

/**
 * Improve with AI: the Prompt helper drafts a few changes to a version from its mistakes, each
 * with a reason. The draft goes into the editor (an open prompt proposal) with the changes
 * marked; nothing is labeled until the user saves it.
 */
/** How many examples the label check reads. */
export const CHECK_SAMPLE = 20;

/**
 * Dataset's "Check labels" (review finding 10): the Labels helper reads a random sample of the
 * examples against the labels, answers in Ask AI and may put a draft on Schema settings. The
 * held-out half never reaches it.
 */
export async function checkLabels(projectId: string, page: PageContext): Promise<AgentProposal | null> {
  const state = await loadProjectState(projectId);
  if (!state?.setup?.schema) throw new Error('Set the labels first.');
  const pool = state.examples.filter(visibleToAgents);
  const sample = [...pool].sort(() => Math.random() - 0.5).slice(0, CHECK_SAMPLE);
  const examples = sample.map(e => {
    const gold = state.gold.get(e.id)?.answer;
    const {gold: _g, predicted: _p, ...b} = exampleBrief(e, Object.keys(e.features), gold ?? {}, null);
    return gold ? {...b, gold} : b;
  });
  return sendUserMessage(projectId, `Check the labels against ${sample.length} examples of my data`, {...page, agent: 'schema_agent', intent: 'check_schema', context: {...page.context, examples}}, undefined, true);
}

export async function improveWithAi(projectId: string, versionId: string): Promise<void> {
  const {catalog, agents, gateway, labeling} = getApp();
  const state = await loadProjectState(projectId);
  const v = state?.versions.find(x => x.id === versionId);
  const setup = state?.setup;
  if (!state || !v || !setup?.schema) throw new Error('The version was not found.');
  const report = state.reports.find(r => r.promptVersionId === v.id && !r.archivedNow);
  if (!report) throw new Error(`${versionLabel(v)} has no scores yet.`);
  const settings = setup.models.find(m => m.endpoint === report.endpoint);
  const answers = settings ? await labeling.predictions(v.id, report.endpoint, settingsHash(settings)) : new Map();
  const schema = setup.schema;
  // R3-9 (D3) and finding 3: the mistakes, mix-ups and up to 8 wrong examples all come from the
  // optimiser half; nothing of the held-out half reaches the helper.
  const half = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e));
  const mistakes = half.filter(e => state.gold.has(e.id) && fieldsRight(schema, state.gold.get(e.id)!.answer, answers.get(e.id)?.answer ?? null).length < schema.fields.length).length;
  const gold = new Map(half.filter(e => state.gold.has(e.id)).map(e => [e.id, state.gold.get(e.id)!.answer]));
  const examples = wrongExamples(schema, half, promptKeys(v), gold, new Map(half.filter(e => answers.has(e.id)).map(e => [e.id, answers.get(e.id)!.answer])));
  busyProjects.add(projectId);
  setLive(projectId, {agent: 'prompt_agent', working: `Reading the ${versionLabel(v)} mistakes…`, reply: null});
  await postEvent(projectId, 'start', 'user', `asked the Prompt helper to improve ${versionLabel(v)}`, {path: '/prompt'});
  let outcome = 'error';
  try {
    const m = await scoreOnOptimiserHalf(setup, v, report.endpoint, state.examples, state.gold);
    const out = await agents.draftImprovement(
      {version: versionLabel(v), template: v.template, features: v.features, schema, mixUps: m.mixUps.slice(0, 8), lowestField: m.lowestField, lowestValue: m.lowestValue, mistakes, examples},
      gateway.agentModel(),
      agentTools(projectId),
    );
    for (const prev of await openProposals(projectId, 'prompt')) await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
    const change = out.changes.map(c => c.text).join('; ') || 'Improved with AI';
    const proposal: AgentProposal = {
      id: newId('ap'),
      projectId,
      agent: 'prompt_agent',
      kind: 'prompt',
      payload: {template: out.template, features: out.features ?? v.features, change, changes: out.changes, baseVersionId: v.id},
      brief: `Improve ${versionLabel(v)}`,
      state: 'open',
      createdAt: now(),
    };
    await catalog.insert('agent_proposals', proposal);
    // One line: the reasons sit on the marks in the editor, so the chat does not repeat them.
    const n = out.changes.length;
    const text = n ? `I made ${n} change${n === 1 ? '' : 's'} to ${versionLabel(v)}. Hover each mark to see why.` : `I have no new change for ${versionLabel(v)}.`;
    await post(projectId, {role: 'agent', agent: 'prompt_agent', text, page: 'Edit prompt'});
    await postEvent(projectId, 'draft', 'prompt_agent', 'put a draft on Edit prompt', {path: '/prompt/edit', params: {v: v.id}});
    tm().counter('tsp_agent_proposals_total', {agent: 'prompt_agent', kind: 'prompt', outcome: 'shown'});
    tm().event('prompt_proposal_shown', {agent: 'prompt_agent'});
    outcome = 'ok';
  } finally {
    busyProjects.delete(projectId);
    setLive(projectId, null);
    tm().counter('tsp_agent_turns_total', {agent: 'prompt_agent', page: 'prompt', outcome});
    emitChange();
  }
}

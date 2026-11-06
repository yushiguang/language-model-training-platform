import type {
  AgentProposal,
  AgentTurnOutput,
  AgentWorkspaceSnapshot,
  ChatAttachment,
  ChatMessage,
  PageContext,
  Schema,
  StartCard,
  StartRequest,
} from '@tsp/contracts';
import {newId} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {agentTools, getPageView} from './page-views.ts';

export type {PageContext};

const busyProjects = new Set<string>();
export const isAgentBusy = (projectId: string): boolean => busyProjects.has(projectId);

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
  const pageView = await getPageView(projectId, page.where ?? {page: 'projects', params: {}});

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
): Promise<AgentProposal | null> {
  busyProjects.add(projectId);
  const started = Date.now();
  const entry = page.agent;
  const pageId = page.where?.page ?? 'other';
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

  try {
    const {catalog, agents, gateway} = getApp();
    const workspace = await loadWorkspaceSnapshot(projectId, page, attachments);
    const cards: StartCard[] = [];
    const turnOut = await agents.runAgentTurn({userText: text, page, attachments, workspace}, gateway.agentModel(), agentTools(projectId, cards));
    outcome = 'ok';
    recordTurn(turnOut, entry, started);

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

    for (const msg of turnOut.messages) {
      await post(projectId, {
        role: msg.role,
        agent: msg.agent,
        text: msg.text,
        page: page.label,
        ...(msg.choices ? {choices: msg.choices} : {}),
      });
    }
    // A paid start an agent asked for: a card with Approve and Cancel under the agent's reply.
    for (const card of cards) {
      await post(projectId, {role: 'agent', agent: card.agent, text: '', page: page.label, startCard: card});
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
      emitChange();
      return proposal;
    }
    return null;
  } finally {
    busyProjects.delete(projectId);
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
  const handoff = out.invocations.find(i => i.from === 'front_desk');
  if (handoff) t.counter('tsp_agent_handoffs_total', {from: 'front_desk', to: handoff.to, outcome: 'joined'});
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
  tm().counter('tsp_agent_proposals_total', {agent: p.agent, kind: p.kind, outcome: state});
  if (p.kind === 'schema' && state === 'discarded') tm().event('schema_discarded', {revision: 0});
  if (p.kind === 'prompt') tm().event(state === 'approved' ? 'prompt_proposal_approved' : 'prompt_proposal_discarded', state === 'approved' ? {agent: p.agent, edited_before_approve: false} : {agent: p.agent});
  emitChange();
}

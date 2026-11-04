import type {
  AgentProposal,
  AgentWorkspaceSnapshot,
  ChatAttachment,
  ChatMessage,
  PageContext,
  Schema,
  StartRequest,
} from '@tsp/contracts';
import {newId} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';

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

  return {
    projectId,
    task,
    schema,
    history: history.map(({role, agent, text, page: p, createdAt}) => ({role, agent, text, page: p, createdAt})),
    attachedExamples,
  };
}

/**
 * BFF dispatcher for assistant turns:
 * 1. Persists the user's message and loads the project's workspace snapshot from the catalog.
 * 2. Calls the stateless Agent Runtime service (`@tsp/agents`) with `AgentTurnInput`.
 * 3. Persists start requests, emitted agent/event messages, and any new proposal to the catalog.
 */
export async function sendUserMessage(
  projectId: string,
  text: string,
  page: PageContext,
  attachments?: ChatAttachment[],
): Promise<AgentProposal | null> {
  busyProjects.add(projectId);
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
    const turnOut = await agents.runAgentTurn({userText: text, page, attachments, workspace}, gateway.agentModel());

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
    emitChange();
  }
}

export async function openProposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]> {
  return getApp().catalog.find('agent_proposals', {projectId, kind, state: 'open'}, 'createdAt desc');
}

export async function closeProposal(p: AgentProposal, state: 'approved' | 'discarded') {
  await getApp().catalog.patch('agent_proposals', p.id, {state});
  emitChange();
}

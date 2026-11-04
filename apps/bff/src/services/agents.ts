import {runAgentTurn} from '../../../agents/src/runtime';
import type {AgentWorkspaceSnapshot} from '../../../../packages/contracts/src/agent-api';
import type {
  AgentProposal,
  ChatAttachment,
  ChatMessage,
  PageContext,
  Project,
  Schema,
  SetupVersion,
  StartRequest,
} from '../../../../packages/contracts/src/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';

export type {PageContext};

const busyProjects = new Set<string>();
export const isAgentBusy = (projectId: string): boolean => busyProjects.has(projectId);

export async function chatHistory(projectId: string): Promise<ChatMessage[]> {
  return getApp().repo.find<ChatMessage>('chat_messages', {project_id: projectId}, 'created_at');
}

async function post(projectId: string, m: Omit<ChatMessage, 'id' | 'projectId' | 'createdAt'>): Promise<ChatMessage> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), ...m};
  await getApp().repo.insert('chat_messages', msg);
  emitChange();
  return msg;
}

async function loadWorkspaceSnapshot(
  projectId: string,
  page: PageContext,
  attachments?: ChatAttachment[],
): Promise<AgentWorkspaceSnapshot> {
  const {repo, platform} = getApp();
  const project = await repo.get<Project>('projects', projectId);
  const setup = project?.setupVersionId ? await repo.get<SetupVersion>('setup_versions', project.setupVersionId) : null;
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
      const found = await platform.examples.lookup([...idCandidates].slice(0, 10));
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
 * 1. Persists the user's message and loads the project's workspace snapshot from `Repo`.
 * 2. Calls the stateless Agent Runtime service (`@tsp/agents`) with `AgentTurnInput`.
 * 3. Persists start requests, emitted agent/event messages, and any new proposal back to `Repo`.
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
    const {repo, platform} = getApp();
    const workspace = await loadWorkspaceSnapshot(projectId, page, attachments);
    const turnOut = await runAgentTurn({userText: text, page, attachments, workspace}, platform.agent);

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
      await repo.insert('start_requests', start);
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
        await repo.update('agent_proposals', {...prev, state: 'discarded'});
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
      await repo.insert('agent_proposals', proposal);
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
  return getApp().repo.find<AgentProposal>('agent_proposals', {project_id: projectId, kind, state: 'open'}, 'created_at desc');
}

export async function closeProposal(p: AgentProposal, state: 'approved' | 'discarded') {
  await getApp().repo.update('agent_proposals', {...p, state});
  emitChange();
}

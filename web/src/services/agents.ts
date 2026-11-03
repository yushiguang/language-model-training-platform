import type {AgentPreset, AgentProposal, ChatMessage, FeatureSelection, Schema, StartRequest} from '../core/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {agentName, PRESETS, systemPrompt} from './agentPresets';

export interface PageContext {
  /** Shown as "On this page: …". */
  label: string;
  /** Which agent answers first on this page. */
  agent: AgentPreset;
  /** The intent the page's agent gets for a plain message. */
  intent: string;
  hint?: string;
  /** IDs and small facts the agent may read. */
  context: Record<string, unknown>;
}

export async function chatHistory(projectId: string): Promise<ChatMessage[]> {
  return getApp().repo.find<ChatMessage>('chat_messages', {project_id: projectId}, 'created_at');
}

async function post(projectId: string, m: Omit<ChatMessage, 'id' | 'projectId' | 'createdAt'>): Promise<ChatMessage> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), ...m};
  await getApp().repo.insert('chat_messages', msg);
  emitChange();
  return msg;
}

export const postAgentMessage = (projectId: string, agent: AgentPreset, text: string, page: string, choices?: string[]) => post(projectId, {role: 'agent', agent, text, page, choices});
export const postEvent = (projectId: string, text: string, page: string) => post(projectId, {role: 'event', agent: null, text, page});

/** Calls one agent preset with a structured start request. Handoffs and cold starts use the same path. */
export async function callAgent<T = Record<string, unknown>>(projectId: string, req: Omit<StartRequest, 'id' | 'projectId' | 'createdAt'>, page: PageContext): Promise<T & {reply?: string}> {
  const {repo, platform} = getApp();
  const start: StartRequest = {id: newId('sr'), projectId, createdAt: now(), ...req};
  await repo.insert('start_requests', start);
  const body = {preset: req.to, intent: req.intent, page: page.label, userText: req.userRequest, context: {...page.context, pageHint: page.hint, refs: req.refs}};
  const raw = await platform.agent.chat(
    [
      {role: 'system', content: `${systemPrompt(req.to)}\nAnswer shape for "${req.intent}": ${PRESETS[req.to].intents[req.intent] ?? '{"reply": string}'}`},
      {role: 'user', content: JSON.stringify(body)},
    ],
    {json: true},
  );
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return {reply: raw} as T & {reply: string};
  }
}

/**
 * A user message in the assistant panel. The page's agent answers; the front desk may hand
 * off to a specialist, who joins the chat. Proposals land on the owning page with Approve.
 */
export async function sendUserMessage(projectId: string, text: string, page: PageContext, onProposal?: (p: AgentProposal) => void): Promise<void> {
  await post(projectId, {role: 'user', agent: null, text, page: page.label});
  let agent = page.agent;
  let intent = page.intent;
  let out = await callAgent<{handoff?: {to: AgentPreset; intent: string}; schema?: Schema; template?: string; features?: FeatureSelection; change?: string}>(projectId, {from: 'user', to: agent, intent, refs: {}, userRequest: text, note: ''}, page);
  if (out.handoff && agent === 'front_desk') {
    if (out.reply) await postAgentMessage(projectId, agent, out.reply, page.label);
    agent = out.handoff.to;
    intent = out.handoff.intent;
    await postEvent(projectId, `${agentName(agent)} joined`, page.label);
    out = await callAgent(projectId, {from: 'front_desk', to: agent, intent, refs: {}, userRequest: text, note: 'Handed off by the front desk'}, page);
  }
  if (out.reply) await postAgentMessage(projectId, agent, out.reply, page.label);
  const kind = out.schema ? 'schema' : out.template ? 'prompt' : null;
  if (kind) {
    const proposal: AgentProposal = {id: newId('ap'), projectId, agent, kind, payload: kind === 'schema' ? out.schema : {template: out.template, features: out.features, change: out.change}, brief: text, state: 'open', createdAt: now()};
    await getApp().repo.insert('agent_proposals', proposal);
    emitChange();
    onProposal?.(proposal);
  }
}

export async function openProposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]> {
  return getApp().repo.find<AgentProposal>('agent_proposals', {project_id: projectId, kind, state: 'open'}, 'created_at desc');
}

export async function closeProposal(p: AgentProposal, state: 'approved' | 'discarded') {
  await getApp().repo.update('agent_proposals', {...p, state});
  emitChange();
}

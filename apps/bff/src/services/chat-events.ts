import type {AgentPreset, ChatEvent, ChatLink, ChatMessage} from '@tsp/contracts';
import {agentName, newId} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';

/** Who an action line names: a helper, the user, or the workflow (work started by code). */
export type EventActor = AgentPreset | 'user' | 'workflow';

const who = (a: EventActor) => (a === 'user' ? 'You' : a === 'workflow' ? 'Workflow' : agentName(a));

/**
 * Saves a grey action line in the project's Ask AI conversation (design: "Agents, motion and
 * states"): "<who> <did what>", with the time and, when there is a place to go, a link to it.
 * Lines are saved like messages, so they stay after a reload and the helpers read them too.
 */
export async function postEvent(projectId: string, event: ChatEvent, actor: EventActor, what: string, link?: ChatLink): Promise<void> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), role: 'event', agent: null, event, text: `${who(actor)} ${what}`, page: '', ...(link ? {link} : {})};
  await getApp().catalog.insert('chat_messages', msg);
  emitChange();
}

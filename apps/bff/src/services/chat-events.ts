import type {AgentPreset, ChatEvent, ChatLink, ChatMessage, Msg} from '@tsp/contracts';
import {agentName, msg, msgText, newId} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';

/** Who an action line names: a helper, the user, or the workflow (work started by code). */
export type EventActor = AgentPreset | 'user' | 'workflow';

const who = (a: EventActor) => (a === 'user' ? 'You' : a === 'workflow' ? 'Workflow' : agentName(a));

/**
 * Saves a grey action line in the project's Ask AI conversation (design: "Agents, motion and
 * states"): "<who> <did what>", with the time and, when there is a place to go, a link to it.
 * Lines are saved like messages, so they stay after a reload and the helpers read them too.
 * `what` is a catalog key with params (spec 1.1.0, 2.3), so the line can be shown in any language.
 */
export async function postEvent(projectId: string, event: ChatEvent, actor: EventActor, what: string | Msg, link?: ChatLink): Promise<void> {
  const w = typeof what === 'string' ? msg(what) : what;
  const line = msg(`{who} ${w.key}`, {...w.params, who: who(actor)});
  const m: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), role: 'event', agent: null, event, text: msgText(line), msg: line, page: '', ...(link ? {link} : {})};
  await getApp().catalog.insert('chat_messages', m);
  emitChange();
}

/** "<helper> joined to answer", as a line any language can show. */
export const joinedMsg = (agent: AgentPreset): Msg => msg('{who} joined to answer', {who: agentName(agent)});

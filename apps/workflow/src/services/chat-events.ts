import type {AgentPreset, ChatEvent, ChatLink, ChatMessage, Msg} from '@sprint/contracts';
import {agentName, msg, msgText, newId} from '@sprint/domain';
import {now, type Scope} from './app.ts';

/** Who an action line names: a helper, the user, or the workflow (work started by code). */
export type EventActor = AgentPreset | 'user' | 'workflow';

const who = (a: EventActor) => (a === 'user' ? 'You' : a === 'workflow' ? 'Workflow' : agentName(a));

/**
 * Saves a grey action line in the project's Ask AI conversation (design: "Agents, motion and
 * states"): "<who> <did what>", with the time and, when there is a place to go, a link to it.
 * Lines are saved like messages, so they stay after a reload and the helpers read them too.
 * `what` is a catalog key with params (spec 1.1.0, 2.3), so the line can be shown in any language.
 */
export async function postEvent(w: Scope, projectId: string, event: ChatEvent, actor: EventActor, what: string | Msg, link?: ChatLink): Promise<void> {
  const said = typeof what === 'string' ? msg(what) : what;
  const line = msg(`{who} ${said.key}`, {...said.params, who: who(actor)});
  const m: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), role: 'event', agent: null, event, text: msgText(line), msg: line, page: '', ...(link ? {link} : {})};
  await w.catalog.insert('chat_messages', m);
  w.emitChange();
}

/** "<helper> joined to answer", as a line any language can show. */
export const joinedMsg = (agent: AgentPreset): Msg => msg('{who} joined to answer', {who: agentName(agent)});

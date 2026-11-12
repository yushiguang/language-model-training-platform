'use client';

import Link from 'next/link';
import {Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {AgentPreset, ChatEvent, ChatMessage, PageContext} from '@tsp/contracts';
import {agentName, pageFromPath} from '@tsp/domain';
import {agentLive, answeringAgent, chatHistory, isAgentBusy, sendUserMessage, subscribeAgentLive, subscribeChanges} from '@/backend-api';
import {Badge, dateTime, Icon, LinkChip} from '@/ui';
import {useProject} from './ProjectContext';

/** A document link pasted into the chat, shown as a chip (the text still goes to the agent as-is). */
const DOC_LINK = /https?:\/\/[^\s]+\/(?:docx|docs|wiki)\/[^\s]+/gi;

/**
 * Ask AI (design: "Ask AI panel", "Agents, motion and states"): the only way users give the
 * helpers anything, as text or document links. One conversation per project; the helper reads the
 * page it is opened on. Each answer names its helper; grey action lines record what helpers, the
 * workflow and the user did; while a turn runs, a live line says what the helper is doing and
 * then its reply streams in.
 */
export function AskAi({
  page,
  onClose,
  extra,
  chips,
  placeholder = 'Ask about this page',
  first,
  onSend,
}: {
  page: PageContext;
  onClose: () => void;
  /** Cards the page adds after the messages (a schema draft waiting for Approve). */
  extra?: ReactNode;
  chips?: string[];
  placeholder?: string;
  /** The opening line of the page's helper, shown first. */
  first?: string;
  /** Runs before the message goes to the agent (Setup saves the first message as the task). */
  onSend?: (text: string) => Promise<void>;
}) {
  const {projectId, state} = useProject();
  const [messages, setMessages] = useState<ChatMessage[]>(() => seen.get(projectId) ?? []);
  const [busy, setBusy] = useState(false);
  const liveTurn = useSyncExternalStore(
    subscribeAgentLive,
    () => agentLive(projectId),
    () => null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      chatHistory(projectId).then(m => {
        seen.set(projectId, m);
        setMessages(m);
      });
      setBusy(isAgentBusy(projectId));
    };
    load();
    return subscribeChanges(load);
  }, [projectId]);
  useEffect(() => {
    bodyRef.current?.scrollTo({top: bodyRef.current.scrollHeight});
  }, [messages.length, busy, !!extra, liveTurn?.working, liveTurn?.reply?.length]);

  const send = async (text: string) => {
    setBusy(true);
    try {
      await onSend?.(text);
      // The agent sees the page through the backend's page view; the page only says where it is.
      const params = Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => k !== 'p'));
      await sendUserMessage({projectId, text, page: {...page, where: {page: pageFromPath(location.pathname), params}}});
    } finally {
      setBusy(isAgentBusy(projectId));
    }
  };
  const last = [...messages].reverse().find(m => m.role === 'agent');
  const follow = chips ?? (last?.choices?.length ? last.choices : []);
  const where = {...page, where: {page: pageFromPath(typeof location === 'undefined' ? '/' : location.pathname), params: {}}};
  const answering = liveTurn?.agent ?? answeringAgent(projectId, where);
  // The newest start line of work that is still running spins (R2-5): scoring and the Optimiser
  // on Prompt versions, the test set's answers on Gold Labels, the training set.
  const active = new Set<string>();
  if (state) {
    const busy: Record<string, boolean> = {
      '/prompt': state.runs.some(r => r.state === 'running') || state.optimisation.some(o => o.state === 'running'),
      '/gold': state.testRuns.some(r => r.state === 'running'),
      '/training-set': state.trainingSets.some(t => t.state === 'running'),
    };
    const done = new Set<string>();
    for (const m of [...messages].reverse()) {
      if (m.role !== 'event' || (m.event !== 'start' && m.event !== 'auto') || !m.link) continue;
      const path = m.link.path;
      if (done.has(path)) continue;
      done.add(path);
      if (busy[path]) active.add(m.id);
    }
  }
  const working = busy || !!liveTurn;

  return (
    <aside className="chat" aria-label="Ask AI">
      <div className="chat-h">
        <div className="chat-h-row">
          <Icon name="spark" />
          <b>Ask AI</b>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ctx-row">
          <span className="ctx">
            <Icon name="eye" />
            {page.label}
          </span>
          <span className="chat-who">{agentName(answering)} answers</span>
        </div>
      </div>
      <div className="chat-m" ref={bodyRef} aria-live="polite">
        {first ? <AgentText who={page.agent} text={first} /> : messages.length === 0 && <AgentText who={page.agent} text={page.hint ?? 'Ask me anything about this page.'} />}
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {dayOf(m.createdAt) !== dayOf(messages[i - 1]?.createdAt ?? (i === 0 ? new Date().toISOString() : m.createdAt)) && <div className="day">{dayOf(m.createdAt)}</div>}
            <Message m={m} active={active.has(m.id)} />
          </Fragment>
        ))}
        {extra}
        {liveTurn?.reply ? (
          <AgentText who={liveTurn.agent} text={liveTurn.reply} streaming />
        ) : (
          working && (
            <div className="live" role="status">
              <Icon name="ring" />
              <span>{liveTurn?.working ?? 'Thinking…'}</span>
            </div>
          )
        )}
      </div>
      {follow.length > 0 && (
        <div className="chips">
          {follow.map(c => (
            <button key={c} type="button" className="chip" disabled={working} onClick={() => void send(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <Composer onSend={send} disabled={working} placeholder={placeholder} />
      <div className="chat-note">Helpers read your recent messages</div>
    </aside>
  );
}

/** The last history read per project, so Ask AI opens on a new step without an empty flash. */
const seen = new Map<string, ChatMessage[]>();

/** "2026.11.09" for a date line; a new line starts each day the chat goes on. */
const dayOf = (iso: string) => dateTime(iso).slice(0, 10);

function AgentText({who, text, streaming}: {who: AgentPreset | null; text: string; streaming?: boolean}) {
  return (
    <div className="msg-a">
      <span className="agent-k">
        <Icon name="spark" />
        <b>{agentName(who ?? 'front_desk')}</b>
      </span>
      <p style={{whiteSpace: 'pre-line'}}>
        {text}
        {streaming && <span className="caret" aria-hidden="true" />}
      </p>
    </div>
  );
}

const EVENT_ICON: Record<ChatEvent, string> = {join: 'next', page: 'next', draft: 'spark', approved: 'check', discarded: 'x', start: 'play', auto: 'ring', stop: 'x'};

/** A saved action line: who did what, and when; with a place to go, the whole line is the link. */
function EventLine({m, active}: {m: ChatMessage; active?: boolean}) {
  const {href} = useProject();
  const inner = (
    <>
      <Icon name={active ? 'ring' : EVENT_ICON[m.event ?? 'join']} />
      <span className="one" title={m.text}>
        {m.text}
      </span>
      <time dateTime={m.createdAt}>{dateTime(m.createdAt).slice(11)}</time>
    </>
  );
  return m.link ? (
    <Link className={active ? 'evt run' : 'evt'} href={href(m.link.path, m.link.params)}>
      {inner}
    </Link>
  ) : (
    <div className={active ? 'evt run' : 'evt'}>{inner}</div>
  );
}

/** The user's text with each document link shown as a chip. */
function UserText({text}: {text: string}) {
  const links = text.match(DOC_LINK) ?? [];
  const rest = text.replace(DOC_LINK, '').trim();
  return (
    <div className="msg-u">
      {rest}
      {links.map((l, i) => (
        <span key={i} style={{display: 'block'}}>
          <LinkChip text={docTitle(l)} />
        </span>
      ))}
    </div>
  );
}
const docTitle = (url: string) => {
  const tail = decodeURIComponent(url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '');
  return /^[A-Za-z0-9]{12,}$/.test(tail) ? 'Document' : tail.replace(/[-_]+/g, ' ');
};

function Message({m, active}: {m: ChatMessage; active?: boolean}) {
  if (m.role === 'user') return <UserText text={m.text} />;
  if (m.role === 'event') return <EventLine m={m} active={active} />;
  return m.text ? <AgentText who={m.agent} text={m.text} /> : null;
}

export function ApprovedCard({title}: {title: string}) {
  return (
    <section className="card ai approved">
      <div className="row" style={{gap: 12}}>
        <span className="agent-t one grow" title={title}>
          {title}
        </span>
        <Badge text="Approved" tone="ok" />
      </div>
    </section>
  );
}

function Composer({onSend, disabled, placeholder}: {onSend: (text: string) => void | Promise<void>; disabled?: boolean; placeholder: string}) {
  const [text, setText] = useState('');
  const ready = text.trim().length > 0 && !disabled;
  // Enter adds a new line; only the send button sends. The box grows up to 6 lines, then scrolls.
  const box = useRef<HTMLTextAreaElement | null>(null);
  const grow = (el: HTMLTextAreaElement | null) => {
    box.current = el;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => grow(box.current), [text]);
  const submit = () => {
    if (!ready) return;
    const t = text.trim();
    setText('');
    void onSend(t);
  };
  return (
    <div className="chat-in">
      <label className="sr-only" htmlFor="chat-input">
        Message Ask AI
      </label>
      <textarea
        id="chat-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={e => setText(e.target.value)}
        ref={grow}
      />
      <button type="button" className="send" aria-label="Send" aria-disabled={!ready} onClick={submit}>
        <Icon name="up" />
      </button>
    </div>
  );
}

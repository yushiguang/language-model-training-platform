'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {ChatMessage, PageContext} from '@tsp/contracts';
import {pageFromPath} from '@tsp/domain';
import {chatHistory, isAgentBusy, sendUserMessage, subscribeChanges} from '@/backend-api';
import {Badge, Button, Icon, LinkChip, Suggestion} from '@/ui';
import {useProject} from './ProjectContext';

/** A document link pasted into the chat, shown as a chip (the text still goes to the agent as-is). */
const DOC_LINK = /https?:\/\/[^\s]+\/(?:docx|docs|wiki)\/[^\s]+/gi;

/**
 * Ask AI (design: "Ask AI panel"): the only way users give the agents anything, as text or
 * document links. One conversation per project; the agent reads the page it is opened on.
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
  /** The agent's opening line, shown first. */
  first?: string;
  /** Runs before the message goes to the agent (Setup saves the first message as the task). */
  onSend?: (text: string) => Promise<void>;
}) {
  const {projectId} = useProject();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      chatHistory(projectId).then(setMessages);
      setBusy(isAgentBusy(projectId));
    };
    load();
    return subscribeChanges(load);
  }, [projectId]);
  useEffect(() => {
    bodyRef.current?.scrollTo({top: bodyRef.current.scrollHeight});
  }, [messages.length, busy, !!extra]);

  const send = async (text: string) => {
    setBusy(true);
    try {
      await onSend?.(text);
      // The agent sees the page through the backend's page view; the page only says where it is.
      const params = Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => k !== 'p'));
      await sendUserMessage(projectId, text, {...page, where: {page: pageFromPath(location.pathname), params}});
    } finally {
      setBusy(isAgentBusy(projectId));
    }
  };
  const last = [...messages].reverse().find(m => m.role === 'agent');
  const follow = chips ?? (last?.choices?.length ? last.choices : []);

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
        <span className="ctx">
          <Icon name="eye" />
          {page.label}
        </span>
      </div>
      <div className="chat-m" ref={bodyRef}>
        {first ? <AgentText text={first} /> : messages.length === 0 && <AgentText text={page.hint ?? 'Ask me anything about this page.'} />}
        {messages.map(m => (
          <Message key={m.id} m={m} />
        ))}
        {extra}
        {busy && <span className="t-3">Thinking…</span>}
      </div>
      {follow.length > 0 && (
        <div className="chips">
          {follow.map(c => (
            <button key={c} type="button" className="chip" onClick={() => void send(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <Composer onSend={send} disabled={busy} placeholder={placeholder} />
    </aside>
  );
}

function AgentText({text}: {text: string}) {
  return (
    <div className="msg-a">
      <span className="agent-k">
        <Icon name="spark" />
        AI
      </span>
      <p style={{whiteSpace: 'pre-line'}}>{text}</p>
    </div>
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

function Message({m}: {m: ChatMessage}) {
  if (m.role === 'user') return <UserText text={m.text} />;
  if (m.role === 'event') return <span className="t-3" style={{fontSize: 13}}>{m.text}</span>;
  return m.text ? <AgentText text={m.text} /> : null;
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
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" className="send" aria-label="Send" aria-disabled={!ready} onClick={submit}>
        <Icon name="up" />
      </button>
    </div>
  );
}

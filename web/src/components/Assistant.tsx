'use client';

import {useEffect, useRef, useState} from 'react';
import type {ChatMessage} from '@/core/types';
import {onChange} from '@/services/app';
import {chatHistory, sendUserMessage, type PageContext} from '@/services/agents';
import {agentName} from '@/services/agentPresets';
import {Icon} from '@/ui';
import {useProject} from './ProjectContext';

/** The assistant panel: one chat per project, answered by the page's agent. */
export function Assistant({page, onMinimise, placeholder = 'Message the assistant'}: {page: PageContext; onMinimise?: () => void; placeholder?: string}) {
  const {projectId} = useProject();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      chatHistory(projectId).then(setMessages);
    };
    load();
    return onChange(load);
  }, [projectId]);
  useEffect(() => {
    bodyRef.current?.scrollTo({top: bodyRef.current.scrollHeight});
  }, [messages.length, busy]);

  const send = async (text: string) => {
    setBusy(true);
    try {
      await sendUserMessage(projectId, text, page);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="aside" aria-label="Assistant">
      <div className="aside-head">
        <Icon name="sparkle" />
        <span style={{fontWeight: 600}}>Assistant</span>
        {onMinimise && (
          <button className="copy right" style={{visibility: 'visible', width: 32, height: 32}} aria-label="Minimise assistant" title="Minimise" onClick={onMinimise}>
            <Icon name="minimise" />
          </button>
        )}
      </div>
      <div className="aside-body" ref={bodyRef}>
        {messages.length === 0 && <AgentLine name={agentName(page.agent)} text={page.hint ? `Ask me anything about this page. ${page.hint}` : 'Ask me anything about this page.'} />}
        {messages.map(m => <Message key={m.id} m={m} onChoice={send} />)}
        {busy && <span className="typing">Thinking…</span>}
      </div>
      <div className="aside-foot">
        <span className="small muted">On this page: {page.label}</span>
        <Composer onSend={send} disabled={busy} placeholder={placeholder} />
      </div>
    </aside>
  );
}

function AgentLine({name, text}: {name: string; text: string}) {
  return (
    <div className="agent-msg">
      <span className="agent-name">{name}</span>
      <span>{text}</span>
    </div>
  );
}

function Message({m, onChoice}: {m: ChatMessage; onChoice: (t: string) => void}) {
  if (m.role === 'user') return <div className="bubble-user">{m.text}</div>;
  if (m.role === 'event') return <div className="event">{m.text}</div>;
  return (
    <div className="agent-msg">
      <span className="agent-name">{m.agent ? agentName(m.agent) : 'Assistant'}</span>
      <span>{m.text}</span>
      {m.choices && (
        <div className="row" style={{gap: 6}}>
          {m.choices.map(c => (
            <button key={c} className="opt" style={{border: '1px solid var(--line-2)'}} onClick={() => onChoice(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Composer({onSend, disabled, placeholder, hero}: {onSend: (t: string) => void | Promise<void>; disabled?: boolean; placeholder: string; hero?: boolean}) {
  const [text, setText] = useState('');
  const ready = text.trim().length > 0 && !disabled;
  const submit = () => {
    if (!ready) return;
    const t = text.trim();
    setText('');
    void onSend(t);
  };
  return (
    <div className="composer">
      <label className="sr-only" htmlFor={hero ? 'hero-input' : 'chat-input'}>
        Message the assistant
      </label>
      <textarea
        id={hero ? 'hero-input' : 'chat-input'}
        rows={hero ? 3 : 2}
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
      <button className={`send${ready ? ' on' : ''}`} aria-label="Send" aria-disabled={!ready} onClick={submit}>
        <Icon name="send" />
      </button>
    </div>
  );
}

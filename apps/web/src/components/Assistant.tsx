'use client';

import {useEffect, useRef, useState} from 'react';
import type {ChatAttachment, ChatMessage, PageContext} from '@tsp/contracts';
import {agentName} from '@tsp/domain';
import {chatHistory, isAgentBusy, prepareChatAttachment, sendUserMessage, subscribeChanges} from '@/backend-api';
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
      setBusy(isAgentBusy(projectId));
    };
    load();
    return subscribeChanges(load);
  }, [projectId]);
  useEffect(() => {
    bodyRef.current?.scrollTo({top: bodyRef.current.scrollHeight});
  }, [messages.length, busy]);

  const send = async (text: string, attachments?: ChatAttachment[]) => {
    setBusy(true);
    try {
      await sendUserMessage(projectId, text, page, attachments);
    } finally {
      setBusy(isAgentBusy(projectId));
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
        {messages.map(m => <Message key={m.id} m={m} onChoice={t => void send(t)} />)}
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
  if (m.role === 'user') {
    return (
      <div className="bubble-user">
        {m.text && <div>{m.text}</div>}
        {m.attachments && m.attachments.length > 0 && (
          <div className="attach-list" style={{marginTop: m.text ? 6 : 0}}>
            {m.attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} className="attach-chip">
                {a.url ? <img src={a.url} alt="" className="attach-thumb" /> : <Icon name="paperclip" size={12} />}
                <span>{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
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

export function Composer({
  onSend,
  disabled,
  placeholder,
  hero,
}: {
  onSend: (text: string, attachments?: ChatAttachment[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder: string;
  hero?: boolean;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const ready = (text.trim().length > 0 || attachments.length > 0) && !disabled && !uploading;

  const addFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const prepared = await Promise.all(Array.from(files).map(f => prepareChatAttachment(f)));
      setAttachments(prev => [...prev, ...prepared]);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const submit = () => {
    if (!ready) return;
    const t = text.trim() || (attachments.length ? `Attached ${attachments.map(a => a.name).join(', ')}` : '');
    const attached = attachments.length ? attachments : undefined;
    setText('');
    setAttachments([]);
    void onSend(t, attached);
  };

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attach-list" style={{padding: '8px 10px 0'}}>
          {attachments.map((a, idx) => (
            <span key={`${a.name}-${idx}`} className="attach-chip">
              {a.url ? <img src={a.url} alt="" className="attach-thumb" /> : <Icon name="paperclip" size={12} />}
              <span>{a.name}</span>
              <button
                type="button"
                className="attach-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => removeAttachment(idx)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
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
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".csv,.jsonl,.json,.txt,.md,image/*"
        className="sr-only"
        onChange={e => void addFiles(e.target.files)}
      />
      <button
        type="button"
        className="attach-btn"
        aria-label="Attach file"
        title="Attach file (CSV, JSONL, text, or image)"
        disabled={disabled || uploading}
        onClick={() => fileRef.current?.click()}
      >
        <Icon name="paperclip" size={15} />
      </button>
      <button type="button" className={`send${ready ? ' on' : ''}`} aria-label="Send" aria-disabled={!ready} onClick={submit}>
        <Icon name="send" />
      </button>
    </div>
  );
}

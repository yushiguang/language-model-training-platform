'use client';

import {useEffect, useRef, useState} from 'react';
import {ChatComposer, ChatComposerDrawer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage, ChatToolCalls} from '@astryxdesign/core/Chat';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Markdown} from '@astryxdesign/core/Markdown';
import {ArrowUp, FileText, Paperclip, Sparkles, X} from 'lucide-react';
import {AgentMark} from '@/components/AgentMark';
import {ArtifactCard} from '@/components/ArtifactCard';
import {AgentCard} from '@/components/cards/AgentCard';
import {isTrainCommand, TrainWarning, TRAIN_COMMAND, useTraining} from '@/components/training';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {CARDS, choiceLabel, useStory} from '@/story/StoryProvider';
import type {ModelSummary} from '@/story/models';
import type {Card, Item} from '@/story/types';

type NextCard = Extract<Card, {type: 'next'}>;

/** A file the user attached, as it appears in the chat. */
function FileCard({name, size, detail}: {name: string; size: string; detail?: T}) {
  const {tr} = useLocale();
  return (
    <div className="file-card">
      <span className="file-tile" aria-hidden>
        <Icon icon={FileText} size="md" color="inherit" />
      </span>
      <span className="file-text">
        <span className="file-name">{name}</span>
        <span className="file-meta">
          {size}
          {detail ? ` · ${tr(detail)}` : ''}
        </span>
      </span>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The agent's suggested next steps, if the latest ones are still open: nothing the user said came after them. */
function openSuggestions(items: Item[], isOpen: (card: NextCard) => boolean): NextCard | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user' || item.kind === 'choice' || item.kind === 'file') return null;
    if (item.kind === 'card' && item.card.type === 'next') return isOpen(item.card) ? item.card : null;
  }
  return null;
}

const FILE_REPLY = t(
  'Got your file. In the product I’d check it against the schema, show you what I found, and add it to the dataset. This demo keeps its script, so I’ll leave it here.',
  '收到文件。在正式产品里，我会用 Schema 校验它，告诉你发现了什么，再把它加入数据集。演示按脚本进行，所以先放在这里。',
);
const READ_ONLY_REPLY = t('This model’s history is read-only in the demo. Only /train and the suggestions work here.', '演示中这个模型的记录是只读的，这里只能使用 /train 和建议。');

function UserMessage({children}: {children: React.ReactNode}) {
  return (
    <ChatMessage sender="user">
      <ChatMessageBubble className="user-bubble">{children}</ChatMessageBubble>
    </ChatMessage>
  );
}

/** The agent writes across the whole column, without a bubble, as Claude does. */
function AgentMessage({children}: {children: React.ReactNode}) {
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost" width="100%" className="agent-bubble">
        {children}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function ItemView({item, isReadOnly}: {item: Item; isReadOnly: boolean}) {
  const {tr} = useLocale();
  const {state} = useStory();

  switch (item.kind) {
    case 'user':
      return <UserMessage>{tr(item.text)}</UserMessage>;
    case 'file':
      return (
        <ChatMessage sender="user">
          <FileCard name={item.name} size={item.size} detail={item.detail} />
        </ChatMessage>
      );
    case 'choice': {
      const card = CARDS[item.cardId];
      const choice = state.choices[item.cardId];
      const label = choice ? choiceLabel(card, choice) : null;
      return label ? <UserMessage>{tr(label)}</UserMessage> : null;
    }
    case 'agent':
      return (
        <ChatMessage sender="assistant">
          {item.tools && (
            <ChatToolCalls
              calls={item.tools.map(tool => ({
                name: tool.name,
                target: tr(tool.target),
                duration: tool.duration,
                status: 'complete',
              }))}
            />
          )}
          <ChatMessageBubble variant="ghost" width="100%" className="agent-bubble">
            <Markdown density="compact">{tr(item.text)}</Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      );
    case 'reply': {
      const choice = state.choices[item.cardId];
      const text = choice ? item.replies[choice] : undefined;
      if (!text) return null;
      return (
        <AgentMessage>
          <Markdown density="compact">{tr(text)}</Markdown>
        </AgentMessage>
      );
    }
    case 'system':
      return <ChatSystemMessage variant="divider">{tr(item.text)}</ChatSystemMessage>;
    case 'artifact':
      return (
        <AgentMessage>
          <ArtifactCard item={item} />
        </AgentMessage>
      );
    case 'card':
      if (item.card.type === 'next') return null;
      return (
        <AgentMessage>
          <AgentCard card={item.card} isReadOnly={isReadOnly} />
        </AgentMessage>
      );
  }
}

export function Conversation({model}: {model: ModelSummary}) {
  const {tr} = useLocale();
  const story = useStory();
  const {state, say} = story;
  const layoutRef = useRef<HTMLDivElement>(null);
  const isReadOnly = !model.isScripted;
  const training = useTraining(model, model.isScripted ? story.datasets : (model.datasets ?? null));
  const [isWarningOpen, setIsWarningOpen] = useState(false);
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<{name: string; size: string}[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Read-only histories that take /train keep the composer for it and for the agent's suggestions.
  const isComposerOn = model.isScripted || model.acceptsTrain === true;
  const modelId = model.isScripted ? undefined : model.id;
  const items = model.isScripted ? state.log : [...(model.items ?? []), ...(state.extra[model.id] ?? [])];
  const isAgentWorking = model.isScripted && state.pending.length > 0;
  const next = isComposerOn && !isAgentWorking ? openSuggestions(items, card => !model.isScripted || story.awaitedCardId === card.id) : null;
  const hint = next && value === '' && files.length === 0 ? tr(next.suggestions[0].text) : null;

  const train = (text: string) => {
    if (training.offReason) {
      story.exchange({en: text, zh: text}, t(`I can’t start training yet. ${training.offReason.en}`, `现在还不能开始训练。${training.offReason.zh}`), modelId);
      return;
    }
    if (training.missing.length > 0) setIsWarningOpen(true);
    else training.start(true);
  };

  const submit = (text: string) => {
    if (files.length > 0) {
      story.append([...files.map(f => ({kind: 'file' as const, ...f})), ...(text ? [{kind: 'user' as const, text: {en: text, zh: text}}] : []), {kind: 'agent', text: FILE_REPLY}], modelId);
      setFiles([]);
      return;
    }
    if (isTrainCommand(text)) return train(text);
    const picked = next?.suggestions.find(s => [s.text.en, s.text.zh].some(v => v.toLowerCase() === text.toLowerCase()));
    if (picked && model.isScripted) story.resolve(next!.id, picked.id);
    else if (picked) story.exchange({en: text, zh: text}, picked.reply ?? READ_ONLY_REPLY, modelId);
    else if (model.isScripted) say(text);
    else story.exchange({en: text, zh: text}, READ_ONLY_REPLY, modelId);
  };

  // When the user answers a card further up, bring them down to where the agent replies.
  const lastKind = items[items.length - 1]?.kind;
  useEffect(() => {
    if (lastKind !== 'choice' && lastKind !== 'user') return;
    const el = layoutRef.current;
    el?.scrollTo({top: el.scrollHeight, behavior: 'smooth'});
  }, [items.length, lastKind]);

  return (
    <ChatLayout
      ref={layoutRef}
      density="spacious"
      className="chat"
      composer={
        <div
          className="composer-wrap"
          onKeyDownCapture={e => {
            // Tab takes the suggested next step into the empty composer, like a code completion.
            if (e.key === 'Tab' && !e.shiftKey && hint) {
              e.preventDefault();
              setValue(hint);
            }
            // The composer won't send an empty message, but files alone are worth sending.
            if (e.key === 'Enter' && !e.shiftKey && files.length > 0 && !value.trim()) {
              e.preventDefault();
              submit('');
            }
          }}>
          {next && (
            <div className="suggestions" role="group" aria-label={tr(t('Suggested next steps', '建议的下一步'))}>
              {next.suggestions.map(s => (
                <button key={s.id} type="button" className="suggestion" onClick={() => setValue(tr(s.text))}>
                  <Icon icon={Sparkles} size="xsm" color="inherit" />
                  {tr(s.label)}
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={e => {
              const picked = [...(e.target.files ?? [])].map(f => ({name: f.name, size: formatSize(f.size)}));
              setFiles(prev => [...prev, ...picked]);
              e.target.value = '';
            }}
          />
          <ChatComposer
            value={value}
            onChange={setValue}
            onSubmit={text => {
              if (text.trim() || files.length > 0) submit(text.trim());
              setValue('');
            }}
            isDisabled={!isComposerOn}
            drawer={
              files.length > 0 ? (
                <ChatComposerDrawer>
                  <div className="attachments">
                    {files.map((f, i) => (
                      <span key={`${f.name}-${i}`} className="attachment">
                        <Icon icon={FileText} size="xsm" color="inherit" />
                        <span className="attachment-name">{f.name}</span>
                        <IconButton
                          label={tr(t(`Remove ${f.name}`, `移除 ${f.name}`))}
                          variant="ghost"
                          size="sm"
                          icon={<Icon icon={X} size="xsm" />}
                          onClick={() => setFiles(prev => prev.filter((_, k) => k !== i))}
                        />
                      </span>
                    ))}
                  </div>
                </ChatComposerDrawer>
              ) : undefined
            }
            footerActions={
              <IconButton
                label={tr(t('Attach files or images', '添加文件或图片'))}
                variant="ghost"
                icon={<Icon icon={Paperclip} size="sm" />}
                isDisabled={!isComposerOn}
                onClick={() => fileInputRef.current?.click()}
              />
            }
            sendActions={hint ? <kbd className="tab-hint">Tab</kbd> : undefined}
            sendButton={
              files.length > 0 && !value.trim() ? <IconButton label={tr(t('Send', '发送'))} variant="primary" icon={<Icon icon={ArrowUp} size="sm" />} onClick={() => submit('')} /> : undefined
            }
            placeholder={
              hint ??
              tr(
                !isComposerOn
                  ? t('This model’s history is read-only in the demo', '演示中该模型的记录为只读')
                  : t(`Message the agent, or type ${TRAIN_COMMAND}`, `给智能体发消息，或输入 ${TRAIN_COMMAND}`),
              )
            }
          />
        </div>
      }>
      <ChatMessageList>
        {items.map((item, i) => (
          <ItemView key={i} item={item} isReadOnly={isReadOnly} />
        ))}
        {isAgentWorking && (
          <AgentMessage>
            <span className="agent-working" role="status">
              <AgentMark isWorking />
              <span>{tr(t('Working…', '处理中…'))}</span>
            </span>
          </AgentMessage>
        )}
      </ChatMessageList>
      {isWarningOpen && (
        <TrainWarning
          missing={training.missing}
          onCancel={() => setIsWarningOpen(false)}
          onConfirm={() => {
            setIsWarningOpen(false);
            training.start(true);
          }}
        />
      )}
    </ChatLayout>
  );
}

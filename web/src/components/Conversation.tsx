'use client';

import {useEffect, useRef} from 'react';
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import {Markdown} from '@astryxdesign/core/Markdown';
import {AgentMark} from '@/components/AgentMark';
import {ArtifactCard} from '@/components/ArtifactCard';
import {AgentCard} from '@/components/cards/AgentCard';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {CARDS, choiceLabel, useStory} from '@/story/StoryProvider';
import type {ModelSummary} from '@/story/models';
import type {Item} from '@/story/types';

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
              calls={item.tools.map(tool => ({name: tool.name, target: tr(tool.target), duration: tool.duration, status: 'complete'}))}
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
      return (
        <AgentMessage>
          <AgentCard card={item.card} isReadOnly={isReadOnly} />
        </AgentMessage>
      );
  }
}

export function Conversation({model}: {model: ModelSummary}) {
  const {tr} = useLocale();
  const {state, say} = useStory();
  const layoutRef = useRef<HTMLDivElement>(null);
  const isReadOnly = !model.isScripted;
  const items = model.isScripted ? state.log : (model.items ?? []);
  const isAgentWorking = model.isScripted && state.pending.length > 0;

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
        <ChatComposer
          onSubmit={value => {
            if (value.trim()) say(value.trim());
          }}
          isDisabled={isReadOnly}
          placeholder={tr(
            isReadOnly ? t('This model’s history is read-only in the demo', '演示中该模型的记录为只读') : t('Message the agent…', '给智能体发消息…'),
          )}
        />
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
    </ChatLayout>
  );
}

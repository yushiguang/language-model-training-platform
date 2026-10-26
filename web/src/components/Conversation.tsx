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
import {Avatar} from '@astryxdesign/core/Avatar';
import {Markdown} from '@astryxdesign/core/Markdown';
import {AgentCard} from '@/components/cards/AgentCard';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {CARDS, choiceLabel, useStory} from '@/story/StoryProvider';
import type {ModelSummary} from '@/story/models';
import type {Item, PanelId} from '@/story/types';

const PANEL_LINK = '#panel-';

function AgentAvatar() {
  return <Avatar name="Agent" size="md" />;
}

function ItemView({item, isReadOnly}: {item: Item; isReadOnly: boolean}) {
  const {tr} = useLocale();
  const {state, openPanel} = useStory();

  // Links the agent writes as "#panel-<id>" open that workspace panel beside the chat.
  const onLinkClick = (href: string) => {
    if (!href.startsWith(PANEL_LINK)) return;
    openPanel(href.slice(PANEL_LINK.length) as PanelId);
    return false as const;
  };

  switch (item.kind) {
    case 'user':
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{tr(item.text)}</ChatMessageBubble>
        </ChatMessage>
      );
    case 'choice': {
      const card = CARDS[item.cardId];
      const choice = state.choices[item.cardId];
      const label = choice ? choiceLabel(card, choice) : null;
      if (!label) return null;
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{tr(label)}</ChatMessageBubble>
        </ChatMessage>
      );
    }
    case 'agent':
      return (
        <ChatMessage sender="assistant" avatar={<AgentAvatar />}>
          {item.tools && (
            <ChatToolCalls
              calls={item.tools.map(tool => ({name: tool.name, target: tr(tool.target), duration: tool.duration, status: 'complete'}))}
            />
          )}
          <ChatMessageBubble variant="ghost">
            <Markdown density="compact" onLinkClick={onLinkClick}>
              {tr(item.text)}
            </Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      );
    case 'reply': {
      const choice = state.choices[item.cardId];
      const text = choice ? item.replies[choice] : undefined;
      if (!text) return null;
      return (
        <ChatMessage sender="assistant" avatar={<AgentAvatar />}>
          <ChatMessageBubble variant="ghost">
            <Markdown density="compact">{tr(text)}</Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      );
    }
    case 'system':
      return <ChatSystemMessage variant="divider">{tr(item.text)}</ChatSystemMessage>;
    case 'card':
      return (
        <ChatMessage sender="assistant" avatar={<AgentAvatar />}>
          <ChatMessageBubble variant="ghost" width="100%">
            <AgentCard card={item.card} isReadOnly={isReadOnly} />
          </ChatMessageBubble>
        </ChatMessage>
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
      density="balanced"
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
          <ChatMessage sender="assistant" avatar={<AgentAvatar />}>
            <ChatMessageBubble variant="ghost">
              <span className="typing" aria-label={tr(t('The agent is working', '智能体正在处理'))}>
                <span />
                <span />
                <span />
              </span>
            </ChatMessageBubble>
          </ChatMessage>
        )}
      </ChatMessageList>
    </ChatLayout>
  );
}

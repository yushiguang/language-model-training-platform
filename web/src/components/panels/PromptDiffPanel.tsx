'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {FactRows} from '@/components/cards/CardFrame';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {invalidRate, macroF1, PROMPT_RUNS, scores} from '@/mock/metrics';
import {CARDS, useStory} from '@/story/StoryProvider';
import type {Card} from '@/story/types';
import {fmt2, pct} from './parts';

type Advice = Extract<Card, {type: 'advice'}>;

/** Each prompt version the user adopted, with the change and what it did on the eval split. */
export function PromptDiffPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const adopted = (['adv-1', 'adv-2'] as const).map(id => CARDS[id] as Advice).filter(c => story.isResolved(c.id));
  const latest = adopted.length ? adopted[adopted.length - 1].to : 'v1';
  const disc = (v: keyof typeof PROMPT_RUNS) => scores(PROMPT_RUNS[v]).find(s => s.label === 'discussion')!.f1;

  return (
    <VStack gap={6}>
      <ol className="version-list">
        {[...adopted].reverse().map(card => (
          <li key={card.id} className="version">
            <VStack gap={2}>
              <HStack gap={2} align="center" wrap="wrap">
                <Text weight="semibold">Prompt {card.to}</Text>
                {card.to === latest && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
                <Text type="supporting" color="secondary">
                  {tr(t(`changed from ${card.from} on the agent’s advice`, `由 ${card.from} 按智能体建议修改`))}
                </Text>
              </HStack>
              <Text weight="medium">{tr(card.title)}</Text>
              <Text color="secondary">{tr(card.diagnosis)}</Text>
              <pre className="diff" aria-label={tr(t(`Changes from ${card.from} to ${card.to}`, `${card.from} 到 ${card.to} 的修改`))}>
                {card.removed.map(line => (
                  <div key={line} className="diff-removed">
                    − {line}
                  </div>
                ))}
                {card.added.map(line => (
                  <div key={line} className="diff-added">
                    + {line}
                  </div>
                ))}
              </pre>
              <FactRows
                rows={[
                  {label: tr(t('Macro-F1', '宏平均 F1')), value: `${fmt2(macroF1(PROMPT_RUNS[card.from]))} → ${fmt2(macroF1(PROMPT_RUNS[card.to]))}`},
                  {label: tr(t('Discussion F1', '讨论 F1')), value: `${fmt2(disc(card.from))} → ${fmt2(disc(card.to))}`},
                  {label: tr(t('Invalid outputs', '无效输出')), value: `${pct(invalidRate(PROMPT_RUNS[card.from]), 1)} → ${pct(invalidRate(PROMPT_RUNS[card.to]), 1)}`},
                ]}
              />
            </VStack>
          </li>
        ))}
        <li className="version">
          <VStack gap={1}>
            <HStack gap={2} align="center">
              <Text weight="semibold">Prompt v1</Text>
              {latest === 'v1' && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
            </HStack>
            <Text color="secondary">
              {tr(t('Your team’s original prompt, unchanged. Macro-F1 ', '团队原有的 Prompt，未修改。宏平均 F1 '))}
              {fmt2(macroF1(PROMPT_RUNS.v1))}.
            </Text>
          </VStack>
        </li>
      </ol>
    </VStack>
  );
}

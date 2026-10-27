'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {FactRows} from '@/components/cards/CardFrame';
import {PromptDiff} from '@/components/cards/AgentCard';
import {measureRows} from '@/components/measures';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS} from '@/mock/fields';
import {macroF1, PROMPT_RUNS} from '@/mock/metrics';
import {CARDS, useStory} from '@/story/StoryProvider';
import type {Card} from '@/story/types';
import {fmt2} from './parts';

type Advice = Extract<Card, {type: 'advice'}>;

/** Each prompt version the user adopted, with the change and what it did on the eval split. */
export function PromptDiffPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const adopted = (['adv-1', 'adv-2'] as const).map(id => CARDS[id] as Advice).filter(c => story.isResolved(c.id));
  const latest = adopted.length ? adopted[adopted.length - 1].to : 'v1';
  const v1 = PROMPT_RUNS.v1;

  return (
    <div className="page">
      <ol className="version-list">
        {[...adopted].reverse().map(card => (
          <li key={card.id} className="version">
            <div className="version-head">
              <span className="version-name">Prompt {card.to}</span>
              {card.to === latest && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
              <span className="version-meta">{tr(t(`changed from ${card.from} on the agent’s advice`, `由 ${card.from} 按智能体建议修改`))}</span>
            </div>
            <div className="version-title">{tr(card.title)}</div>
            <p className="page-text">{tr(card.diagnosis)}</p>
            <PromptDiff removed={card.removed} added={card.added} label={tr(t(`Changes from ${card.from} to ${card.to}`, `${card.from} 到 ${card.to} 的修改`))} />
            <FactRows rows={measureRows(card.measures, card.from, card.to).map(r => ({label: tr(r.label), value: r.value}))} />
          </li>
        ))}
        <li className="version">
          <div className="version-head">
            <span className="version-name">Prompt v1</span>
            {latest === 'v1' && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
            <span className="version-meta">{tr(t('your team’s original prompt', '团队原有的 Prompt'))}</span>
          </div>
          <FactRows rows={FIELDS.map(f => ({label: tr(t(`${f.name.en} macro-F1`, `${f.name.zh}宏平均 F1`)), value: fmt2(macroF1(v1, f.id))}))} />
        </li>
      </ol>
    </div>
  );
}

'use client';

import {titleCase} from '@/i18n/titleCase';
import {useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {TextArea} from '@astryxdesign/core/TextArea';
import {Info, Pencil} from 'lucide-react';
import {FactRows, IconLine} from '@/components/cards/CardFrame';
import {PromptDiff} from '@/components/cards/AgentCard';
import {BeforeAfter} from '@/components/Change';
import {measureRows} from '@/components/measures';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS} from '@/mock/fields';
import {macroF1, PROMPT_RUNS} from '@/mock/metrics';
import {PROMPT_TEXT} from '@/mock/prompt';
import {CARDS, useStory} from '@/story/StoryProvider';
import type {Card} from '@/story/types';
import {PanelSection, fmt2} from './parts';

type Advice = Extract<Card, {type: 'advice'}>;
type Version = keyof typeof PROMPT_TEXT;

/** The whole prompt at any version, editable, with the history of how it got there. */
export function PromptDiffPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const adopted = (['adv-1', 'adv-2'] as const).map(id => CARDS[id] as Advice).filter(c => story.isResolved(c.id));
  const versions: Version[] = ['v1', ...adopted.map(c => c.to as Version)];
  const latest = versions[versions.length - 1];
  const drafts = story.state.promptDrafts;
  const ids = [...versions, ...drafts.map((_, i) => `d${i + 1}`)];
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = picked && ids.includes(picked) ? picked : latest;
  const isDraft = shown.startsWith('d');
  const text = isDraft ? drafts[Number(shown.slice(1)) - 1] : PROMPT_TEXT[shown as Version];
  // Lines new since the version before, so the changes stand out inside the whole prompt.
  const base = isDraft ? PROMPT_TEXT[latest] : shown === 'v1' ? null : PROMPT_TEXT[versions[versions.indexOf(shown as Version) - 1]];
  const baseLines = base ? new Set(base.split('\n')) : null;
  const nameOf = (id: string) => (id.startsWith('d') ? tr(t(`Draft ${id.slice(1)}`, `草稿 ${id.slice(1)}`)) : `Prompt ${id}`);

  return (
    <div className="page prompt-page">
      <div className="prompt-main">
        <div className="page-toolbar">
          <SegmentedControl
            label={tr(t('Prompt version', 'Prompt 版本'))}
            size="sm"
            value={shown}
            onChange={v => {
              setPicked(v);
              setDraft(null);
            }}>
            {ids.map(id => (
              <SegmentedControlItem key={id} value={id} label={id.startsWith('d') ? nameOf(id) : id} />
            ))}
          </SegmentedControl>
          {shown === latest && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
          {isDraft && <Badge variant="neutral" label={tr(t('Draft · not scored yet', '草稿 · 尚未评估'))} />}
          {draft === null && (
            <Button className="toolbar-end" label={tr(t('Edit prompt', '编辑 Prompt'))} variant="secondary" size="sm" icon={<Icon icon={Pencil} size="sm" />} onClick={() => setDraft(text)} />
          )}
        </div>

        {draft !== null ? (
          <div className="prompt-edit">
            <TextArea label={tr(t(`Edit ${nameOf(shown)}`, `编辑 ${nameOf(shown)}`))} isLabelHidden value={draft} onChange={setDraft} rows={26} />
            <div className="card-actions">
              <Button
                label={tr(t('Save as a draft', '保存为草稿'))}
                variant="primary"
                isDisabled={draft === text}
                onClick={() => {
                  story.savePromptDraft(draft);
                  setPicked(`d${drafts.length + 1}`);
                  setDraft(null);
                }}
              />
              <Button label={tr(t('Cancel', '取消'))} variant="ghost" onClick={() => setDraft(null)} />
            </div>
          </div>
        ) : (
          <>
            {isDraft && (
              <IconLine className="page-note-inline" icon={<Icon icon={Info} size="sm" color="secondary" />}>
                {tr(
                  t(
                    `Your edit of prompt ${latest}. In the product, the agent scores a draft on the 600-post eval split, shows what changed, and you choose whether to adopt it.`,
                    `基于 Prompt ${latest} 的修改。在正式产品里，智能体会在 600 条评估集上为草稿打分、展示变化，由你决定是否采纳。`,
                  ),
                )}
              </IconLine>
            )}
            <pre className="prompt-text" aria-label={tr(t(`${nameOf(shown)}, full text`, `${nameOf(shown)} 全文`))}>
              {text.split('\n').map((line, i) => (
                <div key={i} className={baseLines && !baseLines.has(line) ? 'prompt-line prompt-line-new' : 'prompt-line'}>
                  {line || ' '}
                </div>
              ))}
            </pre>
            {baseLines && <div className="prompt-legend">{tr(t('Highlighted lines are new in this version.', '高亮的行是这个版本新改的。'))}</div>}
          </>
        )}
      </div>

      <PanelSection title={t('History', '版本历史')}>
        <ol className="version-list">
          {[...adopted].reverse().map(card => (
            <li key={card.id} className="version">
              <div className="version-head">
                <span className="version-name">Prompt {card.to}</span>
                <span className="version-meta">{tr(t(`from ${card.from}, on the agent’s advice`, `由 ${card.from} 按智能体建议修改`))}</span>
              </div>
              <div className="version-title">{titleCase(tr(card.title))}</div>
              <PromptDiff removed={card.removed} added={card.added} label={tr(t(`Changes from ${card.from} to ${card.to}`, `${card.from} 到 ${card.to} 的修改`))} />
              <FactRows
                rows={measureRows(card.measures, card.from, card.to).map(r => ({
                  label: tr(r.label),
                  value: <BeforeAfter row={r} />,
                }))}
              />
            </li>
          ))}
          <li className="version">
            <div className="version-head">
              <span className="version-name">Prompt v1</span>
              <span className="version-meta">{tr(t('your team’s original prompt', '团队原有的 Prompt'))}</span>
            </div>
            <FactRows
              rows={FIELDS.map(f => ({
                label: tr(t(`${f.name.en} macro-F1`, `${f.name.zh} macro-F1`)),
                value: fmt2(macroF1(PROMPT_RUNS.v1, f.id)),
              }))}
            />
          </li>
        </ol>
      </PanelSection>
    </div>
  );
}

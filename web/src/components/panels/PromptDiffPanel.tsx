'use client';

import {titleCase} from '@/i18n/titleCase';
import {useState} from 'react';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {TextArea} from '@astryxdesign/core/TextArea';
import {BarChart3, Info, PenLine, Star} from 'lucide-react';
import {FactRows, IconLine} from '@/components/cards/CardFrame';
import {PromptDiff} from '@/components/cards/AgentCard';
import {BeforeAfter} from '@/components/Change';
import {GateTag} from '@/components/GateTag';
import {measureRows} from '@/components/measures';
import {bestPrompt, PromptTrend, useScoredPrompts} from '@/components/PromptTrend';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {FIELDS} from '@/mock/fields';
import {macroF1, passesTeacherGate, PROMPT_RUNS} from '@/mock/metrics';
import {fmt2} from '@/mock/numbers';
import {nextVersion, PROMPT_ORDER, PROMPT_PARENT, PROMPT_TEXT, type PromptId} from '@/mock/prompt';
import {CARDS, useStory} from '@/story/StoryProvider';
import type {Card, PromptVariant} from '@/story/types';
import {PanelSection} from './parts';

type Advice = Extract<Card, {type: 'advice'}>;
const ADVICE = ['adv-1', 'adv-2', 'adv-3'].map(id => CARDS[id] as Advice);
type SortBy = 'version' | 'f1';

/** A version in the list: one the agent made, or one the user saved from an edit. */
interface Version {
  id: string;
  parent: string | null;
  text: string;
  isUsers: boolean;
}

/** The advice that created a version, and which of its variants. */
function originOf(id: string): {card: Advice; variant: PromptVariant} | null {
  for (const card of ADVICE) {
    const variant = card.variants.find(v => v.to === id);
    if (variant) return {card, variant};
  }
  return null;
}

/** Orders two-part versions, newest first: v2.0 before v1.10 before v1.9. */
function byVersionDesc(a: string, b: string): number {
  const [am, an] = a.slice(1).split('.').map(Number);
  const [bm, bn] = b.slice(1).split('.').map(Number);
  return bm - am || bn - an;
}

/** Mean macro-F1 of the label fields on the eval posts, the number the list sorts by. */
const meanF1 = (id: PromptId) => FIELDS.reduce((a, f) => a + macroF1(PROMPT_RUNS[id], f.id), 0) / FIELDS.length;

/**
 * Prompt versions, numbered major.minor. Each version says which one it came from; the agent's
 * changes and the user's saved edits bump the minor version, and the user can ask for a major one.
 */
export function PromptDiffPanel({focus}: {focus?: string}) {
  const {tr} = useLocale();
  const story = useStory();
  const scored = useScoredPrompts();
  const best = bestPrompt(scored);
  const exists: Record<PromptId, boolean> = {'v1.0': true, 'v1.1': story.isResolved('adv-1'), 'v1.2': story.isResolved('adv-2'), 'v1.3': story.isResolved('adv-3')};
  const agentIds = PROMPT_ORDER.filter(id => exists[id]);
  const versions: Version[] = [
    ...agentIds.map(id => ({id, parent: PROMPT_PARENT[id], text: PROMPT_TEXT[id], isUsers: false})),
    ...story.state.promptDrafts.map(d => ({id: d.version, parent: d.parent, text: d.text, isUsers: true})),
  ];
  const inUse = agentIds[agentIds.length - 1];
  const [picked, setPicked] = useState<string | null>(focus ?? null);
  const [draft, setDraft] = useState<string | null>(null);
  const [isMajor, setIsMajor] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('version');
  const shownId = picked && versions.some(v => v.id === picked) ? picked : inUse;
  const shown = versions.find(v => v.id === shownId)!;
  const parent = shown.parent ? versions.find(v => v.id === shown.parent) : undefined;
  const origin = originOf(shown.id);
  const isScored = scored.includes(shown.id as PromptId);
  const baseLines = parent ? new Set(parent.text.split('\n')) : null;
  // Numbers the agent's coming versions will use stay reserved, so a version saved mid-story never takes one.
  const taken = [...PROMPT_ORDER, ...story.state.promptDrafts.map(d => d.version)];
  const nextMinor = nextVersion(taken, false);
  const nextMajor = nextVersion(taken, true);
  // The trend highlights the shown version, or the version an unscored edit came from.
  const trendId = (isScored ? shown.id : shown.parent) as PromptId;
  const scoreOf = (v: Version) => (scored.includes(v.id as PromptId) ? meanF1(v.id as PromptId) : null);
  const sorted = [...versions].sort((a, b) => {
    if (sortBy === 'f1') {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa !== sb) return sa === null ? 1 : sb === null ? -1 : sb - sa;
    }
    return byVersionDesc(a.id, b.id);
  });

  const select = (id: string) => {
    setPicked(id);
    setDraft(null);
  };

  return (
    <div className="page prompt-page">
      <div className="prompt-layout">
        <nav className="version-list" aria-label={tr(t('Prompt versions', 'Prompt 版本'))}>
          <div className="version-list-head">
            <div className="version-list-title">{tr(t('Versions', '版本'))}</div>
            <SegmentedControl label={tr(t('Sort by', '排序'))} size="sm" value={sortBy} onChange={v => setSortBy(v as SortBy)}>
              <SegmentedControlItem value="version" label={tr(t('Version', '版本'))} />
              <SegmentedControlItem value="f1" label="F1" />
            </SegmentedControl>
          </div>
          <ul className="version-items">
            {sorted.map(v => {
              const score = scoreOf(v);
              const note: T | undefined = v.isUsers
                ? t(`From ${v.parent} · your edit`, `基于 ${v.parent} · 你的修改`)
                : v.parent
                  ? t(`From ${v.parent}`, `基于 ${v.parent}`)
                  : t('From your team’s prompt', '基于团队的 Prompt');
              return (
                <li key={v.id}>
                  <button type="button" className={`version-row${v.id === shownId ? ' version-row-current' : ''}`} aria-current={v.id === shownId ? 'true' : undefined} onClick={() => select(v.id)}>
                    <span className="version-row-head">
                      <span className="version-row-name">{v.id}</span>
                      {v.id === best && (
                        <span className="version-best">
                          <Icon icon={Star} size="xsm" color="inherit" />
                          {tr(t('Best', '最佳'))}
                        </span>
                      )}
                      {v.id === inUse && <span className="version-in-use">{tr(t('In use', '使用中'))}</span>}
                      {score !== null && (
                        <span className="version-row-score" title={tr(t('Mean macro-F1 of the three fields', '三个字段 macro-F1 的平均值'))}>
                          F1 {fmt2(score)}
                        </span>
                      )}
                    </span>
                    <span className="version-row-note">{tr(note)}</span>
                    <span className="version-row-tags">
                      {score !== null ? (
                        <GateTag passed={passesTeacherGate(PROMPT_RUNS[v.id as PromptId])} />
                      ) : (
                        <span className="version-pending">{tr(v.isUsers ? t('Not scored yet', '尚未评估') : t('Running', '运行中'))}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="prompt-main">
          <div className="page-toolbar">
            <h3 className="prompt-title">{`Prompt ${shown.id}`}</h3>
            {shown.id === inUse && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
            {shown.isUsers && <Badge variant="neutral" label={tr(t('Your edit · not scored yet', '你的修改 · 尚未评估'))} />}
            {isScored && <GateTag passed={passesTeacherGate(PROMPT_RUNS[shown.id as PromptId])} />}
            {draft === null && (
              <div className="toolbar-end prompt-actions">
                {isScored && (
                  <Button label={tr(t('Eval report', '评估报告'))} variant="ghost" size="sm" icon={<Icon icon={BarChart3} size="sm" />} onClick={() => story.openPanel('evalReport', shown.id)} />
                )}
                <Button
                  label={tr(t('Edit as a new version', '编辑为新版本'))}
                  variant="secondary"
                  size="sm"
                  icon={<Icon icon={PenLine} size="sm" />}
                  onClick={() => {
                    setDraft(shown.text);
                    setIsMajor(false);
                  }}
                />
              </div>
            )}
          </div>

          {draft !== null ? (
            <div className="prompt-edit">
              <IconLine className="page-note-inline" icon={<Icon icon={Info} size="sm" color="secondary" />}>
                {tr(
                  t(
                    `Saving keeps prompt ${shown.id} as it is and adds your edit as ${isMajor ? nextMajor : nextMinor}, from ${shown.id}.`,
                    `保存后 Prompt ${shown.id} 保持不变，你的修改会成为基于 ${shown.id} 的 ${isMajor ? nextMajor : nextMinor}。`,
                  ),
                )}
              </IconLine>
              <TextArea label={tr(t(`Edit prompt ${shown.id}`, `编辑 Prompt ${shown.id}`))} isLabelHidden value={draft} onChange={setDraft} rows={draft.split('\n').length + 1} />
              <CheckboxInput
                label={tr(t(`Save as a major version (${nextMajor}) instead of ${nextMinor}`, `保存为大版本（${nextMajor}），而不是 ${nextMinor}`))}
                value={isMajor}
                onChange={setIsMajor}
              />
              <div className="card-actions">
                <Button
                  label={tr(t(`Save as ${isMajor ? nextMajor : nextMinor}`, `保存为 ${isMajor ? nextMajor : nextMinor}`))}
                  variant="primary"
                  isDisabled={draft === shown.text}
                  onClick={() => {
                    const version = isMajor ? nextMajor : nextMinor;
                    story.savePromptDraft({version, text: draft, parent: shown.id as PromptId});
                    setPicked(version);
                    setDraft(null);
                  }}
                />
                <Button label={tr(t('Cancel', '取消'))} variant="ghost" onClick={() => setDraft(null)} />
              </div>
            </div>
          ) : (
            <>
              {shown.isUsers && (
                <IconLine className="page-note-inline" icon={<Icon icon={Info} size="sm" color="secondary" />}>
                  {tr(
                    t(
                      `Your edit of prompt ${shown.parent}. In the product, you create an auto-labeling task for it from here; the agent scores it on the 600 eval posts and adds it to the chart below.`,
                      `基于 Prompt ${shown.parent} 的修改。在正式产品里，你可以在这里为它创建自动标注任务；智能体会在 600 条评估帖子上打分，并加到下面的图里。`,
                    ),
                  )}
                </IconLine>
              )}
              {origin && (
                <div className="version-change">
                  <div className="version-title">
                    {tr(t(`From ${origin.card.from}: `, `基于 ${origin.card.from}：`))}
                    {titleCase(tr(origin.card.title))}
                  </div>
                  <PromptDiff
                    removed={origin.variant.removed}
                    added={origin.variant.added}
                    label={tr(t(`Changes from ${origin.card.from} to ${shown.id}`, `${origin.card.from} 到 ${shown.id} 的修改`))}
                  />
                  {isScored && (
                    <FactRows
                      rows={measureRows(
                        origin.card.measures ?? [
                          {kind: 'macro', field: 'primary_value'},
                          {kind: 'macro', field: 'topics'},
                        ],
                        origin.card.from,
                        shown.id as PromptId,
                      ).map(r => ({
                        label: tr(r.label),
                        value: <BeforeAfter row={r} />,
                      }))}
                    />
                  )}
                </div>
              )}
              <pre className="prompt-text" aria-label={tr(t(`$Prompt ${shown.id}, full text`, `Prompt ${shown.id} 全文`))}>
                {shown.text.split('\n').map((line, i) => (
                  <div key={i} className={baseLines && !baseLines.has(line) ? 'prompt-line prompt-line-new' : 'prompt-line'}>
                    {line || ' '}
                  </div>
                ))}
              </pre>
              {baseLines && <div className="prompt-legend">{tr(t(`Highlighted lines are new since ${shown.parent}.`, `高亮的行是相对 ${shown.parent} 新改的。`))}</div>}
            </>
          )}
        </div>
      </div>

      {scored.length > 0 && (
        <PanelSection title={t('Scores across versions', '各版本得分')} description={t('Click a version to read it.', '点击某个版本可查看它。')}>
          <PromptTrend selected={scored.includes(trendId) ? trendId : scored[scored.length - 1]} onSelect={select} />
        </PanelSection>
      )}
    </div>
  );
}

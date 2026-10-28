'use client';

import {titleCase} from '@/i18n/titleCase';
import {useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {TextArea} from '@astryxdesign/core/TextArea';
import {BarChart3, GitBranch, Info, Star} from 'lucide-react';
import {FactRows, IconLine} from '@/components/cards/CardFrame';
import {PromptDiff} from '@/components/cards/AgentCard';
import {BeforeAfter} from '@/components/Change';
import {GateTag} from '@/components/GateTag';
import {measureRows} from '@/components/measures';
import {bestPrompt, PromptTrend, useScoredPrompts} from '@/components/PromptTrend';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {passesTeacherGate, PROMPT_RUNS} from '@/mock/metrics';
import {PROMPT_ORDER, PROMPT_PARENT, PROMPT_TEXT, type PromptId} from '@/mock/prompt';
import {CARDS, useStory} from '@/story/StoryProvider';
import type {Card, PromptVariant} from '@/story/types';
import {PanelSection} from './parts';

type Advice = Extract<Card, {type: 'advice'}>;
const ADVICE = ['adv-1', 'adv-2'].map(id => CARDS[id] as Advice);

/** A version in the tree: one the agent made, or a draft the user saved from one. */
interface Node {
  id: string;
  parent: string | null;
  text: string;
  isDraft: boolean;
}

/** The advice that created a version, and which of its variants. */
function originOf(id: string): {card: Advice; variant: PromptVariant} | null {
  for (const card of ADVICE) {
    const variant = card.variants.find(v => v.to === id);
    if (variant) return {card, variant};
  }
  return null;
}

/**
 * Prompt versions as a tree: each version comes from a parent, and siblings can be tried side by
 * side. Any version can be read, edited into a draft, or used as the start of a new branch.
 */
export function PromptDiffPanel({focus}: {focus?: string}) {
  const {tr} = useLocale();
  const story = useStory();
  const scored = useScoredPrompts();
  const best = bestPrompt(scored);
  const exists: Record<PromptId, boolean> = {v1: true, v2: story.isResolved('adv-1'), v3a: story.isResolved('adv-2'), v3b: story.isResolved('adv-2')};
  const nodes: Node[] = [
    ...PROMPT_ORDER.filter(id => exists[id]).map(id => ({id, parent: PROMPT_PARENT[id], text: PROMPT_TEXT[id], isDraft: false})),
    ...story.state.promptDrafts.map((d, i) => ({id: `d${i + 1}`, parent: d.parent, text: d.text, isDraft: true})),
  ];
  const inUse: PromptId | null = story.isResolved('a-teacher-gate') ? 'v3b' : story.isResolved('adv-2') ? null : story.isResolved('adv-1') ? 'v2' : 'v1';
  const [picked, setPicked] = useState<string | null>(focus ?? null);
  const [draft, setDraft] = useState<string | null>(null);
  const shownId = picked && nodes.some(n => n.id === picked) ? picked : (inUse ?? nodes[nodes.length - 1].id);
  const shown = nodes.find(n => n.id === shownId)!;
  const parent = shown.parent ? nodes.find(n => n.id === shown.parent) : undefined;
  const origin = originOf(shown.id);
  const isScored = scored.includes(shown.id as PromptId);
  const baseLines = parent ? new Set(parent.text.split('\n')) : null;
  const nameOf = (id: string) => (id.startsWith('d') ? tr(t(`Draft ${id.slice(1)}`, `草稿 ${id.slice(1)}`)) : `Prompt ${id}`);
  // The trend follows the shown version, or the version a draft came from, since drafts aren't scored.
  const trendId = (shown.isDraft ? shown.parent : shown.id) as PromptId;

  const select = (id: string) => {
    setPicked(id);
    setDraft(null);
  };

  const renderBranch = (parentId: string | null): React.ReactNode => {
    const children = nodes.filter(n => n.parent === parentId);
    if (children.length === 0) return null;
    return (
      <ul className={parentId ? 'tree-children' : 'tree'}>
        {children.map(n => {
          const isNodeScored = scored.includes(n.id as PromptId);
          const note: T | undefined = n.isDraft
            ? t('Your edit · not scored', '你的修改 · 未评估')
            : (originOf(n.id)?.variant.note ?? (n.id === 'v1' ? t('From your team’s prompt', '基于团队的 Prompt') : undefined));
          return (
            <li key={n.id} className="tree-item">
              <button type="button" className={`tree-node${n.id === shownId ? ' tree-node-current' : ''}`} aria-current={n.id === shownId ? 'true' : undefined} onClick={() => select(n.id)}>
                <span className="tree-node-head">
                  <span className="tree-node-name">{nameOf(n.id)}</span>
                  {n.id === best && (
                    <span className="tree-best">
                      <Icon icon={Star} size="xsm" color="inherit" />
                      {tr(t('Best', '最佳'))}
                    </span>
                  )}
                  {n.id === inUse && <span className="tree-in-use">{tr(t('In use', '使用中'))}</span>}
                </span>
                {note && <span className="tree-node-note">{tr(note)}</span>}
                <span className="tree-node-tags">
                  {isNodeScored ? <GateTag passed={passesTeacherGate(PROMPT_RUNS[n.id as PromptId])} /> : !n.isDraft && <span className="tree-pending">{tr(t('Running', '运行中'))}</span>}
                </span>
              </button>
              {renderBranch(n.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="page prompt-page">
      <div className="prompt-layout">
        <nav className="prompt-tree" aria-label={tr(t('Prompt versions', 'Prompt 版本'))}>
          <div className="prompt-tree-title">{tr(t('Versions', '版本'))}</div>
          {renderBranch(null)}
        </nav>

        <div className="prompt-main">
          <div className="page-toolbar">
            <h3 className="prompt-title">{nameOf(shown.id)}</h3>
            {shown.id === inUse && <Badge variant="success" label={tr(t('In use', '使用中'))} />}
            {shown.isDraft && <Badge variant="neutral" label={tr(t('Draft · not scored yet', '草稿 · 尚未评估'))} />}
            {isScored && <GateTag passed={passesTeacherGate(PROMPT_RUNS[shown.id as PromptId])} />}
            {draft === null && (
              <div className="toolbar-end prompt-actions">
                {isScored && (
                  <Button label={tr(t('Eval report', '评估报告'))} variant="ghost" size="sm" icon={<Icon icon={BarChart3} size="sm" />} onClick={() => story.openPanel('evalReport', shown.id)} />
                )}
                <Button label={tr(t('Start from this prompt', '从这个版本开始'))} variant="secondary" size="sm" icon={<Icon icon={GitBranch} size="sm" />} onClick={() => setDraft(shown.text)} />
              </div>
            )}
          </div>

          {draft !== null ? (
            <div className="prompt-edit">
              <IconLine className="page-note-inline" icon={<Icon icon={Info} size="sm" color="secondary" />}>
                {tr(t(`Your changes become a new draft branching from ${nameOf(shown.id)}.`, `你的修改会保存为基于 ${nameOf(shown.id)} 的新草稿分支。`))}
              </IconLine>
              <TextArea label={tr(t(`Edit ${nameOf(shown.id)}`, `编辑 ${nameOf(shown.id)}`))} isLabelHidden value={draft} onChange={setDraft} rows={draft.split('\n').length + 1} />
              <div className="card-actions">
                <Button
                  label={tr(t('Save as a draft', '保存为草稿'))}
                  variant="primary"
                  isDisabled={draft === shown.text}
                  onClick={() => {
                    // A draft of a draft still branches from the scored version it came from.
                    story.savePromptDraft({text: draft, parent: (shown.isDraft ? shown.parent : shown.id) as PromptId});
                    setPicked(`d${story.state.promptDrafts.length + 1}`);
                    setDraft(null);
                  }}
                />
                <Button label={tr(t('Cancel', '取消'))} variant="ghost" onClick={() => setDraft(null)} />
              </div>
            </div>
          ) : (
            <>
              {shown.isDraft && (
                <IconLine className="page-note-inline" icon={<Icon icon={Info} size="sm" color="secondary" />}>
                  {tr(
                    t(
                      `Your edit of prompt ${shown.parent}. In the product, you create an auto-labeling task for a draft from here; the agent scores it on the 600 eval posts and adds it to the chart below.`,
                      `基于 Prompt ${shown.parent} 的修改。在正式产品里，你可以在这里为草稿创建自动标注任务；智能体会在 600 条评估帖子上打分，并加到下面的图里。`,
                    ),
                  )}
                </IconLine>
              )}
              {origin && (
                <div className="version-change">
                  <div className="version-title">
                    {tr(t(`From ${origin.card.from}: `, `基于 ${origin.card.from}：`))}
                    {titleCase(tr(origin.card.variants.length > 1 ? origin.variant.note : origin.card.title))}
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
              <pre className="prompt-text" aria-label={tr(t(`${nameOf(shown.id)}, full text`, `${nameOf(shown.id)} 全文`))}>
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
        <PanelSection
          title={t('Scores across versions', '各版本得分')}
          description={t('Click a version to read it. Lines follow the selected version’s lineage.', '点击某个版本可查看它。连线是所选版本的版本路径。')}>
          <PromptTrend selected={scored.includes(trendId) ? trendId : scored[scored.length - 1]} onSelect={select} />
        </PanelSection>
      )}
    </div>
  );
}

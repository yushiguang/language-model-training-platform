'use client';

import {useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {Kbd} from '@astryxdesign/core/Kbd';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Circle, CircleCheck, Sparkles} from 'lucide-react';
import {IconLine} from '@/components/cards/CardFrame';
import {sameAnswer} from '@/components/PostLabels';
import {PostPreview} from '@/components/PostPreview';
import {ValueList} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {FIELD_BY_ID, FIELDS, valueOf, type FieldId} from '@/mock/fields';
import {CONFLICT_TOTALS, CONFLICTS, POST_BY_ID, type Conflict} from '@/mock/posts';
import {useStory} from '@/story/StoryProvider';
import {useNumber} from './parts';

type FieldFilter = FieldId | 'all';

const TOTAL = FIELDS.reduce((a, f) => a + CONFLICT_TOTALS[f.id], 0);
/** Disagreements beyond the sample on this page, per field; they are counted, not listed, in the demo. */
const UNLISTED = Object.fromEntries(FIELDS.map(f => [f.id, CONFLICT_TOTALS[f.id] - CONFLICTS.filter(c => c.field === f.id).length])) as Record<FieldId, number>;

function shortAnswer(field: FieldId, ids: string[], tr: (v: T) => string): string {
  return ids.map(id => tr(valueOf(field, id).name)).join(', ');
}

/**
 * Where labelers' disagreements are settled. Built for hundreds: filter by field, step
 * through with the keyboard, take one side or the agent's suggestion, or accept the
 * agent's suggestion for everything left.
 */
export function AdjudicationPanel() {
  const {tr} = useLocale();
  const num = useNumber();
  const story = useStory();
  const {rulings, hasAcceptedRest} = story.state;
  const [field, setField] = useState<FieldFilter>('all');
  const [isUndecidedOnly, setIsUndecidedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(CONFLICTS[0].id);
  const detailRef = useRef<HTMLDivElement>(null);

  const isSent = story.isResolved('l-adj');
  const isAwaited = story.awaitedCardId === 'l-adj';
  const decidedListed = CONFLICTS.filter(c => c.id in rulings).length;
  const unlistedTotal = TOTAL - CONFLICTS.length;
  const decided = decidedListed + (hasAcceptedRest ? unlistedTotal : 0);
  const remaining = TOTAL - decided;

  const visible = CONFLICTS.filter(c => (field === 'all' || c.field === field) && (!isUndecidedOnly || !(c.id in rulings) || c.id === selectedId));
  const selected = CONFLICTS.find(c => c.id === selectedId) ?? CONFLICTS[0];
  const position = visible.findIndex(c => c.id === selected.id);

  const decide = (c: Conflict, values: string[]) => {
    if (isSent) return;
    story.rule(c.id, values);
    // Move on to the next undecided disagreement in the current view.
    const order = visible.filter(v => v.id !== c.id && !(v.id in rulings));
    const after = order.find(v => visible.indexOf(v) > visible.indexOf(c)) ?? order[0];
    if (after) setSelectedId(after.id);
  };
  const move = (step: number) => {
    if (visible.length === 0) return;
    const next = visible[(Math.max(0, position) + step + visible.length) % visible.length];
    setSelectedId(next.id);
  };

  // Keyboard: 1 and 2 take a labeler's answer, A takes the suggestion, J and K move.
  const keysRef = useRef({decide, move, selected});
  keysRef.current = {decide, move, selected};
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('[role="radiogroup"]'))) return;
      const {decide, move, selected} = keysRef.current;
      const key = e.key.toLowerCase();
      if (key === '1') decide(selected, selected.mei);
      else if (key === '2') decide(selected, selected.ravi);
      else if (key === 'a') decide(selected, selected.suggestion);
      else if (key === 'j') move(1);
      else if (key === 'k') move(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    detailRef.current?.scrollTo({top: 0});
  }, [selectedId]);

  const fieldCount = (f: FieldFilter) => (f === 'all' ? TOTAL : CONFLICT_TOTALS[f]);
  const ruling = rulings[selected.id];
  const post = POST_BY_ID[selected.postId];
  const fieldMeta = FIELD_BY_ID[selected.field];
  const disputed = [...new Set([...selected.mei, ...selected.ravi])];
  const overrides = CONFLICTS.filter(c => c.id in rulings && !sameAnswer(rulings[c.id], c.suggestion)).length;

  return (
    <div className="page adjudication">
      <div className="adj-toolbar">
        <div className="filter-chips" role="group" aria-label={tr(t('Filter by field', '按字段筛选'))}>
          {(['all', ...FIELDS.map(f => f.id)] as FieldFilter[]).map(f => (
            <button key={f} type="button" className="filter-chip" aria-pressed={field === f} onClick={() => {
                setField(f);
                // Keep the open disagreement in view; otherwise jump to the first one under the new filter.
                if (f !== 'all' && selected.field !== f) setSelectedId(CONFLICTS.find(c => c.field === f)!.id);
              }}>
              {f === 'all' ? tr(t('All fields', '全部字段')) : tr(FIELD_BY_ID[f].name)} <span className="filter-count">{fieldCount(f)}</span>
            </button>
          ))}
          <button type="button" className="filter-chip" aria-pressed={isUndecidedOnly} onClick={() => setIsUndecidedOnly(v => !v)}>
            {tr(t('Undecided only', '只看未裁决'))}
          </button>
        </div>
        <div className="adj-progress">
          <span className="adj-progress-text">
            {tr(t(`${num(decided)} of ${num(TOTAL)} decided`, `已裁决 ${num(decided)} / ${num(TOTAL)}`))}
          </span>
          <ProgressBar label={tr(t('Disagreements decided', '已裁决的分歧'))} isLabelHidden value={(decided / TOTAL) * 100} variant={remaining === 0 ? 'success' : 'accent'} />
        </div>
      </div>

      <div className="adj-grid">
        <div className="adj-list-wrap">
          <ul className="adj-list" aria-label={tr(t('Disagreements', '分歧列表'))}>
            {visible.map(c => {
              const p = POST_BY_ID[c.postId];
              const isDecided = c.id in rulings;
              return (
                <li key={c.id}>
                  <button type="button" className="adj-row" aria-current={c.id === selected.id} onClick={() => setSelectedId(c.id)}>
                    <span className="icon-slot">
                      <Icon
                        icon={isDecided ? CircleCheck : Circle}
                        size="sm"
                        color={isDecided ? 'success' : 'tertiary'}
                        label={tr(isDecided ? t('Decided', '已裁决') : t('Undecided', '未裁决'))}
                      />
                    </span>
                    <span className="adj-row-text">
                      <span className="adj-row-title" dir="auto" lang={p.lang}>
                        {p.title}
                      </span>
                      <span className="adj-row-meta">
                        {tr(FIELD_BY_ID[c.field].name)} · {shortAnswer(c.field, c.mei, tr)} / {shortAnswer(c.field, c.ravi, tr)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && <li className="adj-empty">{tr(t('Nothing left to decide here.', '这里没有待裁决的了。'))}</li>}
          </ul>
          <div className="adj-list-note">
            {tr(
              t(
                `${CONFLICTS.length} shown in the demo · ${num(field === 'all' ? unlistedTotal : UNLISTED[field])} more ${hasAcceptedRest ? 'settled by the agent’s suggestion' : 'work the same way'}`,
                `演示展示 ${CONFLICTS.length} 条 · 另有 ${num(field === 'all' ? unlistedTotal : UNLISTED[field])} 条${hasAcceptedRest ? '已按智能体建议裁决' : '操作相同'}`,
              ),
            )}
          </div>
        </div>

        <div className="adj-detail" ref={detailRef}>
          <div className="adj-detail-head">
            <span className="adj-field">
              {tr(fieldMeta.name)} <code>{fieldMeta.id}</code>
            </span>
            <span className="adj-position">
              {ruling !== undefined && (
                <span className="adj-decided">
                  <Icon icon={CircleCheck} size="sm" color="success" />
                  {tr(t('Decided: ', '已裁决：'))}
                  {shortAnswer(selected.field, ruling, tr)}
                </span>
              )}
              {position >= 0 && tr(t(`${position + 1} of ${visible.length}`, `第 ${position + 1} / ${visible.length} 条`))}
            </span>
          </div>
          <div className="adj-answers">
            {[
              {who: 'Mei', key: '1', values: selected.mei},
              {who: 'Ravi', key: '2', values: selected.ravi},
            ].map(side => {
              const isPicked = ruling !== undefined && sameAnswer(ruling, side.values);
              return (
                <div key={side.who} className={isPicked ? 'adj-answer adj-answer-picked' : 'adj-answer'}>
                  <div className="adj-answer-who">{side.who}</div>
                  <ValueList field={selected.field} ids={side.values} />
                  <Button
                    label={tr(t(`Use ${side.who}’s`, `采用 ${side.who} 的`))}
                    variant="secondary"
                    size="sm"
                    isDisabled={isSent}
                    endContent={<Kbd keys={side.key} />}
                    onClick={() => decide(selected, side.values)}
                  />
                </div>
              );
            })}
          <div className={ruling !== undefined && sameAnswer(ruling, selected.suggestion) ? 'adj-suggestion adj-answer-picked' : 'adj-suggestion'}>
            <IconLine className="adj-suggestion-head" icon={<Icon icon={Sparkles} size="sm" color="inherit" />}>
              {tr(t('Agent’s suggestion', '智能体的建议'))}
            </IconLine>
            <ValueList field={selected.field} ids={selected.suggestion} />
            <p className="adj-reason">{tr(selected.reason)}</p>
            <div>
              <Button
                label={tr(t('Accept suggestion', '接受建议'))}
                variant="primary"
                size="sm"
                isDisabled={isSent}
                endContent={<Kbd keys="A" />}
                onClick={() => decide(selected, selected.suggestion)}
              />
            </div>
          </div>
          </div>

          <div className="adj-definitions">
            {disputed.map(id => {
              const v = valueOf(selected.field, id);
              return (
                <div key={id} className="adj-definition">
                  <ValueList field={selected.field} ids={id} />
                  <span>{v.definition ? tr(v.definition) : tr(t('No definition; topics are named only.', '话题只有名称，没有定义。'))}</span>
                </div>
              );
            })}
          </div>

          <div className="card-inset adj-post">
            <PostPreview post={post} />
          </div>
        </div>
      </div>

      <footer className="adj-footer">
        <div className="adj-keys" aria-label={tr(t('Keyboard shortcuts', '键盘快捷键'))}>
          <span>
            <Kbd keys="1" /> <Kbd keys="2" /> {tr(t('take a side', '采用一方'))}
          </span>
          <span>
            <Kbd keys="A" /> {tr(t('accept suggestion', '接受建议'))}
          </span>
          <span>
            <Kbd keys="J" /> <Kbd keys="K" /> {tr(t('next / previous', '下一条 / 上一条'))}
          </span>
        </div>
        <div className="card-actions">
          {isSent ? (
            <IconLine className="resolved-note" icon={<Icon icon={CircleCheck} size="sm" color="success" />}>
              {tr(
                t(
                  `Sent to the agent. You overrode its suggestion on ${overrides} of ${decidedListed} you decided yourself.`,
                  `已交给智能体。你亲自裁决的 ${decidedListed} 条里，有 ${overrides} 条没有采用它的建议。`,
                ),
              )}
            </IconLine>
          ) : (
            <>
              {remaining > 0 && (
                <Button
                  label={tr(t(`Accept suggestions for the other ${num(remaining)}`, `其余 ${num(remaining)} 条接受建议`))}
                  variant="secondary"
                  onClick={story.acceptRest}
                />
              )}
              <Button
                label={tr(t('Send to the agent', '提交给智能体'))}
                variant="primary"
                isDisabled={remaining > 0 || !isAwaited}
                onClick={() => {
                  story.resolve('l-adj', 'done');
                  story.closePanel();
                }}
              />
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

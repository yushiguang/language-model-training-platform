'use client';

import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {CircleCheck, CircleHelp, CircleX, ClipboardCheck, Lightbulb, ListChecks, Loader, Sparkles} from 'lucide-react';
import {measureRows} from '@/components/measures';
import {PostPreview} from '@/components/PostPreview';
import {PANEL_META} from '@/components/panels/panelMeta';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {POST_BY_ID} from '@/mock/posts';
import {choiceLabel, useStory} from '@/story/StoryProvider';
import type {Card, Check, PanelId} from '@/story/types';
import {CardFrame, FactRows, IconLine} from './CardFrame';

function useValue() {
  const {tr} = useLocale();
  return (v: string | T) => (typeof v === 'string' ? v : tr(v));
}

function OpenPanelButton({panel}: {panel: PanelId}) {
  const {tr} = useLocale();
  const {openPanel, isPanelAvailable} = useStory();
  const kind = PANEL_META[panel].kind;
  return (
    <Button
      label={tr(t(`View ${kind.en.toLowerCase()}`, `查看${kind.zh}`))}
      variant="secondary"
      size="sm"
      icon={<Icon icon={PANEL_META[panel].icon} size="sm" />}
      isDisabled={!isPanelAvailable(panel)}
      onClick={() => openPanel(panel)}
    />
  );
}

/** The user's answer, once given: a quiet line in place of the buttons. */
function ResolvedNote({card, label}: {card: Card; label?: T}) {
  const {tr} = useLocale();
  const {state} = useStory();
  const choice = state.choices[card.id];
  const text = label ?? (choice ? choiceLabel(card, choice) : null);
  if (!text) return null;
  return (
    <IconLine className="resolved-note" icon={<Icon icon={CircleCheck} size="sm" color="success" />}>
      {tr(text)}
    </IconLine>
  );
}

/** Pass/fail checks, each with an icon and a word, so the result never rests on color. */
export function CheckList({checks}: {checks: Check[]}) {
  const {tr} = useLocale();
  const value = useValue();
  return (
    <ul className="checks">
      {checks.map(c => (
        <li key={c.label.en}>
          <span className="icon-slot">
            <Icon icon={c.pass ? CircleCheck : CircleX} size="sm" color={c.pass ? 'success' : 'error'} label={tr(c.pass ? t('Pass', '通过') : t('Fail', '未通过'))} />
          </span>
          <span>{tr(c.label)}</span>
          <span className="checks-value">{value(c.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Renders any agent card. Read-only cards (other models' history) show their state without actions. */
export function AgentCard({card, isReadOnly = false}: {card: Card; isReadOnly?: boolean}) {
  const {tr} = useLocale();
  const story = useStory();
  const value = useValue();
  const isResolved = story.isResolved(card.id);
  const isActive = !isReadOnly && story.awaitedCardId === card.id;

  switch (card.type) {
    case 'question': {
      const post = card.postId ? POST_BY_ID[card.postId] : null;
      const recommended = card.options.find(o => o.id === card.recommended)!;
      return (
        <CardFrame icon={CircleHelp} kind={tr(t('Question for you', '需要你决定'))} title={tr(card.title)} isActive={isActive}>
          {card.body && <p className="agent-card-body">{tr(card.body)}</p>}
          {post && (
            <div className="card-inset">
              <PostPreview post={post} />
            </div>
          )}
          {isResolved ? (
            <ResolvedNote card={card} />
          ) : (
            <>
              <div className="card-actions">
                {card.options.map(o => (
                  <Button
                    key={o.id}
                    label={tr(o.label)}
                    variant={o.id === card.recommended ? 'primary' : 'secondary'}
                    isDisabled={!isActive}
                    onClick={() => story.resolve(card.id, o.id)}
                  />
                ))}
              </div>
              <IconLine className="card-hint" icon={<Icon icon={Sparkles} size="sm" color="inherit" />}>
                {tr(t('Recommended: ', '推荐：'))}
                {tr(recommended.label)}. {tr(card.reason)}
              </IconLine>
            </>
          )}
        </CardFrame>
      );
    }
    case 'approval':
      return (
        <CardFrame icon={ClipboardCheck} kind={tr(t('Approval needed', '需要你批准'))} title={tr(card.title)} isActive={isActive}>
          {card.rows && <FactRows rows={card.rows.map(r => ({label: tr(r.label), value: value(r.value)}))} />}
          {card.checks && <CheckList checks={card.checks} />}
          <div className="card-actions">
            {isResolved ? (
              <ResolvedNote card={card} />
            ) : (
              !isReadOnly && <Button label={tr(card.approve)} variant="primary" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'approve')} />
            )}
            {card.panel && <OpenPanelButton panel={card.panel} />}
          </div>
        </CardFrame>
      );
    case 'progress':
      return <ProgressCard card={card} isReadOnly={isReadOnly} />;
    case 'result':
      return (
        <CardFrame icon={Sparkles} kind={tr(t('Result', '结果'))} title={tr(card.title)}>
          <div className="stat-grid">
            {card.stats.map(s => (
              <div key={s.label.en} className="stat">
                <div className="stat-value">{value(s.value)}</div>
                <div className="stat-label">{tr(s.label)}</div>
              </div>
            ))}
          </div>
          {card.note && <p className="agent-card-body">{tr(card.note)}</p>}
          {card.panel && (
            <div className="card-actions">
              <OpenPanelButton panel={card.panel} />
            </div>
          )}
        </CardFrame>
      );
    case 'advice':
      return (
        <CardFrame icon={Lightbulb} kind={tr(t('Advice · prompt change', '建议 · 修改 Prompt'))} title={tr(card.title)} isActive={isActive}>
          <p className="agent-card-body">{tr(card.diagnosis)}</p>
          <PromptDiff removed={card.removed} added={card.added} label={tr(t('Proposed prompt change', '建议的 Prompt 修改'))} />
          <div className="measured">
            <div className="measured-title">{tr(t('Measured on the 600-post eval split before proposing', '提出前已在 600 条评估集上实测'))}</div>
            <FactRows rows={measureRows(card.measures, card.from, card.to).map(r => ({label: tr(r.label), value: r.value}))} />
          </div>
          <div className="card-actions">
            {isResolved ? (
              <ResolvedNote card={card} label={t(`Adopted as prompt ${card.to}`, `已采纳，生成 Prompt ${card.to}`)} />
            ) : (
              <Button label={tr(t('Adopt', '采纳'))} variant="primary" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'adopt')} />
            )}
            <OpenPanelButton panel="evalReport" />
          </div>
        </CardFrame>
      );
    case 'link':
      return (
        <CardFrame icon={ListChecks} kind={tr(t('Task for you', '你的任务'))} title={tr(card.title)} isActive={isActive}>
          <p className="agent-card-body">{tr(card.description)}</p>
          <div className="card-actions">
            {isResolved ? (
              <>
                <ResolvedNote card={card} />
                <OpenPanelButton panel={card.panel} />
              </>
            ) : (
              <>
                <Button
                  label={tr(card.cta)}
                  variant="primary"
                  icon={<Icon icon={PANEL_META[card.panel].icon} size="sm" />}
                  isDisabled={!isActive}
                  onClick={() => story.openPanel(card.panel)}
                />
                <Button label={tr(card.skip)} variant="ghost" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'skip')} />
              </>
            )}
          </div>
        </CardFrame>
      );
  }
}

/** A prompt change as removed and added lines. */
export function PromptDiff({removed, added, label}: {removed: string[]; added: string[]; label: string}) {
  return (
    <pre className="diff" aria-label={label}>
      {removed.map(line => (
        <div key={line} className="diff-removed">
          <span className="diff-sign">−</span>
          {line}
        </div>
      ))}
      {added.map(line => (
        <div key={line} className="diff-added">
          <span className="diff-sign">+</span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function ProgressCard({card, isReadOnly}: {card: Extract<Card, {type: 'progress'}>; isReadOnly: boolean}) {
  const {tr, locale} = useLocale();
  const story = useStory();
  const isDone = story.isResolved(card.id);
  const start = story.state.progressStart[card.id];
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (isReadOnly || isDone) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [isReadOnly, isDone]);

  let fraction: number;
  if (card.frozenAt !== undefined) fraction = card.frozenAt;
  else if (isDone) fraction = 1;
  else fraction = start === undefined ? 0 : Math.min(0.99, (now - start) / card.durationMs);

  const done = Math.round(card.total * fraction);
  const numberFormat = new Intl.NumberFormat(locale);
  const isRunning = fraction < 1;
  return (
    <CardFrame icon={isRunning ? Loader : CircleCheck} kind={tr(isRunning ? t('Running', '运行中') : t('Finished', '已完成'))} title={tr(card.title)}>
      <ProgressBar label={tr(card.title)} isLabelHidden value={fraction * 100} variant={isRunning ? 'accent' : 'success'} />
      <div className="progress-count">
        {numberFormat.format(done)} / {numberFormat.format(card.total)} {tr(card.unit)}
      </div>
    </CardFrame>
  );
}

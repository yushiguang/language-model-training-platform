'use client';

import {useEffect, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Text} from '@astryxdesign/core/Text';
import {CircleCheck, CircleHelp, ClipboardCheck, ExternalLink, Lightbulb, Loader, Sparkles, Tags} from 'lucide-react';
import {LabelChip} from '@/components/LabelChip';
import {PostPreview} from '@/components/PostPreview';
import {PANEL_META} from '@/components/panels/panelMeta';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {macroF1, invalidRate, PROMPT_RUNS, scores} from '@/mock/metrics';
import {POST_BY_ID, DISAGREEMENT} from '@/mock/posts';
import {choiceLabel, useStory} from '@/story/StoryProvider';
import type {Card, PanelId} from '@/story/types';
import {CardFrame, FactRows} from './CardFrame';

const fmt2 = (v: number) => v.toFixed(2);
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

function useValue() {
  const {tr} = useLocale();
  return (v: string | T) => (typeof v === 'string' ? v : tr(v));
}

function OpenPanelButton({panel, label}: {panel: PanelId; label?: T}) {
  const {tr} = useLocale();
  const {openPanel, isPanelAvailable} = useStory();
  return (
    <Button
      label={tr(label ?? t(`Open ${PANEL_META[panel].title.en.toLowerCase()}`, `打开${PANEL_META[panel].title.zh}`))}
      variant="ghost"
      size="sm"
      icon={<Icon icon={ExternalLink} size="sm" />}
      isDisabled={!isPanelAvailable(panel)}
      onClick={() => openPanel(panel)}
    />
  );
}

function ResolvedNote({card}: {card: Card}) {
  const {tr} = useLocale();
  const {state} = useStory();
  const choice = state.choices[card.id];
  const label = choice ? choiceLabel(card, choice) : null;
  if (!label) return null;
  return <Badge variant="success" icon={<Icon icon={CircleCheck} size="sm" />} label={tr(label)} />;
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
      return (
        <CardFrame icon={CircleHelp} kind={tr(t('Question for you', '需要你决定'))} title={tr(card.title)} isActive={isActive}>
          {card.body && <Text color="secondary">{tr(card.body)}</Text>}
          {post && (
            <div className="card-inset">
              <PostPreview post={post} />
            </div>
          )}
          {card.showVotes && (
            <FactRows
              rows={DISAGREEMENT.votes.map(v => ({
                label: v.labeler,
                value: <LabelChip id={v.label} />,
              }))}
            />
          )}
          {isResolved ? (
            <div>
              <ResolvedNote card={card} />
            </div>
          ) : (
            <VStack gap={2}>
              <HStack gap={2} wrap="wrap">
                {card.options.map(o => (
                  <Button
                    key={o.id}
                    label={tr(o.label)}
                    variant={o.id === card.recommended ? 'primary' : 'secondary'}
                    isDisabled={!isActive}
                    onClick={() => story.resolve(card.id, o.id)}
                  />
                ))}
              </HStack>
              <HStack gap={1} align="start">
                <Icon icon={Sparkles} size="sm" color="accent" />
                <Text type="supporting" color="secondary">
                  {tr(t('Recommended: ', '推荐：'))}
                  {tr(card.options.find(o => o.id === card.recommended)!.label)}. {tr(card.reason)}
                </Text>
              </HStack>
            </VStack>
          )}
        </CardFrame>
      );
    }
    case 'approval':
      return (
        <CardFrame icon={ClipboardCheck} kind={tr(t('Approval needed', '需要你批准'))} title={tr(card.title)} isActive={isActive}>
          {card.rows && <FactRows rows={card.rows.map(r => ({label: tr(r.label), value: value(r.value)}))} />}
          {card.checks && (
            <ul className="checks">
              {card.checks.map(c => (
                <li key={c.label.en}>
                  <Icon icon={CircleCheck} size="sm" className={c.pass ? 'check-pass' : 'check-fail'} />
                  <span>{tr(c.label)}</span>
                  <span className="checks-value">{value(c.value)}</span>
                </li>
              ))}
            </ul>
          )}
          <HStack gap={2} wrap="wrap" align="center">
            {isResolved ? (
              <ResolvedNote card={card} />
            ) : (
              !isReadOnly && <Button label={tr(card.approve)} variant="primary" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'approve')} />
            )}
            {card.panel && <OpenPanelButton panel={card.panel} />}
          </HStack>
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
          {card.note && <Text color="secondary">{tr(card.note)}</Text>}
          {card.panel && (
            <div>
              <OpenPanelButton panel={card.panel} />
            </div>
          )}
        </CardFrame>
      );
    case 'advice': {
      const before = PROMPT_RUNS[card.from];
      const after = PROMPT_RUNS[card.to];
      const disc = (run: typeof before) => scores(run).find(s => s.label === 'discussion')!.f1;
      return (
        <CardFrame icon={Lightbulb} kind={tr(t('Advice · prompt change', '建议 · 修改 Prompt'))} title={tr(card.title)} isActive={isActive}>
          <Text color="secondary">{tr(card.diagnosis)}</Text>
          <pre className="diff" aria-label={tr(t('Proposed prompt change', '建议的 Prompt 修改'))}>
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
          <div>
            <Text type="supporting" color="secondary" weight="medium">
              {tr(t('Measured on the 600-post eval split before proposing', '提出前已在 600 条评估集上实测'))}
            </Text>
            <FactRows
              rows={[
                {label: tr(t('Macro-F1', '宏平均 F1')), value: `${fmt2(macroF1(before))} → ${fmt2(macroF1(after))}`},
                {label: tr(t('Discussion F1', '讨论 F1')), value: `${fmt2(disc(before))} → ${fmt2(disc(after))}`},
                {label: tr(t('Invalid outputs', '无效输出')), value: `${pct1(invalidRate(before))} → ${pct1(invalidRate(after))}`},
              ]}
            />
          </div>
          <HStack gap={2} wrap="wrap" align="center">
            {isResolved ? (
              <Badge variant="success" icon={<Icon icon={CircleCheck} size="sm" />} label={tr(t(`Adopted as prompt ${card.to}`, `已采纳，生成 Prompt ${card.to}`))} />
            ) : (
              <Button label={tr(t('Adopt', '采纳'))} variant="primary" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'adopt')} />
            )}
            <OpenPanelButton panel="evalReport" />
          </HStack>
        </CardFrame>
      );
    }
    case 'link':
      return (
        <CardFrame icon={Tags} kind={tr(t('Task for you', '你的任务'))} title={tr(card.title)} isActive={isActive}>
          <Text color="secondary">{tr(card.description)}</Text>
          {isResolved ? (
            <div>
              <ResolvedNote card={card} />
            </div>
          ) : (
            <HStack gap={2} wrap="wrap">
              <Button label={tr(card.cta)} variant="primary" isDisabled={!isActive} onClick={() => story.openPanel(card.panel)} />
              <Button label={tr(card.skip)} variant="ghost" isDisabled={!isActive} onClick={() => story.resolve(card.id, 'skip')} />
            </HStack>
          )}
        </CardFrame>
      );
  }
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
      <ProgressBar
        label={tr(card.title)}
        isLabelHidden
        value={fraction * 100}
        variant={isRunning ? 'accent' : 'success'}
      />
      <Text type="supporting" color="secondary" hasTabularNumbers>
        {numberFormat.format(done)} / {numberFormat.format(card.total)} {tr(card.unit)}
      </Text>
    </CardFrame>
  );
}

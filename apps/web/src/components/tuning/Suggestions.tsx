'use client';

import {useEffect, useState, type ReactNode} from 'react';
import type {MismatchList} from '@yushiguang/sprint-contracts';
import {aiSuggestion, compilePrompt, withNewestReports, type SuggestionAction} from '@yushiguang/sprint-domain';
import {SparklesIcon} from '@heroicons/react/24/outline';
import {Badge, Button, Card, Heading, HStack, Icon, Text, VStack} from '@/ui/astryx';
import {action, reportFailure, useCopy} from '@/ui';
import {useGo} from '@/components/nav';
import {useProject} from '@/components/ProjectContext';
import {useOpenAskAi} from '@/components/Shell';
import {approveNode, improveWithAi, mismatches, track, type ProjectState} from '@/backend-api';
import {currentLocale, t, tm} from '@/i18n';
import {flatLabels} from './items';

/** The Suggestions title: a sparkle left of the word (round 11). */
function Title() {
  return (
    <HStack gap={2} vAlign="center" minHeight={32}>
      <Icon icon={SparklesIcon} size="md" color="accent" />
      <Heading level={2}>{t('Suggestions')}</Heading>
    </HStack>
  );
}

function Shell({children}: {children: ReactNode}) {
  return (
    <section aria-label={t('Suggestions')}>
      <VStack gap={4}>
        <Title />
        {children}
      </VStack>
    </section>
  );
}

/** One suggestion card: a bold headline, a short text, its buttons. */
function Item({title, text, actions}: {title: string; text: string; actions?: ReactNode}) {
  return (
    <Card>
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="body" weight="semibold">
            {title}
          </Text>
          <Text type="body" color="secondary">
            {text}
          </Text>
        </VStack>
        {actions && (
          <HStack gap={2} wrap="wrap">
            {actions}
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

/** Before scores (round 18): only a way to Gold Labels, since suggestions read scores. */
export function SuggestionsWaiting({state}: {state: ProjectState}) {
  const {href} = useProject();
  const sc = state.scoring;
  const text = sc.ranges
    ? t('Scores and suggestions start when every label set is done. {done} of {n} done.', {done: sc.labelSetsDone, n: sc.labelSets})
    : t('Scores and suggestions start once examples have a person’s label.');
  return (
    <Shell>
      <Item title={sc.ranges ? t('Finish the label sets') : t('Add gold labels')} text={text} actions={<Button label={t('Open Gold Labels')} variant="secondary" size="sm" href={href('/gold')} />} />
    </Shell>
  );
}

/** While the selected version is labeling, queued or failed: suggestions follow its scores. */
export function SuggestionsLater() {
  return (
    <Shell>
      <Card variant="muted">
        <Text type="body" color="secondary">
          {t('The AI evaluates this version once scoring is done.')}
        </Text>
      </Card>
    </Shell>
  );
}

/**
 * Suggestions for a scored version. Until the AI evaluates each version, the card is the one code
 * picks from the project's records (`aiSuggestion`, spec 1.0.0, 6.3), with its buttons; Dismiss
 * hides it for this visit.
 */
export function Suggestions({state, versionId, onOptimise, onSwitch}: {state: ProjectState; versionId: string; onOptimise: () => void; onSwitch: (versionId: string) => void}) {
  const {href} = useProject();
  const go = useGo();
  const openAskAi = useOpenAskAi();
  const [copied, copy] = useCopy();
  const [mm, setMm] = useState<MismatchList | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const scored = state.reports.some(r => !r.archivedNow);
  useEffect(() => {
    let live = true;
    if (scored) void mismatches(state.project.id).then(m => live && setMm(m));
    return () => {
      live = false;
    };
  }, [state.project.id, scored, state.contextId, state.reports.length, state.optimisation[0]?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = aiSuggestion(withNewestReports(state), {selectedId: versionId, mismatches: mm ? {open: mm.items.length, wrongEverywhere: mm.wrongEverywhere, reviewedAll: mm.reviewedAll} : null});
  const key = a ? `${a.template}|${a.versionId}|${a.title}` : '';
  if (!a || hidden.has(key)) {
    return (
      <Shell>
        <Card variant="muted">
          <Text type="body" color="secondary">
            {t('No suggestions for this version.')}
          </Text>
        </Card>
      </Shell>
    );
  }
  const target = a.versionId ? state.versions.find(v => v.id === a.versionId) : undefined;
  const finished = state.project.approvedNodes.includes('prompt');
  const improve = (id: string) => {
    openAskAi();
    improveWithAi(state.project.id, id, currentLocale()).catch(e => reportFailure(e, t('Fix in Prompt Design'), () => void improve(id)));
    return go(href('/prompt-design', {v: id}));
  };
  const button = (act: SuggestionAction, main: boolean): ReactNode => {
    const variant = main ? ('primary' as const) : ('secondary' as const);
    switch (act) {
      case 'go_gold':
        return <Button key={act} label={t('Open Gold Labels')} variant={variant} size="sm" href={href('/gold')} />;
      case 'add_examples':
        return <Button key={act} label={t('Add examples')} variant={variant} size="sm" href={href('/dataset')} />;
      case 'review_labels':
        return <Button key={act} label={t('Review labels')} variant={variant} size="sm" href={href('/gold/set', {tab: 'mismatches'})} />;
      case 'auto_optimise':
        return <Button key={act} label={t('Optimise')} variant={'ai' as never} size="sm" onClick={onOptimise} />;
      case 'improve':
        return <Button key={act} label={t('Fix in Prompt Design')} variant={'ai' as never} size="sm" clickAction={action(t('Fix in Prompt Design'), () => improve(a.versionId!))} />;
      case 'switch':
        return <Button key={act} label={target ? t('Switch to {version}', {version: flatLabels(`v${target.major}`)}) : t('Switch to it')} variant={variant} size="sm" onClick={() => a.versionId && onSwitch(a.versionId)} />;
      case 'copy_prompt':
        return (
          <Button
            key={act}
            label={copied ? t('Copied') : t('Copy prompt')}
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!target) return;
              copy(compilePrompt(target.structured));
              track('prompt_copied', {from: 'suggestion'});
            }}
          />
        );
      case 'finish':
        return finished ? (
          <Badge key={act} label={t('Finished')} variant="success" />
        ) : (
          <Button key={act} label={t('Finish')} variant={variant} size="sm" tooltip={t('Marks this project as finished. You can still come back and change it.')} clickAction={action(t('Finish'), () => approveNode(state.project.id, 'prompt'))} />
        );
    }
  };
  // The main action goes first (round 13: "Fix in Prompt Design", then Dismiss).
  const acts = [...a.actions].reverse();
  return (
    <Shell>
      <Item
        title={flatLabels(tm(a.msg.title, a.title))}
        text={flatLabels(tm(a.msg.text, a.text))}
        actions={
          <>
            {acts.map((x, i) => button(x, i === 0))}
            <Button label={t('Dismiss')} variant="ghost" size="sm" onClick={() => setHidden(new Set(hidden).add(key))} />
          </>
        }
      />
    </Shell>
  );
}

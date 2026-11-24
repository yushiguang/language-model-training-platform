'use client';

import {useEffect, useRef, useState} from 'react';
import type {OptimisationRun} from '@yushiguang/sprint-contracts';
import {dryRunSize, stepMsg, systemConfig} from '@yushiguang/sprint-domain';
import {PlayIcon} from '@heroicons/react/24/outline';
import {Button, Card, Grid, HStack, Icon, ProgressBar, Spinner, Text, TextInput, VStack} from '@/ui/astryx';
import {SectionTitle} from '@/components/shell/Page';
import {FormDialog} from '@/components/shell/dialogs';
import {action} from '@/ui';
import {startOptimiser, type ProjectState} from '@/backend-api';
import {t, tm} from '@/i18n';
import {Change, pct} from './VersionRow';
import {flatLabels, reportOf} from './items';

const flat = (s: ProjectState, id: string | null) => {
  const v = id ? s.versions.find(x => x.id === id) : undefined;
  return v ? `v${v.major}` : null;
};

/**
 * Optimise (wireframes v346, W-PromptTuning-Optimise): starts from the selected version, Max rounds
 * prefilled. Start stays busy until the run exists; then the dialog closes on the run's card.
 */
export function OptimiseDialog({state, versionId, label, score, onClose, onStarted}: {state: ProjectState; versionId: string; label: string; score: number; onClose: () => void; onStarted: (major: number | null) => void}) {
  const cfg = systemConfig().optimiser;
  const [rounds, setRounds] = useState(String(cfg.defaultMaxRounds));
  const n = Math.max(1, Math.min(cfg.maxRoundsCap, Math.round(Number(rounds)) || cfg.defaultMaxRounds));
  // The start call lasts the whole run: Start is done once the run shows in the project.
  const runId = state.optimisation[0]?.id;
  const was = useRef(runId);
  const pending = useRef<(() => void) | null>(null);
  const done = () => {
    if (!pending.current) return;
    pending.current();
    pending.current = null;
    onStarted(state.optimisation[0]?.major ?? null);
  };
  useEffect(() => {
    if (runId !== was.current) done();
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = resolve;
      startOptimiser({projectId: state.project.id, maxRounds: n, startVersionId: versionId}).then(done, e => {
        pending.current = null;
        reject(e);
      });
    });
  return (
    <FormDialog
      title={t('Optimise {version}', {version: label})}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Start')} variant={'ai' as never} icon={<Icon icon={PlayIcon} size="sm" />} clickAction={action(t('The Optimiser could not start'), start)} />
        </>
      }
    >
      <VStack gap={5}>
        <Text type="body">{t('Starts from {version} ({score}). It shows as a new version at once and keeps the best result it finds.', {version: label, score: pct(score)})}</Text>
        <TextInput label={t('Max rounds')} inputMode="numeric" value={rounds} onChange={v => setRounds(v.replace(/\D/g, '').slice(0, 2))} description={t('Each round tries changes to the prompt')} />
      </VStack>
    </FormDialog>
  );
}

/** What the run does now, in one line (the step of its current round). */
function NowLine({state, run}: {state: ProjectState; run: OptimisationRun}) {
  if (run.queue) return <Text type="body" color="secondary">{t('Waiting for the model to be free.')}</Text>;
  const half = state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && !!state.gold[e.id]).length;
  const line = tm(stepMsg(run.step, flat(state, run.stepVersionId), dryRunSize(half), flat(state, run.history.at(-1)?.parentId ?? null)));
  return (
    <HStack gap={2} vAlign="center">
      <Spinner size="sm" aria-label={t('Running')} />
      <Text type="body" color="secondary">
        {flatLabels(line)}
      </Text>
    </HStack>
  );
}

/**
 * Progress of a running Optimiser (W-PromptTuning-Run): the round against the most rounds, how many
 * tries it made and dropped, the best score so far against the version it started from.
 */
export function OptimiserProgress({state, run}: {state: ProjectState; run: OptimisationRun}) {
  const start = reportOf(state, run.startVersionId)?.metrics.macroF1 ?? null;
  const kept = run.history.filter(h => h.outcome === 'kept' && h.score != null).map(h => h.score!);
  const best = Math.max(start ?? -1, ...kept);
  const tries = run.history.filter(h => h.versionId).length;
  const dropped = run.history.filter(h => h.outcome === 'dropped').length;
  const round = Math.max(1, run.round);
  return (
    <section aria-label={t('Progress')}>
      <VStack gap={4}>
        <SectionTitle title={t('Progress')} />
        <Card>
          <VStack gap={5}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center" hAlign="between">
                <Text type="body">{t('Round {n} of {max}', {n: round, max: run.maxRounds})}</Text>
                <Text type="supporting" color="secondary">
                  {t('{tries} tries · {dropped} dropped', {tries, dropped})}
                </Text>
              </HStack>
              <ProgressBar label={t('Rounds')} isLabelHidden value={round - 1} max={run.maxRounds} variant="neutral" />
            </VStack>
            <Grid columns={3} gap={4}>
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  {t('Best so far')}
                </Text>
                <HStack gap={3} vAlign="center">
                  <span className="sp-pt-score">{best >= 0 ? pct(best) : '–'}</span>
                  <Change by={best >= 0 && start != null ? best - start : null} />
                </HStack>
              </VStack>
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  {t('Started from')}
                </Text>
                <span className="sp-pt-score">{flat(state, run.startVersionId) ?? '–'}</span>
              </VStack>
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  {t('Max rounds')}
                </Text>
                <span className="sp-pt-score">{run.maxRounds}</span>
              </VStack>
            </Grid>
            <NowLine state={state} run={run} />
          </VStack>
        </Card>
      </VStack>
    </section>
  );
}

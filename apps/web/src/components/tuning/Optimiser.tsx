'use client';

import {useEffect, useRef, useState} from 'react';
import type {OptimisationRun, OptimiserRound} from '@yushiguang/sprint-contracts';
import {dryRunSize, stepMsg, systemConfig} from '@yushiguang/sprint-domain';
import {CheckCircleIcon, PlayIcon, StopCircleIcon, XCircleIcon} from '@heroicons/react/24/outline';
import {Banner, Button, Card, Divider, Grid, HStack, Icon, ProgressBar, Spinner, StackItem, Text, TextInput, VStack} from '@/ui/astryx';
import {SectionTitle} from '@/components/shell/Page';
import {FormDialog} from '@/components/shell/dialogs';
import {action, timeOfDay} from '@/ui';
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
export function OptimiseDialog({state, versionId, label, score, onClose, onStarted}: {state: ProjectState; versionId: string; label: string; score: number; onClose: () => void; onStarted: (runId: string | null) => void}) {
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
    onStarted(state.optimisation[0]?.id ?? null);
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

/** What the run does now, in one line (the step of its current round), or why it waits. */
function NowLine({state, run}: {state: ProjectState; run: OptimisationRun}) {
  if (run.state === 'failed')
    return <Banner status="error" title={t('The Optimiser stopped with an error')} description={`${run.error ? `${flatLabels(run.error)} ` : ''}${t('Retry goes on from where it stopped.')}`} />;
  if (run.state === 'paused' && !run.queue)
    return (
      <Text type="body" color="secondary">
        {t('Paused. Resume goes on from where it stopped.')}
      </Text>
    );
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
 * Progress of an Optimiser run (W-PromptTuning-Run): the round against the most rounds, how many
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
                  {tries === 1 ? t('1 try · {dropped} dropped', {dropped}) : t('{tries} tries · {dropped} dropped', {tries, dropped})}
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

/** A try that ended without being kept: hidden until "Show dropped". */
const isDropped = (r: OptimiserRound) => r.outcome === 'dropped' || r.outcome === 'checks' || r.outcome === 'repeat';

const ENDED: Partial<Record<OptimiserRound['outcome'], string>> = {
  dropped: 'Dropped after the dry run',
  checks: 'Failed the checks',
  repeat: 'Same as an earlier try',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** One try: its number and change on the left; its score, or where it stands, on the right. */
function TryLine({r, n}: {r: OptimiserRound; n: number}) {
  const icon =
    r.outcome === 'running' ? (
      <Spinner size="sm" aria-label={t('Running')} />
    ) : r.outcome === 'kept' ? (
      <Icon icon={CheckCircleIcon} size="sm" color="success" />
    ) : r.outcome === 'stopped' ? (
      <Icon icon={StopCircleIcon} size="sm" color="secondary" />
    ) : (
      <Icon icon={XCircleIcon} size="sm" color={r.outcome === 'failed' ? 'error' : 'secondary'} />
    );
  const end =
    r.outcome === 'kept' && r.score != null ? (
      <span className="sp-pt-num">{pct(r.score)}</span>
    ) : r.outcome === 'running' ? (
      <Text type="body" color="secondary">
        {r.versionId ? t('Scoring…') : t('Writing…')}
      </Text>
    ) : (
      <Text type="body" color="secondary">
        {t(ENDED[r.outcome] ?? '')}
      </Text>
    );
  return (
    <HStack gap={3} vAlign="center" hAlign="between">
      <StackItem size="fill">
        <HStack gap={3} vAlign="center">
          {icon}
          <span className="sp-pt-try">{`${t('Try {n}', {n})} · ${r.change || t('Writing a change')}`}</span>
        </HStack>
      </StackItem>
      <span className="sp-pt-nowrap">{end}</span>
    </HStack>
  );
}

/**
 * Rounds (W-PromptTuning-Run): the tries of each round, newest round first, numbered across the
 * run. Tries the run dropped stay behind "Show dropped".
 */
export function OptimiserRounds({run}: {run: OptimisationRun}) {
  const [showDropped, setShowDropped] = useState(false);
  const numbered = run.history.map((r, i) => ({r, n: i + 1}));
  const dropped = numbered.filter(x => isDropped(x.r)).length;
  const rounds = [...new Set(numbered.map(x => x.r.round))]
    .sort((a, b) => b - a)
    .map(round => ({round, tries: numbered.filter(x => x.r.round === round && (showDropped || !isDropped(x.r))).reverse()}))
    .filter(x => x.tries.length);
  return (
    <section aria-label={t('Rounds')}>
      <VStack gap={4}>
        <SectionTitle
          title={t('Rounds')}
          action={dropped ? <Button label={showDropped ? t('Hide dropped') : t('Show dropped ({n})', {n: dropped})} variant="ghost" size="sm" onClick={() => setShowDropped(!showDropped)} /> : undefined}
        />
        <Card>
          {rounds.length ? (
            <VStack gap={5}>
              {rounds.map((x, i) => (
                <VStack gap={5} key={x.round}>
                  {i > 0 && <Divider />}
                  <VStack gap={3}>
                    <Text type="label" color="secondary">
                      {t('Round {n}', {n: x.round})}
                    </Text>
                    {x.tries.map(({r, n}) => (
                      <TryLine key={n} r={r} n={n} />
                    ))}
                  </VStack>
                </VStack>
              ))}
            </VStack>
          ) : (
            <Text type="body" color="secondary">
              {run.history.length ? t('Every try so far was dropped.') : t('The first try is being written.')}
            </Text>
          )}
        </Card>
      </VStack>
    </section>
  );
}

type Line = {key: string; text: string; at: string | null};

/** What the run did, newest first: its start, each try that ended, and how it ended. */
function activityLines(state: ProjectState, run: OptimisationRun): Line[] {
  const at = (id: string | null) => (id ? (state.versions.find(v => v.id === id)?.createdAt ?? null) : null);
  const from = flat(state, run.startVersionId) ?? t('the start version');
  const lines: Line[] = [
    {key: 'start', text: run.auto ? t('Ask AI started the Optimiser from {version}, up to {n} rounds.', {version: from, n: run.maxRounds}) : t('Started from {version}, up to {n} rounds.', {version: from, n: run.maxRounds}), at: run.startedAt},
  ];
  run.history.forEach((r, i) => {
    const vars = {round: r.round, n: i + 1};
    const text =
      r.outcome === 'kept'
        ? r.score != null
          ? t('Round {round}: try {n} was kept at {score}.', {...vars, score: pct(r.score)})
          : t('Round {round}: try {n} was kept.', vars)
        : r.outcome === 'dropped'
          ? t('Round {round}: try {n} did worse in the dry run and was dropped.', vars)
          : r.outcome === 'checks'
            ? t('Round {round}: try {n} failed the checks and was dropped.', vars)
            : r.outcome === 'repeat'
              ? t('Round {round}: try {n} repeated an earlier one and was dropped.', vars)
              : r.outcome === 'failed'
                ? t('Round {round} failed.', vars)
                : r.outcome === 'stopped'
                  ? t('Round {round} was stopped.', vars)
                  : null;
    if (text) lines.push({key: `r${i}`, text, at: at(r.versionId)});
  });
  const end =
    run.state === 'failed'
      ? t('The run stopped with an error.')
      : run.state === 'stopped'
        ? t('The run was stopped.')
        : run.state === 'done'
          ? run.stopReason === 'passes'
            ? t('A try passed the thresholds. The run ended.')
            : run.stopReason === 'no_new_ideas'
              ? t('The run had no new changes to try. It ended.')
              : t('The run used all {n} rounds.', {n: run.maxRounds})
          : null;
  if (end) lines.push({key: 'end', text: end, at: run.finishedAt});
  return lines.reverse();
}

/** Activity (W-PromptTuning-Run), beside the run's Progress and Rounds. */
export function OptimiserActivity({state, run}: {state: ProjectState; run: OptimisationRun}) {
  return (
    <section aria-label={t('Activity')}>
      <VStack gap={4}>
        <SectionTitle title={t('Activity')} />
        <Card>
          <VStack gap={4}>
            {activityLines(state, run).map(l => (
              <VStack gap={1} key={l.key}>
                <Text type="body">{flatLabels(l.text)}</Text>
                {l.at && (
                  <Text type="supporting" color="secondary">
                    {timeOfDay(l.at)}
                  </Text>
                )}
              </VStack>
            ))}
          </VStack>
        </Card>
      </VStack>
    </section>
  );
}

/**
 * How the newest run ended, once it is over (done or stopped): whether a try beat the version it
 * started from, said plainly, with a way to its version. Dismissed per run.
 */
export function OptimiserEnd({state, onShow, onDismiss}: {state: ProjectState; onShow: (major: number) => void; onDismiss: (runId: string) => void}) {
  const run = state.optimisation[0];
  if (!run || !(run.state === 'done' || run.state === 'stopped')) return null;
  const start = flat(state, run.startVersionId) ?? t('the start version');
  const score = (id: string | null, fallback: number | null) => (id ? (reportOf(state, id)?.metrics.macroF1 ?? fallback) : fallback);
  const startScore = score(run.startVersionId, null);
  const kept = run.history.filter(h => h.outcome === 'kept' && h.versionId).map(h => ({id: h.versionId!, s: score(h.versionId, h.score)}));
  const top = kept.filter(k => k.s != null).sort((a, b) => b.s! - a.s!)[0];
  const won = !!top && (startScore == null || top.s! > startScore);
  const best = top ? flat(state, top.id) : null;
  const why =
    run.state === 'stopped' || run.stopReason === 'user'
      ? t('You stopped the run.')
      : run.stopReason === 'no_new_ideas'
        ? t('It had no new changes to try.')
        : run.stopReason === 'passes'
          ? ''
          : t('It used all {n} rounds.', {n: run.maxRounds});
  const passes = run.stopReason === 'passes' && won && best;
  const title = passes ? t('The Optimiser found {version}, which passes', {version: best}) : won && best ? t('{version} beat {start}', {version: best, start}) : t('No change beat {start}', {start});
  const numbers = won && top && startScore != null ? t('{score} against {startScore}.', {score: pct(top.s!), startScore: pct(startScore)}) : '';
  // Advice only when the run ended by itself after trying changes: a run stopped early says little.
  const byItself = run.state === 'done' && run.stopReason !== 'user';
  const advice = won || !byItself || !run.history.some(h => h.versionId) ? '' : t('Changing the wording more may not help: check the gold labels on the examples every version gets wrong.');
  const description = [why, numbers, advice].filter(Boolean).join(' ');
  const major = top ? state.versions.find(v => v.id === top.id)?.major : undefined;
  return (
    <Banner
      key={run.id}
      status={passes ? 'success' : 'info'}
      title={title}
      description={description || undefined}
      isDismissable
      dismissLabel={t('Dismiss')}
      onDismiss={() => onDismiss(run.id)}
      endContent={won && best && major != null ? <Button label={t('Show {version}', {version: best})} variant="secondary" size="sm" onClick={() => onShow(major)} /> : undefined}
    />
  );
}

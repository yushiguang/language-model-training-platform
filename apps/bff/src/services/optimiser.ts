import type {Answer, EndpointId, ExampleBrief, FeatureSelection, Prediction, OptimisationRun, OptimiserRound, OptimiserStep, ProjectState, PromptVersion, Schema, SetupVersion} from '@tsp/contracts';
import {
  BRIEF_WINS,
  checkTemplate,
  compareDryRun,
  answersForHelpers,
  exampleBrief,
  dryRunSize,
  exampleScore,
  mergePair,
  newId,
  paretoFront,
  pickDryRun,
  pickParent,
  placeholderKeys,
  promptKeys,
  settingsHash,
  versionLabel,
  wrongExamples,
  type PoolEntry,
} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, confirmScore, labelEvalSet, labelExamples, scoreOnOptimiserHalf} from './evaluation.ts';
import {agentTools} from './page-views.ts';
import {approveNode, loadProjectState} from './projects.ts';
import {createVersion} from './prompts.ts';
import {labelerNotes, withLabelerNotes} from './mismatches.ts';
import {startTrainingSet} from './training.ts';

/**
 * The Optimiser (GEPA, ported to TypeScript; design doc "Prompt optimising in Sprint"). Runs from
 * the open page, only when the user starts it (Auto Optimise). Each round:
 *  1. pick a parent from the Pareto front of the pool (the start version and the kept versions),
 *     scored per example on the optimiser half of the eval set; or merge two front versions that
 *     win on different examples (after every 2 kept versions);
 *  2. ask the agent runtime for one change (it may read feature descriptions);
 *  3. run the editor's Checks; a failing or repeated change is dropped with no labeling;
 *  4. save it as the next minor of the run's major (v4.1, v4.2…) and dry-run it on 10 examples
 *     of the optimiser half (the parent's answers are known); drop it unless it passes more;
 *  5. label it on the whole eval set (the dry run's answers are reused) and build its report.
 * Stops when a version passes (then the training and test sets start), at the round limit,
 * after 3 wasted rounds in a row, on Stop, or when a step fails 3 times (Failed, with Retry).
 */

const active = new Map<string, {ctrl: AbortController; task: string | null}>();
export const optimiserActive = (id: string) => active.has(id);

/** The user's Stop: ends the run (and the labeling it is doing) and saves it in Ask AI. */
export function stopOptimiser(id: string): void {
  const a = active.get(id);
  if (!a) return;
  a.ctrl.abort();
  if (a.task) void getApp().labeling.stopTask(a.task);
  void getApp()
    .catalog.get('optimisation_runs', id)
    .then(o => o && postEvent(o.projectId, 'stop', 'user', 'stopped the Optimiser', {path: '/prompt'}));
}

const TRIES = 3;
const WASTED_LIMIT = 3;
const MERGE_EVERY = 2;

const STEP_NAME: Record<OptimiserStep, string> = {
  parent: 'Labeling',
  reflect: 'Writing a change to',
  merge: 'Merging into',
  check: 'Checking',
  dry_run: 'Dry run of',
  full: 'Labeling',
  report: 'Scoring',
  confirm: 'Confirming the pass of',
};

class StepFailed extends Error {
  readonly step: OptimiserStep;
  constructor(step: OptimiserStep, message: string) {
    super(message);
    this.step = step;
  }
}

/** The Optimiser's random picks (parent, dry-run examples). Tests set a fixed one. */
let random: () => number = Math.random;
export function setOptimiserRandom(r: () => number = Math.random): void {
  random = r;
}

const aborted = () => new DOMException('Stopped', 'AbortError');
const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

/**
 * What the helper reads with a change or a merge (R3-9, D3): optimiser-half examples only. A change
 * gets the parent's wrong examples, worst first; a merge gets the examples each version gets right
 * that the other misses, up to 4 each.
 */
function briefs(state: ProjectState, schema: Schema, half: string[], parent: PromptVersion, other: PromptVersion | null, answers: Map<string, Map<string, Prediction>>, entries: PoolEntry[]): ExampleBrief[] {
  const halfSet = new Set(half);
  const exs = state.examples.filter(e => halfSet.has(e.id));
  const gold = new Map(exs.filter(e => state.gold.has(e.id)).map(e => [e.id, state.gold.get(e.id)!.answer]));
  const mine = answers.get(parent.id) ?? new Map<string, Prediction>();
  if (!other) {
    const {predicted, notes} = answersForHelpers(mine.values());
    return wrongExamples(schema, exs, promptKeys(parent), gold, predicted, undefined, notes);
  }
  const a = entries.find(x => x.id === parent.id)?.scores;
  const b = entries.find(x => x.id === other.id)?.scores;
  if (!a || !b) return [];
  const theirs = answers.get(other.id) ?? new Map<string, Prediction>();
  const keys = new Set([...promptKeys(parent), ...promptKeys(other)]);
  const wins = (x: Map<string, number>, y: Map<string, number>, by: 'template' | 'other', preds: Map<string, Prediction>) =>
    exs
      .filter(e => (x.get(e.id) ?? 0) > (y.get(e.id) ?? 0) && gold.has(e.id) && !preds.get(e.id)?.filtered)
      .slice(0, BRIEF_WINS)
      .map(e => {
        const p = preds.get(e.id);
        return exampleBrief(e, keys, gold.get(e.id)!, p?.answer ?? null, by, p ? answersForHelpers([p]).notes.get(e.id) : undefined);
      });
  // `predicted` is the answer of the version that misses the example.
  return [...wins(a, b, 'template', theirs), ...wins(b, a, 'other', mine)];
}

/** The version with the highest current score on the model, if any is scored. */
function bestScored(state: ProjectState, endpoint: EndpointId): PromptVersion | undefined {
  const scored = state.reports.filter(r => r.endpoint === endpoint && !r.archivedNow).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1);
  return scored.map(r => state.versions.find(v => v.id === r.promptVersionId)).find(v => !!v);
}

/**
 * Starts a new run: reserves the next major for its versions. It starts from `startVersionId`
 * (R3-7: the version selected in the list), else from the best scored version, else the newest.
 */
export async function newRun(projectId: string, endpoint: EndpointId, maxRounds: number, opts: {auto?: boolean; startVersionId?: string} = {}): Promise<OptimisationRun> {
  const {catalog} = getApp();
  const state = (await loadProjectState(projectId))!;
  const start = opts.startVersionId ? state.versions.find(v => v.id === opts.startVersionId) : bestScored(state, endpoint);
  if (opts.startVersionId && !start) throw new Error('The selected version was not found.');
  const top = Math.max(0, ...state.versions.map(v => v.major), ...state.optimisation.map(o => o.major ?? 0));
  const run: OptimisationRun = {
    id: newId('op'),
    projectId,
    endpoint,
    startVersionId: (start ?? state.versions[0]).id,
    major: top + 1,
    maxRounds,
    round: 0,
    state: 'running',
    step: null,
    stepStartedAt: null,
    stepVersionId: null,
    history: [],
    calls: 0,
    candidates: 0,
    costUsd: 0,
    stopReason: null,
    error: null,
    startedAt: now(),
    finishedAt: null,
    auto: !!opts.auto,
    trainingSetId: null,
  };
  await catalog.insert('optimisation_runs', run);
  return run;
}

/** Runs (or resumes) the loop of a saved run. Resolves when the run ends. */
export async function runOptimiser(given: OptimisationRun, opts: {resumed?: boolean} = {}): Promise<OptimisationRun> {
  const {catalog, agents, gateway} = getApp();
  const run: OptimisationRun = {...given, state: 'running', error: null, finishedAt: null, history: [...(given.history ?? [])]};
  const {projectId, endpoint} = run;
  const entry = {ctrl: new AbortController(), task: null as string | null};
  active.set(run.id, entry);
  const signal = entry.ctrl.signal;
  const save = async (extra: Partial<OptimisationRun> = {}) => {
    Object.assign(run, extra);
    const {id: _id, ...rest} = run;
    await catalog.patch('optimisation_runs', run.id, rest);
    emitChange();
  };
  await save();
  tm().event('optimiser_started', {slot: endpoint, trigger: run.auto ? 'auto' : 'user', resumed: !!opts.resumed, max_rounds: run.maxRounds});

  const setStep = (step: OptimiserStep | null, versionId: string | null) => save({step, stepVersionId: versionId, stepStartedAt: step ? now() : null});
  /** Runs one step, trying it up to 3 times; the third error fails the run. */
  async function step<T>(name: OptimiserStep, version: PromptVersion | null, fn: () => Promise<T>): Promise<T> {
    await setStep(name, version?.id ?? null);
    let last: unknown;
    for (let i = 0; i < TRIES; i++) {
      if (signal.aborted) throw aborted();
      try {
        return await fn();
      } catch (e) {
        if (signal.aborted || isAbort(e)) throw aborted();
        last = e;
        tm().counter('tsp_optimiser_step_failures_total', {step: name});
      }
    }
    const what = `${STEP_NAME[name]}${version ? ` ${versionLabel(version)}` : ''}`;
    throw new StepFailed(name, `${what} failed after ${TRIES} tries: ${(last as Error)?.message ?? 'unknown error'}`);
  }
  /** Labels examples as one try of a step; a stopped or failed task is an error. */
  const label = async (setup: SetupVersion, v: PromptVersion, ids: string[] | 'eval', pass?: number) => {
    const fresh = (await loadProjectState(projectId))!;
    const o = {onTask: (id: string) => void (entry.task = id), pass};
    const t = ids === 'eval' ? await labelEvalSet(projectId, setup, v, endpoint, fresh.examples, 'optimiser', o) : await labelExamples(projectId, setup, v, endpoint, ids, 'optimiser', o);
    entry.task = null;
    if (!t) throw new Error('another tab is labeling this version');
    run.calls += t.done;
    run.costUsd += t.costUsd;
    if (signal.aborted) throw aborted();
    if (t.state !== 'done') throw new Error(t.error ?? `labeling ended as ${t.state}`);
    return t;
  };
  const score = async (setup: SetupVersion, v: PromptVersion) => {
    const fresh = (await loadProjectState(projectId))!;
    const report = await buildReport(projectId, setup, v, endpoint, fresh.examples, fresh.gold, fresh.contextId);
    if (!report) throw new Error('the report could not be built (gold labels missing?)');
    const after = (await loadProjectState(projectId))!;
    return {report, passed: after.reports.some(r => r.id === report.id && r.passed)};
  };
  const putRound = async (r: OptimiserRound) => {
    const i = run.history.findIndex(h => h.round === r.round);
    if (i >= 0) run.history[i] = r;
    else run.history.push(r);
    await save();
  };

  // Rebuilt from the history, so a resumed run keeps counting (review finding 17).
  const settled = run.history.filter(h => h.outcome !== 'running' && h.outcome !== 'failed' && h.outcome !== 'stopped');
  let wasted = 0;
  for (const h of [...settled].reverse()) {
    if (h.outcome === 'kept') break;
    wasted++;
  }
  let keptSinceMerge = 0;
  for (const h of [...settled].reverse()) {
    if (h.outcome !== 'kept') continue;
    if (h.kind === 'merge') break;
    keptSinceMerge++;
  }
  let passedVersion: PromptVersion | null = null;
  try {
    // A round left by a failure or a closed page: one with a saved change goes on from its step;
    // one without is tried again from the start.
    const pending = run.history.at(-1);
    let resumeRound: OptimiserRound | null = null;
    if (pending && (pending.outcome === 'running' || pending.outcome === 'failed')) {
      if (pending.versionId && pending.step && ['dry_run', 'full', 'report', 'confirm'].includes(pending.step)) resumeRound = {...pending, outcome: 'running'};
      else {
        run.history.pop();
        run.round = Math.max(0, run.round - 1);
        await save();
      }
    }

    for (;;) {
      if (signal.aborted) throw aborted();
      let state = (await loadProjectState(projectId))!;
      const setup = state.setup!;
      const schema = setup.schema!;
      const start = state.versions.find(v => v.id === run.startVersionId) ?? state.versions[state.versions.length - 1];

      // The start version must be labeled on the eval set before anything can be compared.
      if (!state.reports.some(r => r.promptVersionId === start.id && r.endpoint === endpoint && !r.archivedNow)) {
        await step('parent', start, async () => {
          await label(setup, start, 'eval');
          const s = await score(setup, start);
          if (s.passed) passedVersion = start;
        });
        state = (await loadProjectState(projectId))!;
      }
      if (passedVersion) {
        run.stopReason = 'passes';
        break;
      }

      // The pool (decided 2026-11-11): the start version, this run's kept versions, and every other
      // version with a current score on this model: the user's own versions and earlier runs may
      // hold rules the best version lacks. Reports are archived when the labels or gold labels
      // change, so a current report means answers on today's eval set.
      const kept = run.history.filter(h => h.outcome === 'kept' && h.versionId).map(h => h.versionId!);
      const scored = new Set(state.reports.filter(r => r.endpoint === endpoint && !r.archivedNow).map(r => r.promptVersionId));
      const pool = [start, ...state.versions.filter(v => kept.includes(v.id)), ...state.versions.filter(v => v.id !== start.id && !kept.includes(v.id) && scored.has(v.id))];
      const settings = setup.models.find(m => m.endpoint === endpoint);
      if (!settings) throw new StepFailed('parent', `The model is not chosen in Setup any more.`);
      const half = state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && state.gold.has(e.id)).map(e => e.id);
      if (!half.length) throw new StepFailed('parent', 'No version can be compared yet: the optimiser half of the eval set has no gold labels.');
      const answers = new Map<string, Map<string, Prediction>>();
      for (const v of pool) answers.set(v.id, await getApp().labeling.predictions(v.id, endpoint, settingsHash(settings)));
      const entries: PoolEntry[] = pool.map(v => ({
        id: v.id,
        // R4-6: an answer the safety filter stopped is left out. An invalid answer still scores 0
        // here, so the Optimiser keeps fixing prompts that give unreadable answers.
        scores: new Map(half.filter(id => answers.get(v.id)!.has(id) && !answers.get(v.id)!.get(id)!.filtered).map(id => [id, exampleScore(schema, state.gold.get(id)!.answer, answers.get(v.id)!.get(id)!.answer)])),
      }));
      const front = paretoFront(entries, half);

      let round: OptimiserRound;
      let cand: PromptVersion;
      let parent: PromptVersion;
      if (resumeRound) {
        round = resumeRound;
        resumeRound = null;
        cand = state.versions.find(v => v.id === round.versionId)!;
        parent = state.versions.find(v => v.id === round.parentId) ?? start;
        if (!cand) {
          run.history = run.history.filter(h => h.round !== round.round);
          run.round = Math.max(0, run.round - 1);
          continue;
        }
      } else {
        if (run.round >= run.maxRounds) {
          run.stopReason = 'max_rounds';
          break;
        }
        if (wasted >= WASTED_LIMIT) {
          run.stopReason = 'no_new_ideas';
          break;
        }
        const pair = keptSinceMerge >= MERGE_EVERY ? mergePair(entries, front) : null;
        const parentId = pair ? pair[0] : (pickParent(front, random) ?? start.id);
        parent = pool.find(v => v.id === parentId) ?? start;
        const other = pair ? pool.find(v => v.id === pair[1])! : null;
        run.round++;
        round = {round: run.round, versionId: null, parentId: parent.id, kind: other ? 'merge' : 'change', change: '', outcome: 'running', score: null, passed: false, dryRun: null, step: other ? 'merge' : 'reflect'};
        await putRound(round);

        const m = await scoreOnOptimiserHalf(setup, parent, endpoint, state.examples, state.gold);
        // R4-4: the labelers' Why notes go with optimiser-half examples (never the held-out half).
        const examples = withLabelerNotes(briefs(state, schema, half, parent, other, answers, entries), state.examples, await labelerNotes(state.project.id, state));
        const out = await step(other ? 'merge' : 'reflect', parent, () =>
          agents.reflectPrompt(
            {
              mode: other ? 'merge' : 'change',
              template: parent.template,
              features: parent.features,
              schema,
              triedChanges: run.history.filter(h => h.parentId === parent.id && h.change).map(h => h.change),
              mixUps: m.mixUps,
              lowestField: m.lowestField,
              lowestValue: m.lowestValue,
              examples,
              ...(other ? {other: {template: other.template, features: other.features, change: other.change}} : {}),
              signal,
            },
            gateway.agentModel(),
            agentTools(projectId),
          ),
        );
        run.candidates++;
        round = {...round, change: out.change || (other ? `Merged ${versionLabel(parent)} and ${versionLabel(other)}` : 'A change'), step: 'check'};
        await putRound(round);

        // Checks: the same rules as the editor. A change that fails them, or repeats a version,
        // is dropped without labeling.
        const features: FeatureSelection = out.features ?? parent.features;
        const verdict = await step('check', parent, async () => {
          const featuresSame = JSON.stringify(features) === JSON.stringify(parent.features);
          const keysSame = [...placeholderKeys(out.template)].sort().join() === [...placeholderKeys(parent.template)].sort().join();
          const fresh = (await loadProjectState(projectId))!;
          if (fresh.versions.some(v => v.template === out.template && JSON.stringify(v.features) === JSON.stringify(features))) return 'repeat' as const;
          if ((featuresSame && !keysSame) || checkTemplate(out.template, features, {schema, images: parent.images}).errors.length) return 'checks' as const;
          return 'ok' as const;
        });
        if (verdict !== 'ok') {
          wasted++;
          tm().counter('tsp_optimiser_candidates_total', {slot: endpoint, result: verdict});
          await putRound({...round, outcome: verdict, step: undefined});
          continue;
        }
        cand = await createVersion(projectId, {
          template: out.template,
          features,
          images: parent.images,
          parent,
          madeBy: 'optimiser',
          change: round.change,
          kind: 'minor',
          inMajor: run.major,
          schema,
          schemaVersion: setup.schemaVersion,
        });
        round = {...round, versionId: cand.id, step: 'dry_run'};
        await putRound(round);
      }

      // Dry run: examples of the optimiser half at random, up to half of them holding the weakest
      // value of the parent's lowest field.
      if (round.step === 'dry_run') {
        const parentAnswers = answers.get(parent.id) ?? (await getApp().labeling.predictions(parent.id, endpoint, settingsHash(settings)));
        const pm = await scoreOnOptimiserHalf(setup, parent, endpoint, state.examples, state.gold);
        const weak = pm.lowestValue;
        // The weakest value's score suffers from both sides: examples that have it, and examples
        // the parent wrongly gave it.
        const has = (a: Answer | null | undefined) => !!weak && !!a?.[weak.field]?.includes(weak.value);
        const focus = new Set(half.filter(id => has(state.gold.get(id)!.answer) || has(parentAnswers.get(id)?.answer)));
        const ids = pickDryRun(
          half.filter(id => parentAnswers.has(id)),
          dryRunSize(half.length),
          focus,
          random,
        );
        const result = await step('dry_run', cand, async () => {
          await label(setup, cand, ids);
          const mine = await getApp().labeling.predictions(cand.id, endpoint, settingsHash(settings));
          return compareDryRun(
            schema,
            parent.id,
            // R4-6: examples where either answer was stopped by the safety filter are left out.
            ids.filter(id => !mine.get(id)?.filtered && !parentAnswers.get(id)?.filtered).map(id => ({gold: state.gold.get(id)!.answer, candidate: mine.get(id)?.answer ?? null, parent: parentAnswers.get(id)?.answer ?? null})),
            pm.lowestField.field,
          );
        });
        const {better, ...dryRun} = result;
        if (!better) {
          wasted++;
          tm().counter('tsp_optimiser_candidates_total', {slot: endpoint, result: 'dropped'});
          await putRound({...round, outcome: 'dropped', dryRun, step: undefined});
          continue;
        }
        round = {...round, dryRun, step: 'full'};
        await putRound(round);
      }
      if (round.step === 'full') {
        await step('full', cand, () => label(setup, cand, 'eval'));
        round = {...round, step: 'report'};
        await putRound(round);
      }
      const s = await step('report', cand, () => score(setup, cand));
      // A pass is confirmed before it ends the run: the held-out half is labeled a second time and
      // must pass again (decided 2026-11-10; review finding 6: with many tries, one passes by luck).
      let confirm: OptimiserRound['confirm'] = null;
      if (s.passed) {
        round = {...round, score: s.report.metrics.lowestField.macroF1, passed: true, step: 'confirm'};
        await putRound(round);
        confirm = await step('confirm', cand, async () => {
          const fresh = (await loadProjectState(projectId))!;
          await label(setup, cand, fresh.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).map(e => e.id), 2);
          return confirmScore(setup, cand, endpoint, fresh.examples, fresh.gold);
        });
      }
      wasted = 0;
      keptSinceMerge = round.kind === 'merge' ? 0 : keptSinceMerge + 1;
      tm().counter('tsp_optimiser_candidates_total', {slot: endpoint, result: 'kept'});
      await putRound({...round, outcome: 'kept', score: s.report.metrics.lowestField.macroF1, passed: s.passed, confirm, step: undefined});
      if (s.passed && confirm?.passed) {
        passedVersion = cand;
        run.stopReason = 'passes';
        break;
      }
    }
    run.state = 'done';
  } catch (e) {
    const stopped = isAbort(e);
    run.state = stopped ? 'stopped' : 'failed';
    run.stopReason = stopped ? 'user' : null;
    run.error = stopped ? null : (e as Error).message;
    const last = run.history.at(-1);
    if (last?.outcome === 'running') {
      const failedStep = e instanceof StepFailed ? e.step : (last.step ?? run.step ?? undefined);
      run.history[run.history.length - 1] = {...last, outcome: stopped ? 'stopped' : 'failed', step: failedStep};
    }
  } finally {
    entry.task = null;
    active.delete(run.id);
    await save({finishedAt: now(), step: null, stepStartedAt: null, stepVersionId: null});
    const outcome = run.state === 'done' ? (run.stopReason ?? 'max_rounds') : run.state;
    const kept = run.history.filter(h => h.outcome === 'kept');
    tm().counter('tsp_optimiser_runs_total', {slot: endpoint, outcome});
    if (run.state === 'stopped') tm().event('optimiser_stopped_by_user', {slot: endpoint, candidates: run.candidates, cost_usd: run.costUsd});
    tm().event('optimiser_ended', {
      slot: endpoint,
      outcome,
      rounds: run.round,
      candidates: run.candidates,
      kept: kept.length,
      cost_usd: run.costUsd,
      best_lowest_field_macro_f1: kept.length ? Math.max(...kept.map(h => h.score ?? 0)) : null,
    });
  }
  if (passedVersion) await afterPass(run, passedVersion);
  return run;
}

/**
 * A version passed: the Prompt step is approved and the training and test sets start with it
 * (test examples without a gold label get the model's answers too). Said in Ask AI.
 */
async function afterPass(run: OptimisationRun, v: PromptVersion): Promise<void> {
  const {catalog} = getApp();
  const state: ProjectState | null = await loadProjectState(run.projectId);
  if (!state) return;
  const report = state.reports.find(r => r.promptVersionId === v.id && r.endpoint === run.endpoint && !r.archivedNow) ?? null;
  try {
    if (!state.project.approvedNodes.includes('prompt')) await approveNode(run.projectId, 'prompt');
    const ts = await startTrainingSet(run.projectId, v, run.endpoint, report, 0, {labelTest: true});
    await catalog.patch('optimisation_runs', run.id, {trainingSetId: ts.id});
    emitChange();
    tm().counter('tsp_auto_starts_total', {what: 'training_after_pass', decision: 'started'});
    await postEvent(run.projectId, 'auto', 'workflow', `started the training and test sets with ${versionLabel(v)}`, {path: '/training-set'});
  } catch (e) {
    await postEvent(run.projectId, 'auto', 'workflow', `could not start the training set: ${(e as Error).message}`, {path: '/training-set'});
  }
}

import type {AgentModel, AgentRuntimeContract, Answer, CatalogContract, EndpointId, Example, ExampleBrief, LabelingContract, LockPort, OptimisationRun, OptimiserContract, OptimiserHost, OptimiserRound, OptimiserStep, Prediction, ProjectState, PromptVersion, Schema, TelemetryPort} from '@tsp/contracts';
import {NO_TELEMETRY} from '@tsp/contracts';
import {checkStructured, compilePrompt, compareDryRun, rewordOnly, sameSignature, signatureOf, tidyStructured, answersForHelpers, exampleBrief, dryRunSize, exampleScore, mergePair, newId, paretoFront, pickDryRun, pickParent, promptKeys, settingsHash, systemConfig, toMap, versionLabel, withLabelerNotes, wrongExamples, type PoolEntry} from '@tsp/domain';

/**
 * The Optimiser (GEPA, ported to TypeScript; docs/design/optimiser.md). Runs from
 * the open page, only when the user starts it (Auto Optimise). Each round:
 *  1. pick a parent from the Pareto front of the pool (the start version and the kept versions),
 *     scored per example on the optimiser half of the eval set; or merge two front versions that
 *     win on different examples (after every 2 kept versions);
 *  2. ask the agent runtime for one change (it may read feature descriptions);
 *  3. run the editor's Checks; a failing or repeated change is dropped with no labeling;
 *  4. save it as the next minor of the run's major (v4.1, v4.2…) and dry-run it on 10 examples
 *     of the optimiser half (the parent's answers are known); drop it unless it passes more.
 *     A tie (as many fields right, on different examples) goes on but is not progress (R5-6);
 *  5. label it on the whole eval set (the dry run's answers are reused) and build its report.
 * Stops when a version passes (the host then does what follows in the workflow), at the round limit,
 * after 3 wasted rounds in a row (ties count), after 2 ties in a row, on Stop, or when a step
 * fails 3 times (Failed, with Retry). Round 1 always starts from the version the user picked
 * (R5-7); later rounds pick a parent from the Pareto front, weighted by the examples it wins.
 */


export interface OptimiserDeps {
  catalog: CatalogContract;
  labeling: LabelingContract;
  agents: AgentRuntimeContract;
  /** The model the helper that writes changes runs on. */
  agentModel: () => AgentModel;
  /** What the project's owner does for the loop; see `OptimiserHost`. */
  host: OptimiserHost;
  /** Keeps a second tab from running the same run; without it, only this runner is covered. */
  locks?: LockPort;
  telemetry?: TelemetryPort;
  /** Called after every write, so open pages read again. */
  onChange?: () => void;
  /** The random picks (parent, dry-run examples). Tests pass a fixed one. */
  random?: () => number;
}

/** The lock an optimiser run on one model holds for as long as it runs, in any tab. */
export const optimiserLock = (projectId: string, endpoint: string) => `optimiser:${projectId}:${endpoint}`;

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
  const gold = new Map(exs.filter(e => !!state.gold[e.id]).map(e => [e.id, state.gold[e.id].answer]));
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
      .slice(0, systemConfig().optimiser.briefMergeWins)
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

const nowIso = () => new Date().toISOString();

function memoryLocks(): LockPort {
  const held = new Set<string>();
  return {
    async run(name, fn) {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    },
    isHeld: async name => held.has(name),
  };
}

export function createOptimiser(deps: OptimiserDeps): OptimiserContract {
  const {catalog, labeling, agents, agentModel, host} = deps;
  const locks = deps.locks ?? memoryLocks();
  const tm = deps.telemetry ?? NO_TELEMETRY;
  const onChange = deps.onChange ?? (() => {});
  const random = () => (deps.random ?? Math.random)();
  /** Runs this runner is working on, and whether it is starting one. */
  const active = new Map<string, {ctrl: AbortController; projectId: string}>();
  let starting = false;

  /** One start at a time in this runner; a second one while the first is being set up does nothing. */
  async function once<T>(fn: () => Promise<T>): Promise<T | null> {
    if (starting) return null;
    starting = true;
    try {
      return await fn();
    } finally {
      starting = false;
    }
  }

  /**
   * Starts a new run: reserves the next major for its versions. It starts from `startVersionId`
   * (R3-7: the version selected in the list), else from the best scored version, else the newest.
   */
  async function newRun(projectId: string, endpoint: EndpointId, maxRounds: number, opts: {auto?: boolean; startVersionId?: string} = {}): Promise<OptimisationRun> {
    const state = (await host.loadState(projectId))!;
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
      startedAt: nowIso(),
      finishedAt: null,
      auto: !!opts.auto,
    };
    await catalog.insert('optimisation_runs', run);
    return run;
  }

  /** Runs (or resumes) the loop of a saved run. Resolves when the run ends. */
  async function runLoop(given: OptimisationRun, opts: {resumed?: boolean} = {}): Promise<OptimisationRun> {
    const run: OptimisationRun = {...given, state: 'running', error: null, finishedAt: null, history: [...(given.history ?? [])]};
    const {projectId, endpoint} = run;
    const entry = {ctrl: new AbortController(), projectId};
    active.set(run.id, entry);
    const signal = entry.ctrl.signal;
    const save = async (extra: Partial<OptimisationRun> = {}) => {
      Object.assign(run, extra);
      const {id: _id, ...rest} = run;
      await catalog.patch('optimisation_runs', run.id, rest);
      onChange();
    };
    await save();
    tm.event('optimiser_started', {slot: endpoint, trigger: run.auto ? 'auto' : 'user', resumed: !!opts.resumed, max_rounds: run.maxRounds});

    const setStep = (step: OptimiserStep | null, versionId: string | null) => save({step, stepVersionId: versionId, stepStartedAt: step ? nowIso() : null});
    /** Runs one step, trying it up to 3 times; the third error fails the run. */
    async function step<T>(name: OptimiserStep, version: PromptVersion | null, fn: () => Promise<T>): Promise<T> {
      await setStep(name, version?.id ?? null);
      let last: unknown;
      for (let i = 0; i < systemConfig().optimiser.stepRetries; i++) {
        if (signal.aborted) throw aborted();
        try {
          return await fn();
        } catch (e) {
          if (signal.aborted || isAbort(e)) throw aborted();
          last = e;
          tm.counter('tsp_optimiser_step_failures_total', {step: name});
        }
      }
      const what = `${STEP_NAME[name]}${version ? ` ${versionLabel(version)}` : ''}`;
      throw new StepFailed(name, `${what} failed after ${systemConfig().optimiser.stepRetries} tries: ${(last as Error)?.message ?? 'unknown error'}`);
    }
    /** Labels examples as one try of a step; a stopped or failed task is an error. */
    const label = async (v: PromptVersion, ids: string[] | 'eval', pass?: number) => {
      const t = await host.label({projectId, promptVersionId: v.id, endpoint, ...(ids === 'eval' ? {} : {exampleIds: ids}), ...(pass ? {pass} : {})});
      if (!t) throw new Error('another tab is labeling this version');
      run.calls += t.done;
      run.costUsd += t.costUsd;
      if (signal.aborted) throw aborted();
      if (t.state !== 'done') throw new Error(t.error ?? `labeling ended as ${t.state}`);
      return t;
    };
    const score = async (v: PromptVersion) => {
      const s = await host.score({projectId, promptVersionId: v.id, endpoint});
      if (!s) throw new Error('the report could not be built (gold labels missing?)');
      return s;
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
      if (h.outcome === 'kept' && !h.tied) break;
      wasted++;
    }
    let ties = 0;
    for (const h of [...settled].reverse()) {
      if (!h.tied) break;
      ties++;
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
        let state = (await host.loadState(projectId))!;
        const setup = state.setup!;
        const schema = setup.schema!;
        const start = state.versions.find(v => v.id === run.startVersionId) ?? state.versions[state.versions.length - 1];

        // The start version must be labeled on the eval set before anything can be compared.
        if (!state.reports.some(r => r.promptVersionId === start.id && r.endpoint === endpoint && !r.archivedNow)) {
          await step('parent', start, async () => {
            await label(start, 'eval');
            const s = await score(start);
            if (s.passed) passedVersion = start;
          });
          state = (await host.loadState(projectId))!;
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
        const half = state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && !!state.gold[e.id]).map(e => e.id);
        if (!half.length) throw new StepFailed('parent', 'No version can be compared yet: the optimiser half of the eval set has no gold labels.');
        const answers = new Map<string, Map<string, Prediction>>();
        for (const v of pool) answers.set(v.id, toMap(await labeling.predictions(v.id, endpoint, settingsHash(settings))));
        const entries: PoolEntry[] = pool.map(v => ({
          id: v.id,
          // R4-6: an answer the safety filter stopped is left out. An invalid answer still scores 0
          // here, so the Optimiser keeps fixing prompts that give unreadable answers.
          scores: new Map(half.filter(id => answers.get(v.id)!.has(id) && !answers.get(v.id)!.get(id)!.filtered).map(id => [id, exampleScore(schema, state.gold[id]!.answer, answers.get(v.id)!.get(id)!.answer)])),
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
          if (wasted >= systemConfig().optimiser.wastedRoundsLimit || ties >= systemConfig().optimiser.consecutiveTiesLimit) {
            run.stopReason = 'no_new_ideas';
            break;
          }
          // R5-7: round 1 starts from the version the user picked, as the dialog promised; later
          // rounds roam the front.
          const first = run.round === 0;
          const pair = !first && keptSinceMerge >= systemConfig().optimiser.mergeEveryKept ? mergePair(entries, front) : null;
          const parentId = first ? start.id : pair ? pair[0] : (pickParent(front, random) ?? start.id);
          parent = pool.find(v => v.id === parentId) ?? start;
          const other = pair ? pool.find(v => v.id === pair[1])! : null;
          const parentWins = first ? null : (front.find(f => f.id === parent.id)?.wins ?? 0);
          run.round++;
          round = {round: run.round, versionId: null, parentId: parent.id, parentWins, kind: other ? 'merge' : 'change', change: '', outcome: 'running', score: null, passed: false, dryRun: null, step: other ? 'merge' : 'reflect'};
          await putRound(round);

          const m = await host.halfScore({projectId, promptVersionId: parent.id, endpoint});
          // R4-4: the labelers' Why notes go with optimiser-half examples (never the held-out half).
          const examples = withLabelerNotes(briefs(state, schema, half, parent, other, answers, entries), state.examples, toMap(await host.labelerNotes(projectId)));
          const out = await step(other ? 'merge' : 'reflect', parent, () =>
            agents.reflectPrompt(
              {
                mode: other ? 'merge' : 'change',
                prompt: parent.structured,
                triedChanges: run.history.filter(h => h.parentId === parent.id && h.change).map(h => h.change),
                mixUps: m.mixUps,
                lowestField: m.lowestField,
                lowestValue: m.lowestValue,
                examples,
                ...(other ? {other: {prompt: other.structured, change: other.change}} : {}),
                signal,
              },
              agentModel(),
              host.tools(projectId),
            ),
          );
          run.candidates++;
          round = {...round, change: out.change || (other ? `Merged ${versionLabel(parent)} and ${versionLabel(other)}` : 'A change'), step: 'check'};
          await putRound(round);

          // Checks: a change may reword and tick features, never touch the label signature (gold
          // labels and scores are tied to it). A change that fails, or repeats a version, is
          // dropped without labeling.
          const next = tidyStructured(rewordOnly(parent.structured, out.prompt));
          const verdict = await step('check', parent, async () => {
            const fresh = (await host.loadState(projectId))!;
            const text = compilePrompt(next);
            if (fresh.versions.some(v => v.template === text)) return 'repeat' as const;
            if (checkStructured(next).length || !sameSignature(signatureOf(next), signatureOf(parent.structured))) return 'checks' as const;
            return 'ok' as const;
          });
          if (verdict !== 'ok') {
            wasted++;
            tm.counter('tsp_optimiser_candidates_total', {slot: endpoint, result: verdict});
            await putRound({...round, outcome: verdict, step: undefined});
            continue;
          }
          cand = await host.createVersion({projectId, structured: next, parentId: parent.id, change: round.change, inMajor: run.major});
          round = {...round, versionId: cand.id, step: 'dry_run'};
          await putRound(round);
        }

        // Dry run: examples of the optimiser half at random, up to half of them holding the weakest
        // value of the parent's lowest field.
        if (round.step === 'dry_run') {
          const parentAnswers = answers.get(parent.id) ?? toMap(await labeling.predictions(parent.id, endpoint, settingsHash(settings)));
          const pm = await host.halfScore({projectId, promptVersionId: parent.id, endpoint});
          const weak = pm.lowestValue;
          // The weakest value's score suffers from both sides: examples that have it, and examples
          // the parent wrongly gave it.
          const has = (a: Answer | null | undefined) => !!weak && !!a?.[weak.field]?.includes(weak.value);
          const focus = new Set(half.filter(id => has(state.gold[id]!.answer) || has(parentAnswers.get(id)?.answer)));
          const ids = pickDryRun(
            half.filter(id => parentAnswers.has(id)),
            dryRunSize(half.length),
            focus,
            random,
          );
          const result = await step('dry_run', cand, async () => {
            await label(cand, ids);
            const mine = toMap(await labeling.predictions(cand.id, endpoint, settingsHash(settings)));
            return compareDryRun(
              schema,
              parent.id,
              // R4-6: examples where either answer was stopped by the safety filter are left out.
              ids.filter(id => !mine.get(id)?.filtered && !parentAnswers.get(id)?.filtered).map(id => ({gold: state.gold[id]!.answer, candidate: mine.get(id)?.answer ?? null, parent: parentAnswers.get(id)?.answer ?? null})),
              pm.lowestField.field,
            );
          });
          const {better, tied, ...dryRun} = result;
          if (!better && !tied) {
            wasted++;
            tm.counter('tsp_optimiser_candidates_total', {slot: endpoint, result: 'dropped'});
            await putRound({...round, outcome: 'dropped', dryRun, step: undefined});
            continue;
          }
          round = {...round, dryRun, ...(tied ? {tied: true} : {}), step: 'full'};
          await putRound(round);
        }
        if (round.step === 'full') {
          await step('full', cand, () => label(cand, 'eval'));
          round = {...round, step: 'report'};
          await putRound(round);
        }
        const s = await step('report', cand, () => score(cand));
        // A pass is confirmed before it ends the run: the held-out half is labeled a second time and
        // must pass again (decided 2026-11-10; review finding 6: with many tries, one passes by luck).
        let confirm: OptimiserRound['confirm'] = null;
        if (s.passed) {
          round = {...round, score: s.report.metrics.lowestField.macroF1, passed: true, step: 'confirm'};
          await putRound(round);
          confirm = await step('confirm', cand, async () => {
            const fresh = (await host.loadState(projectId))!;
            await label(cand, fresh.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).map(e => e.id), 2);
            return host.confirmScore({projectId, promptVersionId: cand.id, endpoint});
          });
        }
        // A tie is kept in the pool but is not progress (R5-6).
        if (round.tied) {
          wasted++;
          ties++;
        } else {
          wasted = 0;
          ties = 0;
        }
        keptSinceMerge = round.kind === 'merge' ? 0 : keptSinceMerge + 1;
        tm.counter('tsp_optimiser_candidates_total', {slot: endpoint, result: round.tied ? 'tied' : 'kept'});
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
      active.delete(run.id);
      await save({finishedAt: nowIso(), step: null, stepStartedAt: null, stepVersionId: null});
      const outcome = run.state === 'done' ? (run.stopReason ?? 'max_rounds') : run.state;
      const kept = run.history.filter(h => h.outcome === 'kept');
      tm.counter('tsp_optimiser_runs_total', {slot: endpoint, outcome});
      if (run.state === 'stopped') tm.event('optimiser_stopped_by_user', {slot: endpoint, candidates: run.candidates, cost_usd: run.costUsd});
      tm.event('optimiser_ended', {
        slot: endpoint,
        outcome,
        rounds: run.round,
        candidates: run.candidates,
        kept: kept.length,
        cost_usd: run.costUsd,
        best_lowest_field_macro_f1: kept.length ? Math.max(...kept.map(h => h.score ?? 0)) : null,
      });
    }
    return run;
  }

  return {
    async startRun({projectId, endpoint, maxRounds, startVersionId, auto}) {
      const cfg = systemConfig().optimiser;
      const rounds = Math.max(1, Math.min(cfg.maxRoundsCap, Math.round(maxRounds) || cfg.defaultMaxRounds));
      const out = await once(() =>
        // The lock covers every tab of this browser: a second tab never runs the same work twice.
        locks.run(optimiserLock(projectId, endpoint), async () => {
          const open = (await catalog.find('optimisation_runs', {projectId}, 'startedAt desc')).find(o => o.state === 'running' || o.state === 'paused');
          if (open) return runLoop(open, {resumed: true});
          const run = await newRun(projectId, endpoint, rounds, {auto, startVersionId});
          if (!auto) await host.postEvent({projectId, event: 'start', actor: 'user', what: `started the Optimiser for up to ${rounds} rounds`, link: {path: '/prompt'}});
          return runLoop(run);
        }),
      );
      return out ?? null;
    },

    /** The user's Stop: ends the run (and the labeling it is doing) and saves it in Ask AI. */
    async stopRun(runId) {
      const a = active.get(runId);
      if (!a) return;
      a.ctrl.abort();
      const run = await catalog.get('optimisation_runs', runId);
      if (!run) return;
      for (const t of await labeling.listTasks(run.projectId)) if (t.purpose === 'optimiser' && t.state === 'running') await labeling.stopTask(t.id);
      await host.postEvent({projectId: run.projectId, event: 'stop', actor: 'user', what: 'stopped the Optimiser', link: {path: '/prompt'}});
    },

    async retryRun(runId) {
      const run = await catalog.get('optimisation_runs', runId);
      if (!run || !['failed', 'paused', 'running'].includes(run.state) || active.has(runId)) return;
      await once(() => locks.run(optimiserLock(run.projectId, run.endpoint), () => runLoop(run, {resumed: true})));
    },

    getRun: runId => catalog.get('optimisation_runs', runId),
    listRuns: projectId => catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    isRunning: async runId => active.has(runId) || starting,

    /** The project is being deleted: stop its runs here; the catalog removes their records. */
    async deleteProject(projectId) {
      for (const [, a] of active) if (a.projectId === projectId) a.ctrl.abort();
    },
  };
}

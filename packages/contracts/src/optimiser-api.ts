import type {LabelingTask} from './labeling-api.ts';
import type {RequestContext} from './platform-api.ts';
import type {ChatEvent, ChatLink, EndpointId, EvalReport, Features, MixUp, Msg, OptimisationRun, OptimiserLabelingStep, OptimiserPosition, ProjectState, PromptVersion, StructuredPrompt} from './types.ts';

/**
 * Contract: the Optimiser service (`@yushiguang/sprint-optimiser`, spec 1.0.0 section 7.2). It owns the
 * optimisation loop (GEPA; docs/design/optimiser.md) and the `optimisation_runs` records.
 * Plain JSON in and out; ids, never records.
 */
export interface StartRunRequest {
  projectId: string;
  /** The model the run labels with. */
  endpoint: EndpointId;
  maxRounds: number;
  /** The version to start from; left out: the best scored version. */
  startVersionId?: string;
  /** Started by a helper's start tool (after the user asked in Ask AI), not by the button. */
  auto?: boolean;
}

export interface OptimiserContract {
  /**
   * Saves a new run, or returns the project's open (running or paused) run. Does not run it: the
   * caller queues an `optimiser.run` job, whose executor calls `execute`.
   */
  startRun(ctx: RequestContext, req: StartRunRequest): Promise<OptimisationRun>;
  /**
   * Runs a saved run, or goes on from the step a failed or paused run stopped at, until the run
   * ends or waits for a labeling job (docs/design/server.md, 4.4): a waiting run is returned with
   * state `running`, and the labeling job's `finally` queues the next `optimiser.run`. Null when
   * another runner already works on it, or there is nothing to do (the run has ended, or is no
   * longer at `at`). `ctx` is the `optimiser.run` job's (the person who started
   * or resumed the run, and the tenant): every `OptimiserHost` call and the helper's
   * `reflectPrompt` run as it, so the workflow's permission checks see a real caller.
   *
   * `at`: this call goes on after the labeling at that position ended. Its labeling is read, not
   * queued again: answers in go on, labeling that ended without them fails the run (Retry queues
   * it again).
   * Without `at` (a start, Retry or Resume) the labeling of the run's step is queued if needed.
   */
  execute(ctx: RequestContext, runId: string, at?: OptimiserPosition): Promise<OptimisationRun | null>;
  /** The user's Stop: ends the run and the labeling it is doing. */
  stopRun(ctx: RequestContext, runId: string): Promise<void>;
  getRun(runId: string): Promise<OptimisationRun | null>;
  /** A project's runs, newest first. */
  listRuns(projectId: string): Promise<OptimisationRun[]>;
  /** True while this runner works on the run, or is starting one. */
  isRunning(runId: string): Promise<boolean>;
  /** Stops the project's runs and removes their records (the project is being deleted). */
  deleteProject(projectId: string): Promise<void>;
}

/** One runner per piece of work (in the browser: the Web Locks API, covering every tab). */
export interface LockPort {
  /** Runs fn while holding the lock, or returns null at once when someone else holds it. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
  isHeld(name: string): Promise<boolean>;
}

/** What the Optimiser asks to label: see `OptimiserHost.label`. */
export interface OptimiserLabelRequest {
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  exampleIds?: string[];
  pass?: number;
  /** The run and where it is: carried on the labeling job's args and its follow-up. */
  runId: string;
  at: OptimiserPosition;
  /** Queue the labeling when it is not done and has no job; false: only read how it ended. */
  start: boolean;
}

/** How the labeling of one step stands (`OptimiserHost.label`). */
export type OptimiserLabeling =
  | {state: 'done'; task: LabelingTask}
  | {state: 'queued'; taskId: string}
  | {state: 'unfinished'; task: LabelingTask | null; error: string};

/** The labeling steps, for callers that check a job's args. */
export const OPTIMISER_LABELING_STEPS: readonly OptimiserLabelingStep[] = ['parent', 'dry_run', 'full', 'confirm'];

/** A version's score on the optimiser half: what the helper is told to fix. */
export interface HalfScore {
  mixUps: MixUp[];
  macroF1: number;
  lowestValue: {value: string; f1: number} | null;
}

/**
 * What the Optimiser asks the project's owner (the workflow) to do. The Optimiser decides what to
 * try; the owner keeps the rules every other path follows too: how a version is saved and checked,
 * how examples are labeled and answers reused, how a score is built and judged. Every call takes
 * the run's context first (the one `execute` got), and the owner checks it like any other call.
 */
export interface OptimiserHost {
  loadState(ctx: RequestContext, projectId: string): Promise<ProjectState | null>;
  /** Examples' frozen features by example id (#32): the state carries examples without them. */
  exampleFeatures(ctx: RequestContext, projectId: string, exampleIds: string[]): Promise<Record<string, Features>>;
  /**
   * Labels examples with a version as a labeling task (saved answers are reused). `exampleIds`
   * left out: the whole eval set. `pass` 2: a second, fresh labeling (the confirmation of a pass).
   * The task's labeling runs as a `labeling.runTask` job of its own on the model's key, whose
   * args carry `optimiserRunId`, `round` and `step` (`at`), and whose `finally` queues the
   * `optimiser.run` that goes on from `at` (docs/design/server.md, 4.4). Answers:
   * - `done`: the task has every answer (it may have been done already).
   * - `queued`: its labeling job is queued or running; the run waits for it.
   * - `unfinished`: the task has no job and is not done (its labeling failed, was stopped or was
   *   lost). Only when `start` is false: with `start` true such a task is queued again (Retry
   *   labels its failed examples again).
   */
  label(ctx: RequestContext, req: OptimiserLabelRequest): Promise<OptimiserLabeling>;
  /** Builds the version's score from its saved answers; null when it cannot be built. */
  score(ctx: RequestContext, req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<{report: EvalReport; passed: boolean} | null>;
  /** The held-out half's score from the second labeling, and whether it passes. */
  confirmScore(ctx: RequestContext, req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<{score: number; passed: boolean}>;
  halfScore(ctx: RequestContext, req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<HalfScore>;
  /** Saves a change as the next minor of the run's major. */
  createVersion(ctx: RequestContext, req: {projectId: string; structured: StructuredPrompt; parentId: string; change: string; inMajor: number}): Promise<PromptVersion>;
  /** People's comments the helpers may read, by example id, oldest first (optimiser half only). */
  labelComments(ctx: RequestContext, projectId: string): Promise<Record<string, string[]>>;
  /** A grey action line in the project's Ask AI conversation. */
  postEvent(ctx: RequestContext, req: {projectId: string; event: ChatEvent; actor: 'user' | 'workflow'; what: string | Msg; link?: ChatLink}): Promise<void>;
}

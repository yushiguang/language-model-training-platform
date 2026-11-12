import type {AgentToolHost} from './agent-api.ts';
import type {LabelingTask} from './labeling-api.ts';
import type {ChatEvent, ChatLink, EndpointId, EvalReport, FeatureSelection, MixUp, OptimisationRun, ProjectState, PromptImage, PromptVersion} from './types.ts';

/**
 * Contract: the Optimiser service (`@tsp/optimiser`, spec 1.0.0 section 7.2). It owns the
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
   * Starts a run, or goes on with the project's open (running or paused) run. Resolves when the
   * run ends; null when another runner already holds this project's run.
   */
  startRun(req: StartRunRequest): Promise<OptimisationRun | null>;
  /** The user's Stop: ends the run and the labeling it is doing. */
  stopRun(runId: string): Promise<void>;
  /** Goes on from the step a failed or paused run stopped at. Resolves when the run ends. */
  retryRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<OptimisationRun | null>;
  /** A project's runs, newest first. */
  listRuns(projectId: string): Promise<OptimisationRun[]>;
  /** True while this runner works on the run, or is starting one. */
  isRunning(runId: string): Promise<boolean>;
}

/** One runner per piece of work (in the browser: the Web Locks API, covering every tab). */
export interface LockPort {
  /** Runs fn while holding the lock, or returns null at once when someone else holds it. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
  isHeld(name: string): Promise<boolean>;
}

/** A version's score on the optimiser half: what the helper is told to fix. */
export interface HalfScore {
  mixUps: MixUp[];
  lowestField: {field: string; macroF1: number};
  lowestValue: {field: string; value: string; f1: number} | null;
}

/**
 * What the Optimiser asks the project's owner (the bff) to do. The Optimiser decides what to try;
 * the owner keeps the rules every other path follows too: how a version is saved and checked, how
 * examples are labeled and answers reused, how a score is built and judged.
 */
export interface OptimiserHost {
  loadState(projectId: string): Promise<ProjectState | null>;
  /**
   * Labels examples with a version (saved answers are reused) and resolves when the task ends;
   * null when another runner holds it. `exampleIds` left out: the whole eval set. `pass` 2: a
   * second, fresh labeling (the confirmation of a pass).
   */
  label(req: {projectId: string; promptVersionId: string; endpoint: EndpointId; exampleIds?: string[]; pass?: number}): Promise<LabelingTask | null>;
  /** Builds the version's score from its saved answers; null when it cannot be built. */
  score(req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<{report: EvalReport; passed: boolean} | null>;
  /** The held-out half's score from the second labeling, and whether it passes. */
  confirmScore(req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<{score: number; passed: boolean}>;
  halfScore(req: {projectId: string; promptVersionId: string; endpoint: EndpointId}): Promise<HalfScore>;
  /** Saves a change as the next minor of the run's major. */
  createVersion(req: {projectId: string; template: string; features: FeatureSelection; images: PromptImage[]; parentId: string; change: string; inMajor: number}): Promise<PromptVersion>;
  /** The labelers' notes the helpers may read, by example id (optimiser half only). */
  labelerNotes(projectId: string): Promise<Record<string, string>>;
  /** The read tools lent to the helper that writes a change. */
  tools(projectId: string): AgentToolHost;
  /** A grey action line in the project's Ask AI conversation. */
  postEvent(req: {projectId: string; event: ChatEvent; actor: 'user' | 'workflow'; what: string; link?: ChatLink}): Promise<void>;
  /** A version passed and its pass was confirmed: what follows in the workflow. */
  versionPassed(req: {projectId: string; runId: string; promptVersionId: string; endpoint: EndpointId}): Promise<void>;
}

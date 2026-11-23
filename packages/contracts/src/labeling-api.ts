import type {Answer, EndpointId, ExampleWithFeatures, FeatureSelection, ModelSettings, Prediction, PromptImage, Schema} from './types.ts';

/**
 * Contract: labeling (`apps/labeling`).
 *
 * A labeling task runs one prompt version on one model over a list of examples and stores one
 * prediction per example. The bff decides when a task starts (system triggers: scoring a new
 * version, optimiser candidates; user triggers: Get model answers for the test set, Generate training and test sets, Retry failed). The labeling
 * app runs it: up to `parallel` examples at once, each call through the llm-gateway.
 *
 * MVP: the runner lives in the open page, under a browser lock per task. Closing the page pauses
 * the task; running it again resumes from the predictions already saved.
 */

/** eval and optimiser tasks are started by code; test and training tasks by the user, with a cost confirm. */
export type TaskPurpose = 'eval' | 'optimiser' | 'test' | 'training';
export type TaskState = 'queued' | 'running' | 'paused' | 'needs_attention' | 'done' | 'stopped' | 'failed';
export type TaskStopReason = 'user' | 'failures' | 'closed' | null;

export interface LabelingTask {
  id: string;
  projectId: string;
  /**
   * The project's tenant: whose model and rate limits the calls use (docs/design/server.md, 9).
   * Missing on records saved before it existed: read as `default`.
   */
  tenantId?: string;
  purpose: TaskPurpose;
  promptVersionId: string;
  /** Setup version whose schema the answers are checked against. */
  setupVersionId: string;
  endpoint: EndpointId;
  settings: ModelSettings;
  settingsHash: string;
  exampleIds: string[];
  total: number;
  /** Examples with a saved prediction (valid or invalid). */
  done: number;
  valid: number;
  invalid: number;
  /** The part of `invalid` the endpoint's safety filter stopped. Missing on older records. */
  filtered?: number;
  /** Examples whose call failed after the gateway's retries. */
  failed: number;
  failedExampleIds: string[];
  costUsd: number;
  /** Tokens of the answers this task counts (input + output). Missing on older records. */
  tokens?: number;
  /**
   * The part of `costUsd` spent by runs started automatically (`RunOptions.auto`), whoever
   * created the task. Recorded for metrics and the audit; there is no automatic-spend cap.
   */
  autoCostUsd?: number;
  /** Examples labeled at once. */
  parallel: number;
  /**
   * Examples whose only saved answer for this version, model and settings is invalid when the
   * task first starts are labeled once more (the final run: such a test example has no label
   * yet). A valid answer wins. Invalid answers this task saves itself are its results.
   */
  relabelInvalid?: boolean;
  /** Set by the first run under `relabelInvalid`: the examples that get one more try. */
  relabelExampleIds?: string[];
  state: TaskState;
  stopReason: TaskStopReason;
  /** Set by Stop from any tab; the runner checks it every few seconds. */
  stopRequested: boolean;
  /** When Stop was pressed: a run only obeys a Stop pressed after it started. */
  stopRequestedAt?: string | null;
  error: string | null;
  createdAt: string;
  createdBy: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  /** The project's tenant. */
  tenantId: string;
  purpose: TaskPurpose;
  promptVersionId: string;
  setupVersionId: string;
  endpoint: EndpointId;
  settings: ModelSettings;
  exampleIds: string[];
  parallel?: number;
  relabelInvalid?: boolean;
  createdBy: string;
}

/** How one run of a task was started. */
export interface RunOptions {
  /** Started by code without a click: this run's cost is added to `autoCostUsd`. */
  auto?: boolean;
}

export interface LabelingContract {
  createTask(input: CreateTaskInput): Promise<LabelingTask>;
  /**
   * Runs the task in this page until it is done, stopped or paused. Returns the final task, or
   * null when another tab already runs it. `trigger` is only for metrics: who started this run
   * (default: system for eval/optimiser tasks, user otherwise).
   */
  runTask(taskId: string, trigger?: 'system' | 'user', opts?: RunOptions): Promise<LabelingTask | null>;
  stopTask(taskId: string): Promise<void>;
  /**
   * Runs the task again for its failed examples. Returns null, changing nothing, when another
   * run holds the task.
   */
  retryFailed(taskId: string, trigger?: 'system' | 'user', opts?: RunOptions): Promise<LabelingTask | null>;
  getTask(taskId: string): Promise<LabelingTask | null>;
  listTasks(projectId: string): Promise<LabelingTask[]>;
  /** True when some tab of this browser currently runs the task. */
  isRunning(taskId: string): Promise<boolean>;
  /**
   * Saved predictions for one version, model and settings, one per example: the first valid one,
   * else the first (an invalid answer labeled again under `relabelInvalid` leaves two).
   */
  predictions(promptVersionId: string, endpoint: EndpointId, settingsHash: string): Promise<Record<string, Prediction>>;
  /**
   * Labels a few examples with an unsaved template (the prompt agent's try_prompt). Nothing is
   * saved: no task, no predictions. Each example is one call through the gateway.
   */
  tryTemplate(input: TryTemplateInput): Promise<TryTemplateRow[]>;
  /** Stops a try started with this `requestId`. */
  cancel(requestId: string): Promise<void>;
  /** Stops the project's running tasks, then removes its tasks and their saved answers. */
  deleteProject(projectId: string): Promise<void>;
}

export interface TryTemplateInput {
  /** The project's tenant: whose model and rate limits the calls use. */
  tenantId: string;
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  schema: Schema;
  settings: ModelSettings;
  /** With their features: a try is on a few examples the caller has read already. */
  examples: ExampleWithFeatures[];
  /** Lets the caller stop the try with `cancel(requestId)`. */
  requestId?: string;
}

export interface TryTemplateRow {
  exampleId: string;
  answer: Answer | null;
  invalidReason: string | null;
  costUsd: number;
  error: string | null;
}

/** Additions to a task's counters, applied atomically (`LabelingStorePort.addToTask`). */
export type LabelingTaskTally = Partial<Record<'done' | 'valid' | 'invalid' | 'filtered' | 'failed' | 'costUsd' | 'tokens' | 'autoCostUsd', number>>;

/** The version, model and settings a set of answers was saved for. */
export interface PredictionScope {
  promptVersionId: string;
  endpoint: EndpointId;
  settingsHash: string;
}

/** Fields a task's runner and Stop set (never its id, project or example list). */
export type LabelingTaskPatch = Partial<Omit<LabelingTask, 'id' | 'projectId' | 'exampleIds' | 'createdAt' | 'createdBy'>>;

/**
 * Where labeling keeps its tasks and the models' answers (#58; docs/design/server.md 6). Tasks
 * are small records that change while they run (MySQL in a server deployment). Answers are
 * written once and read a whole version at a time: the object-storage implementation writes each
 * batch passed to `savePredictions` as one segment file and keeps only a pointer row per segment.
 * `createLabeling` takes one as `store`; without it, both stay in the document store.
 */
export interface LabelingStorePort {
  getTask(taskId: string): Promise<LabelingTask | null>;
  /** A project's tasks, newest first. */
  findTasks(projectId: string): Promise<LabelingTask[]>;
  insertTask(task: LabelingTask): Promise<void>;
  /** Sets only the given fields, so a runner and a Stop never undo each other. */
  patchTask(taskId: string, patch: LabelingTaskPatch): Promise<void>;
  /**
   * In one atomic write: adds `tally` to the counters, adds `failedExampleId` (when given) to
   * `failedExampleIds` unless it is there, and sets `set`. Two runners adding at once both count.
   */
  addToTask(taskId: string, tally: LabelingTaskTally, opts?: {failedExampleId?: string; set?: LabelingTaskPatch}): Promise<void>;
  /**
   * One saved answer by its id (`predictionId`), or null. `scope` is the version, model and
   * settings it was saved for (the id is a hash that cannot be read back), so a segment-pointer
   * store looks only through that scope's pointers.
   */
  getPrediction(id: string, scope: PredictionScope): Promise<Prediction | null>;
  /**
   * Saves a batch of answers, written once. An answer whose id is already saved is not written
   * again: the saved one is returned with `saved: false`. Results are in the order given. Throws
   * when the batch was not stored.
   */
  savePredictions(predictions: Prediction[]): Promise<{prediction: Prediction; saved: boolean}[]>;
  /** Every saved answer for one version, model and settings, oldest first. */
  predictionsFor(promptVersionId: string, endpoint: EndpointId, settingsHash: string): Promise<Prediction[]>;
  /**
   * Removes answers: all of a project's, or (answers saved before they carried their project)
   * all for one version, model and settings.
   */
  deletePredictions(where: {projectId: string} | {promptVersionId: string; endpoint: EndpointId; settingsHash: string}): Promise<void>;
  /** Removes a project's tasks. */
  deleteTasks(projectId: string): Promise<void>;
}

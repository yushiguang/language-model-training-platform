import type {Answer, EndpointId, Example, FeatureSelection, ModelSettings, Prediction, PromptImage, Schema} from './types.ts';

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
export type TaskStopReason = 'user' | 'budget' | 'failures' | 'closed' | null;

export interface LabelingTask {
  id: string;
  projectId: string;
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
  /**
   * Pause when cost passes 120% of this; null = no budget check. The labeling app supports it,
   * but the MVP sets none: every start runs with no cost limit and the user stops it with Stop.
   */
  budgetUsd: number | null;
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
  purpose: TaskPurpose;
  promptVersionId: string;
  setupVersionId: string;
  endpoint: EndpointId;
  settings: ModelSettings;
  exampleIds: string[];
  budgetUsd?: number | null;
  parallel?: number;
  relabelInvalid?: boolean;
  createdBy: string;
}

/** How one run of a task was started. */
export interface RunOptions {
  /** Started by code without a click: this run's cost is added to `autoCostUsd`. */
  auto?: boolean;
  /**
   * Budget for this run alone: the run pauses with stopReason 'budget' once its own cost passes
   * 120% of it. Supported, but unused in the MVP (no cost limits).
   */
  budgetUsd?: number;
  /**
   * The user chose to continue a task paused for its budget: the budget grows by the share of
   * examples still to label (at the same estimate per example), so the run can go on.
   */
  extendBudget?: boolean;
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
  predictions(promptVersionId: string, endpoint: EndpointId, settingsHash: string): Promise<Map<string, Prediction>>;
  /**
   * Labels a few examples with an unsaved template (the prompt agent's try_template). Nothing is
   * saved: no task, no predictions. Each example is one call through the gateway.
   */
  tryTemplate(input: TryTemplateInput): Promise<TryTemplateRow[]>;
}

export interface TryTemplateInput {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  schema: Schema;
  settings: ModelSettings;
  examples: Example[];
  signal?: AbortSignal;
}

export interface TryTemplateRow {
  exampleId: string;
  answer: Answer | null;
  invalidReason: string | null;
  costUsd: number;
  error: string | null;
}

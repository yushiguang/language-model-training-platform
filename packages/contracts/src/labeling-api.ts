import type {EndpointId, ModelSettings, Prediction} from './types.ts';

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
  /** Examples whose call failed after the gateway's retries. */
  failed: number;
  failedExampleIds: string[];
  costUsd: number;
  /** Pause when cost passes 120% of this. null = no budget check. */
  budgetUsd: number | null;
  /** Examples labeled at once. */
  parallel: number;
  state: TaskState;
  stopReason: TaskStopReason;
  /** Set by Stop from any tab; the runner checks it every few seconds. */
  stopRequested: boolean;
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
  createdBy: string;
}

export interface LabelingContract {
  createTask(input: CreateTaskInput): Promise<LabelingTask>;
  /**
   * Runs the task in this page until it is done, stopped or paused. Returns the final task, or
   * null when another tab already runs it.
   */
  runTask(taskId: string): Promise<LabelingTask | null>;
  stopTask(taskId: string): Promise<void>;
  /** Clears the failed examples and runs the task again for them. */
  retryFailed(taskId: string): Promise<LabelingTask | null>;
  getTask(taskId: string): Promise<LabelingTask | null>;
  listTasks(projectId: string): Promise<LabelingTask[]>;
  /** True when some tab of this browser currently runs the task. */
  isRunning(taskId: string): Promise<boolean>;
  /** Saved predictions for one version, model and settings (first one per example wins). */
  predictions(promptVersionId: string, endpoint: EndpointId, settingsHash: string): Promise<Map<string, Prediction>>;
}

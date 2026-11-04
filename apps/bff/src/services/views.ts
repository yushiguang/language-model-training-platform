import type {JobState, LabelingRun, LabelingTask, TaskState, TrainingSet} from '@tsp/contracts';

/** Task states as pages show them. "Needs attention" shows as failed, with the task's message. */
export function jobState(s: TaskState): JobState {
  switch (s) {
    case 'running':
      return 'running';
    case 'queued':
    case 'paused':
      return 'paused';
    case 'needs_attention':
    case 'failed':
      return 'failed';
    case 'done':
      return 'done';
    case 'stopped':
      return 'stopped';
  }
}

/** Page view of an eval or optimiser labeling task. */
export const runView = (t: LabelingTask): LabelingRun => ({
  id: t.id,
  projectId: t.projectId,
  promptVersionId: t.promptVersionId,
  endpoint: t.endpoint,
  state: jobState(t.state),
  done: t.done,
  total: t.total,
  costUsd: t.costUsd,
  error: t.error,
  startedAt: t.startedAt ?? t.createdAt,
  finishedAt: t.finishedAt,
  auto: t.createdBy === 'auto',
});

/** A training set record with its task's live counters. */
export function trainingView(ts: TrainingSet, task: LabelingTask | undefined): TrainingSet {
  if (!task) return ts;
  return {
    ...ts,
    state: jobState(task.state),
    total: task.total,
    done: task.done,
    labeled: task.valid,
    invalid: task.invalid,
    failed: task.failed,
    costUsd: task.costUsd,
    error: task.error,
    finishedAt: task.finishedAt,
  };
}

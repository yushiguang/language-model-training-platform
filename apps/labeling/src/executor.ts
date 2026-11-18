import type {JobExecutor, LabelingContract} from '@yushiguang/sprint-contracts';

/**
 * The `labeling.runTask` job (deployment readiness spec, 3): runs one labeling task until it is
 * done, paused or stopped. The job points at the `LabelingTask`, which keeps the counters and the
 * failed list, so a job that runs again resumes from the saved answers. Arguments: `taskId`,
 * `trigger` (`user` or `system`, for metrics), `auto` (the cost counts as automatic spend), and
 * `retry` (Retry failed: label the failed examples again).
 *
 * A cancel is the user's Stop (`stopTask`). A lost lease leaves the task alone: the task's own
 * lock keeps a second runner off it until this one ends.
 */
export function labelingExecutor(labeling: LabelingContract): JobExecutor {
  return {
    kind: 'labeling.runTask',
    async run(job, ctl) {
      const taskId = String(job.args.taskId);
      const trigger = job.args.trigger === 'user' ? 'user' : 'system';
      const opts = job.args.auto ? {auto: true} : {};
      const stop = () => {
        if (ctl.cancelled()) void labeling.stopTask(taskId);
      };
      ctl.signal.addEventListener('abort', stop);
      try {
        const t = job.args.retry ? await labeling.retryFailed(taskId, trigger, opts) : await labeling.runTask(taskId, trigger, opts);
        if (!t) return {state: 'cancelled', error: 'Another runner is labeling this task.'};
        if (t.state === 'done') return {state: 'done'};
        if (t.state === 'needs_attention' || t.state === 'failed') return {state: 'failed', error: t.error ?? 'Some examples could not be labeled.'};
        return {state: 'paused', error: `The task ${t.state === 'stopped' ? 'was stopped' : 'paused'}.`};
      } finally {
        ctl.signal.removeEventListener('abort', stop);
      }
    },
  };
}

import type {JobExecutor, OptimiserContract} from '@yushiguang/sprint-contracts';

/**
 * The `optimiser.run` job (deployment readiness spec, 3): runs one saved Optimiser run until it
 * ends. The job points at the run record; the run keeps its rounds, so a job that runs again
 * goes on from the step the run stopped at. A cancel is the user's Stop. A lost lease leaves the
 * run alone: the runner that took the job over resumes it from the saved record, and the run's
 * own lock (plus the labeling locks behind its `label` calls) keeps that runner off the work
 * until this one ends. That premise holds across processes only when the composition root wires
 * the Optimiser and labeling with shared locks (`leaseLocks` over `Platform.lockStore`,
 * docs/integration.md; issue #46); with per-process locks it holds only inside this process.
 */
export function optimiserExecutor(optimiser: OptimiserContract): JobExecutor {
  return {
    kind: 'optimiser.run',
    async run(job, ctl) {
      const runId = String(job.args.runId);
      const stop = () => {
        if (ctl.cancelled()) void optimiser.stopRun(runId);
      };
      ctl.signal.addEventListener('abort', stop);
      try {
        const run = await optimiser.execute(runId);
        if (!run) return {state: 'cancelled', error: 'Another runner works on this run.'};
        if (run.state === 'done') return {state: 'done'};
        if (run.state === 'failed') return {state: 'failed', error: run.error ?? 'The run failed.'};
        return {state: 'cancelled', error: 'Stopped.'};
      } finally {
        ctl.signal.removeEventListener('abort', stop);
      }
    },
  };
}

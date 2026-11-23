import type {JobExecutor, OptimiserContract, OptimiserPosition} from '@yushiguang/sprint-contracts';
import {OPTIMISER_LABELING_STEPS} from '@yushiguang/sprint-contracts';

/** The position a follow-up job goes on from (its args `round` and `step`), if it is one. */
function positionOf(args: Record<string, unknown>): OptimiserPosition | undefined {
  const step = OPTIMISER_LABELING_STEPS.find(s => s === args.step);
  return step && typeof args.round === 'number' ? {round: args.round, step} : undefined;
}

/**
 * The `optimiser.run` job (docs/design/server.md, 4.4): runs one saved Optimiser run until it
 * ends or waits for a labeling job of its own. It only computes (a `compute:<tenantId>` job):
 * each labeling step is queued as a `labeling.runTask` job whose `finally` queues the
 * `optimiser.run` that goes on from that step (args `runId`, `round`, `step`). A run that waits
 * ends this job done; a cancel is the user's Stop. A lost lease leaves the run alone: the runner
 * that took the job over resumes it from the saved record, and the run's own lock keeps it off
 * the work until this one ends. Across processes that holds only when the composition root wires
 * the Optimiser with shared locks (`leaseLocks` over `Platform.lockStore`, docs/integration.md;
 * issue #46). The run goes on as the job's caller (`job.ctx`): the person who queued it.
 */
export function optimiserExecutor(optimiser: OptimiserContract): JobExecutor {
  return {
    kind: 'optimiser.run',
    // A follow-up that finds the run's lock still held by the job before it is tried again.
    retries: 3,
    async run(job, ctl) {
      const runId = String(job.args.runId);
      const at = positionOf(job.args);
      const stop = () => {
        if (ctl.cancelled()) optimiser.stopRun(job.ctx, runId).catch(() => undefined);
      };
      ctl.signal.addEventListener('abort', stop);
      try {
        const run = await optimiser.execute(job.ctx, runId, at);
        if (!run) {
          // Still waiting at its position: the runner before this one has not let go yet.
          const now = at ? await optimiser.getRun(runId) : null;
          if (now && now.state === 'running' && now.round === at!.round && now.step === at!.step) throw new Error('Another runner still works on this run.');
          return {state: 'cancelled', error: at ? 'The run has gone on.' : 'Another runner works on this run.'};
        }
        if (run.state === 'done') return {state: 'done'};
        if (run.state === 'failed') return {state: 'failed', error: run.error ?? 'The run failed.'};
        // Waiting for its labeling job, which goes on with it.
        if (run.state === 'running') return {state: 'done'};
        return {state: 'cancelled', error: 'Stopped.'};
      } finally {
        ctl.signal.removeEventListener('abort', stop);
      }
    },
  };
}

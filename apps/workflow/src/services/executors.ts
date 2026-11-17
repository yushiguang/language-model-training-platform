import type {JobExecutor} from '@sprint/contracts';
import type {Instance} from './app.ts';
import {runSample} from './dataset.ts';
import {runDelete} from './projects.ts';
import {runReport} from './work.ts';

/**
 * The work the workflow owns, as job executors (deployment readiness spec, 3). Each runs in the
 * scope of the job's caller, so who did what stays who asked for it.
 */
export function workflowExecutors(inst: Instance): JobExecutor[] {
  return [
    {kind: 'report.build', run: job => runReport(inst.scope(job.ctx), job)},
    {kind: 'dataset.sample', run: (job, ctl) => runSample(inst.scope(job.ctx), job, ctl)},
    // Deleting is safe to run again, so a failed try is tried twice more.
    {kind: 'project.delete', retries: 2, run: job => runDelete(inst.scope(job.ctx), job)},
  ];
}

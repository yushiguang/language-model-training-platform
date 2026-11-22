import type {Job, JobExecutor, PermissionPoint} from '@yushiguang/sprint-contracts';
import type {Instance, Scope} from './app.ts';
import {authorize} from './access.ts';
import {runSample} from './dataset.ts';
import {runDelete} from './projects.ts';
import {INGEST_RETRIES, runIngest} from './sources.ts';
import {runReport} from './work.ts';

/**
 * The work the workflow owns, as job executors (deployment readiness spec, 3). Each runs in the
 * scope of the job's caller, so who did what stays who asked for it.
 */
export function workflowExecutors(inst: Instance): JobExecutor[] {
  /**
   * The job's scope, once its caller is checked again (docs/design/server.md, 2.2): a job runs
   * later, so a caller who lost the permission or left the tenant since cannot finish the work.
   */
  const as = async (job: Job, permission: PermissionPoint): Promise<Scope> => {
    const w = inst.scope(job.ctx);
    await authorize(w, `job.${job.kind}`, permission, job.projectId ?? undefined);
    return w;
  };
  return [
    {kind: 'report.build', run: async job => runReport(await as(job, 'project_write'), job)},
    {kind: 'dataset.sample', run: async (job, ctl) => runSample(await as(job, 'project_write'), job, ctl)},
    // An import goes on from what it wrote, so a failed try is tried again.
    {kind: 'source.ingest', retries: INGEST_RETRIES, run: async (job, ctl) => runIngest(await as(job, 'tenant_write'), job, ctl)},
    // Deleting is safe to run again, so a failed try is tried twice more.
    {kind: 'project.delete', retries: 2, run: async job => runDelete(await as(job, 'project_write'), job)},
  ];
}

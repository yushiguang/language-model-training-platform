import {AccessDeniedError, type Job, type JobControl, type JobExecutor, type JobOutcome, type PermissionPoint} from '@yushiguang/sprint-contracts';
import type {Instance, Scope} from './app.ts';
import {authorize, NO_PROJECT} from './access.ts';
import {runSample} from './dataset.ts';
import {runDelete} from './projects.ts';
import {failImport, INGEST_RETRIES, runIngest} from './sources.ts';
import {runReport} from './work.ts';
import {runNotify} from './notify.ts';

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
  /** A refused caller fails the job at once: trying again would be refused again. */
  const checked =
    (permission: PermissionPoint, run: (w: Scope, job: Job, ctl: JobControl) => Promise<JobOutcome>, refused?: (job: Job, error: string) => Promise<void>, dropRefused = false) =>
    async (job: Job, ctl: JobControl): Promise<JobOutcome> => {
      let w: Scope;
      try {
        w = await as(job, permission);
      } catch (e) {
        if (!(e instanceof AccessDeniedError) && (e as Error).message !== NO_PROJECT) throw e;
        await refused?.(job, (e as Error).message).catch(() => undefined);
        return dropRefused ? {state: 'done'} : {state: 'failed', error: (e as Error).message};
      }
      return run(w, job, ctl);
    };
  return [
    {kind: 'report.build', run: checked('project_write', (w, job) => runReport(w, job))},
    {kind: 'dataset.sample', run: checked('project_write', runSample)},
    // An import goes on from what it wrote, so a failed try is tried again. A refused one marks
    // its file failed at once, so it does not wait as importing.
    {kind: 'source.ingest', retries: INGEST_RETRIES, run: checked('tenant_write', runIngest, (job, error) => failImport(inst.scope(job.ctx), String(job.args.fileId), error))},
    // Deleting is safe to run again, so a failed try is tried twice more.
    {kind: 'project.delete', retries: 2, run: checked('project_write', (w, job) => runDelete(w, job))},
    // A notification is best effort: one whose reader lost access to the project is dropped, not failed.
    {kind: 'notify.send', retries: 0, run: checked('read', runNotify, undefined, true)},
  ];
}

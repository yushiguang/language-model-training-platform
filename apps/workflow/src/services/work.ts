import type {EndpointId, Job, JobOutcome, JobRequest, LabelingTask, ProjectState, PromptVersion, StartedRuns} from '@yushiguang/sprint-contracts';
import {autoSpendUsd, dueStarts, settingsHash, versionLabel, type DueStart, systemConfig, msg} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, findTask, settingsFor} from './evaluation.ts';
import {modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {lockHoldout} from './governance.ts';

/**
 * Background work (deployment readiness spec, 3). The workflow decides what should run (system
 * triggers: a new version is scored) and queues it as jobs; the job module runs them, each kind
 * through the executor of the app that owns it. A command returns once its work is queued, and
 * pages read progress back through `loadProjectState`. Every start is keyed, so asking again
 * while the work is queued or running returns the same job.
 */

/** The jobs of a project that are queued or running. */
export const activeJobs = (w: Scope, projectId: string, kinds?: Job['kind'][]) => w.jobs.list(w.ctx, {projectId, states: ['queued', 'running'], ...(kinds ? {kinds} : {})});

/** Builds the report of a version on a model from its saved answers: the `report.build` job. */
const reportJob = (projectId: string, version: PromptVersion, endpoint: EndpointId, extra: {auto?: boolean; taskId?: string} = {}): JobRequest => ({
  kind: 'report.build',
  projectId,
  args: {promptVersionId: version.id, endpoint, auto: !!extra.auto, taskId: extra.taskId ?? null},
  idempotencyKey: `report:${version.id}:${endpoint}`,
});

/**
 * Labels the eval set with a version on every chosen model (or just `only`), then scores it: per
 * model, finds or creates the labeling task (a reload resumes it), and queues a `labeling.runTask`
 * job followed by `report.build`. Returns the tasks' ids once queued.
 * `auto`: started by code without a click (the tick, or an agent's start tool).
 */
export async function scoreVersion(w: Scope, projectId: string, version: PromptVersion, only?: EndpointId, opts: {auto?: boolean} = {}): Promise<StartedRuns> {
  const state = await loadProjectState(w, projectId);
  if (!state?.setup) throw new Error('This project does not exist.');
  const setup = state.setup;
  const exampleIds = state.examples.filter(e => e.split === 'eval').map(e => e.id);
  const runIds: string[] = [];
  for (const m of setup.models.filter(x => !only || x.endpoint === only)) {
    // One start at a time per version and model in this instance: two clicks never create two tasks.
    const id = await w.once(`score:${version.id}:${m.endpoint}`, async () => {
      const settings = settingsFor(setup, m.endpoint);
      const task =
        (await findTask(w, projectId, version, m.endpoint, settingsHash(settings), exampleIds, ['eval', 'optimiser'])) ??
        (await w.labeling.createTask({
          projectId,
          purpose: 'eval',
          promptVersionId: version.id,
          setupVersionId: setup.id,
          endpoint: m.endpoint,
          settings,
          exampleIds,
          // 'auto' marks scoring code started without a click.
          createdBy: opts.auto ? 'auto' : (await w.user()).name,
        }));
      await queueTask(w, projectId, version, task, opts);
      return task.id;
    });
    if (id) runIds.push(id);
  }
  w.emitChange(projectId);
  return {runIds};
}

/**
 * The `report.build` executor: builds the report from the saved answers, unless one exists for
 * the project's current gold labels. After scoring (`taskId` set), it records `version_scored`.
 */
export async function runReport(w: Scope, job: Job): Promise<JobOutcome> {
  const projectId = job.projectId!;
  const state = await loadProjectState(w, projectId);
  const v = state?.versions.find(x => x.id === job.args.promptVersionId);
  if (!state?.setup || !v) return {state: 'cancelled', error: 'The project or the version no longer exists.'};
  const endpoint = String(job.args.endpoint) as EndpointId;
  const report = await buildReport(w, projectId, state.setup, v, endpoint, state.examples, state.gold, state.contextId);
  if (report && job.args.taskId) {
    const task = await w.labeling.getTask(String(job.args.taskId));
    const passed = (await loadProjectState(w, projectId))?.reports.some(r => r.id === report.id && r.passed) ?? false;
    w.tm.event('version_scored', {version_id: v.id, slot: endpoint, lowest_field_macro_f1: report.metrics.macroF1, passed, cost_usd: task?.costUsd ?? 0, trigger: job.args.auto ? 'auto' : 'user'});
  }
  return {state: 'done'};
}

/**
 * Queues one labeling task to run, followed by its report (or just the report when the task is
 * done). One job per task at a time (its idempotency key).
 */
async function queueTask(w: Scope, projectId: string, version: PromptVersion, task: LabelingTask, opts: {auto?: boolean} = {}) {
  const report = reportJob(projectId, version, task.endpoint, {auto: opts.auto, taskId: task.id});
  if (task.state === 'done') await w.jobs.enqueue(w.ctx, report);
  else
    await w.jobs.enqueue(w.ctx, {
      kind: 'labeling.runTask',
      projectId,
      args: {taskId: task.id, promptVersionId: version.id, endpoint: task.endpoint, trigger: opts.auto ? 'system' : 'user', auto: !!opts.auto, retry: task.state === 'needs_attention'},
      idempotencyKey: `label:${task.id}`,
      then: report,
    });
}

/**
 * Is this due start already queued or running? A resume names its task, so two paused tasks of
 * one version and model are two starts (#25); scoring a version is one start per version and model.
 */
const going = (jobs: Job[], d: DueStart) =>
  d.taskId
    ? jobs.some(j => j.kind === 'labeling.runTask' && j.args.taskId === d.taskId)
    : jobs.some(j => (j.kind === 'labeling.runTask' || j.kind === 'report.build') && j.args.promptVersionId === d.versionId && j.args.endpoint === d.endpoint);

/**
 * Queues one due start without a click and records it: an `auto_start` audit record and the
 * `sprint_auto_starts_total` metric.
 */
async function autoStart(w: Scope, state: ProjectState, d: DueStart) {
  const {catalog} = w;
  const projectId = state.project.id;
  const spent = autoSpendUsd(state);
  const model = modelName(state, d.endpoint);
  const v = state.versions.find(x => x.id === d.versionId);
  if (!v) return;
  // A resume goes on with the task that paused, not with scoring the version's current eval set.
  const task = d.taskId ? await w.labeling.getTask(d.taskId) : null;
  if (d.taskId && (!task || task.projectId !== projectId)) return;
  if (task) await queueTask(w, projectId, v, task, {auto: true});
  else await scoreVersion(w, projectId, v, d.endpoint, {auto: true});
  await postEvent(w, projectId, 'auto', 'workflow', msg('started scoring {version} on {model}', {version: versionLabel(v), model}), {path: '/prompt'});
  await catalog.audit(projectId, 'system', 'auto_start', {what: d.what, version: d.versionId, endpoint: d.endpoint, estimateUsd: d.estimateUsd, autoSpendUsd: spent});
  w.tm.counter('sprint_auto_starts_total', {what: d.what, decision: 'started'});
  w.tm.event('auto_started', {what: d.what, estimate_usd: d.estimateUsd, project_auto_spend_usd: spent});
}

/**
 * One check of what should run in a project: it only queues work, never runs it in the request
 * (review G8). The browser's pages call it (`tick`); a server calls it for every project from a
 * cron job (`sweep`) and sets `tickFromPages: false`. Both use the same keys, so both may run.
 */
export async function drive(w: Scope, state: ProjectState) {
  const {catalog, labeling} = w;
  const projectId = state.project.id;
  const jobs = await activeJobs(w, projectId);

  // An Optimiser run left "running" by a closed page shows as paused. One still running in
  // another tab holds its lock, and one queued here is about to run: both are left alone.
  const {optimiser} = w;
  for (const o of state.optimisation) {
    if (o.state !== 'running' || !optimiser || (await optimiser.isRunning(o.id))) continue;
    if (jobs.some(j => j.kind === 'optimiser.run' && j.args.runId === o.id)) continue;
    if (await w.locks.isHeld(optimiserLock(projectId, o.endpoint))) continue;
    const fresh = await optimiser.getRun(o.id);
    if (fresh?.state === 'running' && !(await optimiser.isRunning(o.id))) await catalog.patch('optimisation_runs', o.id, {state: 'paused'});
  }
  // A task left running by a closed page shows as paused (listTasks marks it).
  await labeling.listTasks(projectId);

  // Reports for scoring that finished while no page built them cost nothing: always built.
  if (state.setup?.schema) {
    for (const r of state.runs.filter(r => r.state === 'done')) {
      // Only a first report: one a gold edit archived is rebuilt by the next reader of scores (lazy).
      if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint)) continue;
      const v = state.versions.find(v => v.id === r.promptVersionId);
      if (v) await w.jobs.enqueue(w.ctx, reportJob(projectId, v, r.endpoint));
    }
  }

  // Paid work the workflow would start now: all of it starts here, with no cost limit (the user
  // stops a costly run with its Stop button).
  const fresh = (await loadProjectState(w, projectId)) ?? state;
  for (const d of dueStarts(fresh)) {
    if (going(jobs, d)) continue;
    await autoStart(w, fresh, d);
  }
}

/** The pages' check (`BffContract.tick`): a no-op when a server drives the work instead (G8). */
export async function tick(w: Scope, state: ProjectState) {
  if (w.tickFromPages === false) return;
  await drive(w, state);
}

/**
 * Auto Optimise: starts a run of up to `maxRounds` changes on the project's model (one model per
 * project), from `startVersionId` (the version selected in the list; left out: the best scored
 * version), or goes on with the open run. Returns once the `optimiser.run` job is queued.
 * `auto`: an agent's start tool, after the user asked in Ask AI.
 */
export async function startOptimiser(w: Scope, projectId: string, maxRounds = systemConfig().optimiser.defaultMaxRounds, startVersionId?: string, opts: {auto?: boolean} = {}): Promise<{runId: string}> {
  const state = await loadProjectState(w, projectId);
  const endpoint = state?.setup?.models[0]?.endpoint;
  if (!state || !endpoint) throw new Error('Pick a labeling model in Project Settings first.');
  // The Optimiser reads examples: the halves are fixed from here on (spec 1.0.0, 4.2).
  await lockHoldout(w, projectId);
  const run = await optimiserService(w).startRun(w.ctx, {projectId, endpoint, maxRounds, startVersionId, auto: opts.auto});
  await queueRun(w, projectId, run.id);
  return {runId: run.id};
}

const queueRun = async (w: Scope, projectId: string, runId: string) => {
  await w.jobs.enqueue(w.ctx, {kind: 'optimiser.run', projectId, args: {runId}, idempotencyKey: `optimiser:${projectId}`});
  w.emitChange(projectId);
};

/** A run of this project, or an error a client can show. */
async function runOf(w: Scope, projectId: string, runId: string) {
  const run = await optimiserService(w).getRun(runId);
  if (!run || run.projectId !== projectId) throw new Error('This run does not exist.');
  return run;
}

/** The user's Stop on a run: cancels its job (the executor stops the loop), or stops it here. */
export async function stopOptimiser(w: Scope, projectId: string, runId: string): Promise<void> {
  await runOf(w, projectId, runId);
  const jobs = (await activeJobs(w, projectId, ['optimiser.run'])).filter(j => j.args.runId === runId);
  for (const j of jobs) await w.jobs.cancel(w.ctx, j.id);
  if (!jobs.length) await optimiserService(w).stopRun(w.ctx, runId);
}

/** Retry on a Failed run, or Resume on a paused one: queues it again; it goes on from the step it stopped at. */
export async function retryOptimiser(w: Scope, projectId: string, runId: string): Promise<{runId: string}> {
  const run = await runOf(w, projectId, runId);
  if (!['failed', 'paused', 'running'].includes(run.state)) throw new Error('This run has ended.');
  await queueRun(w, projectId, runId);
  return {runId};
}

function optimiserService(w: Scope) {
  const {optimiser} = w;
  if (!optimiser) throw new Error('The Optimiser is not available here.');
  return optimiser;
}

/** The lock an optimiser run on one model holds for as long as it runs, in any tab (the name `@yushiguang/sprint-optimiser` uses). */
const optimiserLock = (projectId: string, endpoint: string) => `optimiser:${projectId}:${endpoint}`;

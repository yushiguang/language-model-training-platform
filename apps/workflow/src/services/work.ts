import type {EndpointId, Job, JobOutcome, JobRequest, LabelingTask, OptimisationRun, OptimiserLabelRequest, OptimiserLabeling, OptimiserPosition, ProjectState, PromptVersion, SetupVersion, StartedRuns} from '@yushiguang/sprint-contracts';
import {OPTIMISER_LABELING_STEPS} from '@yushiguang/sprint-contracts';
import {autoSpendUsd, dueStarts, settingsHash, versionLabel, type DueStart, systemConfig, msg} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {tenantOf} from './sources.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, findTask, settingsFor} from './evaluation.ts';
import {modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {lockHoldout} from './governance.ts';
import {computeKey, modelKey} from './queue.ts';
import {notifyWhenEnded} from './notify.ts';

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
const reportJob = (w: Scope, projectId: string, version: PromptVersion, endpoint: EndpointId, extra: {auto?: boolean; taskId?: string} = {}): JobRequest => ({
  kind: 'report.build',
  projectId,
  concurrencyKey: computeKey(w),
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
          tenantId: tenantOf(w),
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
  const report = reportJob(w, projectId, version, task.endpoint, {auto: opts.auto, taskId: task.id});
  if (task.state === 'done') await w.jobs.enqueue(w.ctx, report);
  else
    await w.jobs.enqueue(w.ctx, {
      kind: 'labeling.runTask',
      projectId,
      concurrencyKey: modelKey(w, task.endpoint),
      args: {taskId: task.id, promptVersionId: version.id, endpoint: task.endpoint, trigger: opts.auto ? 'system' : 'user', auto: !!opts.auto, retry: task.state === 'needs_attention'},
      idempotencyKey: `label:${task.id}`,
      then: report,
      // Tells whoever started it how it ended (docs/design/server.md, 8).
      finally: notifyWhenEnded(w, projectId, {about: 'labeling', taskId: task.id}),
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

  // An Optimiser run "running" with no job of its own and no labeling job (docs/design/server.md,
  // 4.4): one left at a labeling step goes on from it (the follow-up reads how its labeling
  // ended); any other was lost (a closed page, a worker lost too often) and is Failed, with Retry.
  // One running in another runner holds its lock, and one with a job is about to run: both are
  // left alone.
  const {optimiser} = w;
  for (const o of state.optimisation) {
    if (o.state !== 'running' || !optimiser || (await optimiser.isRunning(o.id))) continue;
    if (jobs.some(j => (j.kind === 'optimiser.run' && j.args.runId === o.id) || (j.kind === 'labeling.runTask' && j.args.optimiserRunId === o.id))) continue;
    if (await w.locks.isHeld(optimiserLock(projectId, o.endpoint))) continue;
    const fresh = await optimiser.getRun(o.id);
    if (fresh?.state !== 'running' || (await optimiser.isRunning(o.id))) continue;
    const step = OPTIMISER_LABELING_STEPS.find(s => s === fresh.step);
    if (step && !fresh.stopRequested) {
      // Its own key: the follow-up the labeling job's end queues (as the person who started the
      // run) is never taken over by this one; the second of the two to run finds nothing to do.
      const at = {round: fresh.round, step};
      await w.jobs.enqueue(w.ctx, {...goOnAfter(w, projectId, o.id, at), idempotencyKey: `optimiser:${o.id}:${at.round}:${at.step}:sweep`});
      continue;
    }
    // Under the run's lock, everything read again: a job queued or a runner started meanwhile keeps it.
    await w.locks.run(optimiserLock(projectId, o.endpoint), async () => {
      if (await optimiser.isRunning(o.id)) return;
      const live = await activeJobs(w, projectId, ['optimiser.run', 'labeling.runTask']);
      if (live.some(j => (j.kind === 'optimiser.run' ? j.args.runId : j.args.optimiserRunId) === o.id)) return;
      const run = await optimiser.getRun(o.id);
      if (run?.state !== 'running') return;
      // A Stop asked of a runner that went away: ended as stopped.
      if (run.stopRequested) return endStopped(w, run);
      if (OPTIMISER_LABELING_STEPS.some(s => s === run.step)) return;
      const last = run.history.at(-1);
      const history = last?.outcome === 'running' ? [...run.history.slice(0, -1), {...last, outcome: 'failed' as const, step: last.step ?? run.step ?? undefined}] : run.history;
      await catalog.patch('optimisation_runs', o.id, {state: 'failed', error: 'The Optimiser stopped unexpectedly. Retry goes on from where it stopped.', finishedAt: now(), step: null, stepStartedAt: null, stepVersionId: null, history});
    });
  }
  // A task left running by a closed page shows as paused (listTasks marks it).
  await labeling.listTasks(projectId);

  // Reports for scoring that finished while no page built them cost nothing: always built.
  if (state.setup?.schema) {
    for (const r of state.runs.filter(r => r.state === 'done')) {
      // Only a first report: one a gold edit archived is rebuilt by the next reader of scores (lazy).
      if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint)) continue;
      const v = state.versions.find(v => v.id === r.promptVersionId);
      if (v) await w.jobs.enqueue(w.ctx, reportJob(w, projectId, v, r.endpoint));
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

/**
 * Queues a run's `optimiser.run` (a start, Retry or Resume). It only computes, so it waits for
 * compute; its labeling steps are labeling jobs of their own on the model's key
 * (docs/design/server.md, 4.4). Every `optimiser.run` carries the notice, which is sent only for
 * the job that ended the run (8.2).
 */
const queueRun = async (w: Scope, projectId: string, runId: string) => {
  await w.jobs.enqueue(w.ctx, {kind: 'optimiser.run', projectId, concurrencyKey: computeKey(w), args: {runId}, idempotencyKey: `optimiser:${projectId}`, finally: notifyWhenEnded(w, projectId, {about: 'optimiser', runId})});
  w.emitChange(projectId);
};

/** The `optimiser.run` that goes on once the labeling at `at` ended: queued once per position. */
const goOnAfter = (w: Scope, projectId: string, runId: string, at: OptimiserPosition): JobRequest => ({
  kind: 'optimiser.run',
  projectId,
  concurrencyKey: computeKey(w),
  args: {runId, round: at.round, step: at.step},
  idempotencyKey: `optimiser:${runId}:${at.round}:${at.step}`,
  finally: notifyWhenEnded(w, projectId, {about: 'optimiser', runId}),
});

/**
 * One labeling step of an Optimiser run (`OptimiserHost.label`): finds or creates the task for
 * these examples, version, model and settings (answers already saved are reused), and queues its
 * labeling as a `labeling.runTask` job on the model's key, with the run's position in its args
 * and the run's follow-up as its `finally`. The run then waits; it never labels inside its own
 * job. With `start` false, labeling that ended without its answers is reported, not queued again.
 */
export async function queueOptimiserLabeling(w: Scope, setup: SetupVersion, version: PromptVersion, req: OptimiserLabelRequest & {exampleIds: string[]}): Promise<OptimiserLabeling> {
  const {projectId, endpoint, exampleIds, pass, runId, at} = req;
  // pass 2: the confirmation of a pass, a fresh labeling of the same examples.
  const settings = pass && pass > 1 ? {...settingsFor(setup, endpoint), pass} : settingsFor(setup, endpoint);
  const hash = settingsHash(settings);
  const jobs = await activeJobs(w, projectId, ['labeling.runTask']);
  const jobOf = (t: LabelingTask) => jobs.find(j => j.args.taskId === t.id);
  // A task this run may use: done, labeled by this run's own job, or idle with no Stop pending.
  // One another job labels now (scoring of the same version, a run stopped a moment ago) is never
  // waited on: its job does not go on with this run. The run then uses a task of its own, queued
  // behind that job on the model's key, which reuses those answers.
  const usable = (t: LabelingTask | null): t is LabelingTask => !!t && (t.state === 'done' || (jobOf(t) ? jobOf(t)!.args.optimiserRunId === runId : !t.stopRequested));
  const shared = await findTask(w, projectId, version, endpoint, hash, exampleIds, ['eval', 'optimiser']);
  let task = usable(shared) ? shared : null;
  if (!task) {
    const own = (await w.labeling.listTasks(projectId)).filter(t => t.purpose === 'optimiser' && t.promptVersionId === version.id && t.endpoint === endpoint && t.settingsHash === hash && t.exampleIds.length === exampleIds.length && exampleIds.every(id => t.exampleIds.includes(id)));
    task = own.find(usable) ?? null;
  }
  if (task?.state === 'done') return {state: 'done', task};
  if (task && jobOf(task)) return {state: 'queued', taskId: task.id};
  if (!req.start) return {state: 'unfinished', task: task ?? shared, error: task ? (task.error ?? `the labeling ended as ${task.state}`) : 'the labeling was never started'};
  const queue = async (t: LabelingTask) =>
    w.jobs.enqueue(w.ctx, {
      kind: 'labeling.runTask',
      projectId,
      concurrencyKey: modelKey(w, endpoint),
      // A task that failed or was stopped labels what it lacks again (Retry failed clears its failed list).
      args: {taskId: t.id, promptVersionId: version.id, endpoint, trigger: 'system', auto: false, retry: t.state !== 'queued', optimiserRunId: runId, round: at.round, step: at.step},
      idempotencyKey: `label:${t.id}`,
      finally: goOnAfter(w, projectId, runId, at),
    });
  const create = () => w.labeling.createTask({projectId, tenantId: tenantOf(w), purpose: 'optimiser', promptVersionId: version.id, setupVersionId: setup.id, endpoint, settings, exampleIds, createdBy: 'optimiser'});
  const stopped = async () => {
    const run = await w.optimiser?.getRun(runId);
    return !!run && (run.state === 'stopped' || run.stopRequested === true);
  };
  // A run stopped meanwhile queues nothing (its runner ends it as stopped at its next save).
  if (await stopped()) return {state: 'unfinished', task, error: 'the run was stopped'};
  task ??= await create();
  // Another start queued a job for the same task just now (the same idempotency key): that job does
  // not go on with this run, so the run labels in a task of its own.
  let job = await queue(task);
  if (job.args.optimiserRunId !== runId) {
    task = await create();
    job = await queue(task);
  }
  // A Stop saved meanwhile may have listed the run's jobs before this one: cancelled here, so no
  // labeling of a stopped run is paid for (Stop saves first, then cancels what it finds).
  if (await stopped()) {
    await w.jobs.cancel(w.ctx, job.id);
    await w.labeling.stopTask(task.id);
  }
  w.emitChange(projectId);
  return {state: 'queued', taskId: task.id};
}

/** A run of this project, or an error a client can show. */
async function runOf(w: Scope, projectId: string, runId: string) {
  const run = await optimiserService(w).getRun(runId);
  if (!run || run.projectId !== projectId) throw new Error('This run does not exist.');
  return run;
}

/**
 * The user's Stop on a run (docs/design/server.md, 4.4), without relying on any runner's memory:
 * with the run's lock free, the run is saved as stopped under it; while a runner holds it, the
 * Stop is saved as `stopRequested`, which the runner reads before its next save and then ends the
 * run as stopped itself (a runner never writes that field, so the request is never lost). Then
 * the run's queued and running `optimiser.run` and labeling jobs are cancelled and those tasks
 * stopped (a running one stops calling the model); the follow-up a cancelled labeling job queues
 * finds the run stopped, or ends it as stopped.
 */
export async function stopOptimiser(w: Scope, projectId: string, runId: string): Promise<void> {
  const run = await runOf(w, projectId, runId);
  const optimiser = optimiserService(w);
  const how = await saveStop(w, projectId, runId, run.endpoint);
  // Read after the Stop is saved: whoever queues labeling from now on sees it (`queueOptimiserLabeling`).
  const jobs = (await activeJobs(w, projectId, ['optimiser.run', 'labeling.runTask'])).filter(j => (j.kind === 'optimiser.run' ? j.args.runId : j.args.optimiserRunId) === runId);
  for (const j of jobs) await w.jobs.cancel(w.ctx, j.id);
  await optimiser.stopRun(w.ctx, runId);
  for (const j of jobs.filter(j => j.kind === 'labeling.runTask')) await w.labeling.stopTask(String(j.args.taskId));
  if (!how) return;
  // The action line is best effort: the run has stopped either way, even if it cannot be written.
  await postEvent(w, projectId, 'stop', 'user', msg('stopped the Optimiser'), {path: '/prompt'}).catch(() => undefined);
  w.emitChange(projectId);
}

/** What ending a stopped run records when no runner does: the same metrics a runner records. */
function stoppedMetrics(w: Scope, run: OptimisationRun) {
  const kept = run.history.filter(h => h.outcome === 'kept');
  w.tm.counter('sprint_optimiser_runs_total', {slot: run.endpoint, outcome: 'stopped'});
  w.tm.event('optimiser_stopped_by_user', {slot: run.endpoint, candidates: run.candidates, cost_usd: run.costUsd});
  w.tm.event('optimiser_ended', {slot: run.endpoint, outcome: 'stopped', rounds: run.round, candidates: run.candidates, kept: kept.length, cost_usd: run.costUsd, best_lowest_field_macro_f1: kept.length ? Math.max(...kept.map(h => h.score ?? 0)) : null});
}

/**
 * Saves the Stop: `saved` (stopped here, under the run's lock, everything read again inside),
 * `asked` (a runner holds the lock: `stopRequested` for it to act on), or null (already ended).
 */
async function saveStop(w: Scope, projectId: string, runId: string, endpoint: EndpointId): Promise<'saved' | 'asked' | null> {
  const optimiser = optimiserService(w);
  const open = (r: OptimisationRun | null): r is OptimisationRun => !!r && ['running', 'paused', 'failed'].includes(r.state);
  const locked = await w.locks.run(optimiserLock(projectId, endpoint), async () => {
    const run = await optimiser.getRun(runId);
    if (!open(run)) return 'ended' as const;
    if (await optimiser.isRunning(runId)) return 'busy' as const;
    await endStopped(w, run);
    return 'saved' as const;
  });
  if (locked === 'saved') return 'saved';
  if (locked === 'ended') return null;
  // A runner holds the run (the lock is busy): it reads the request before its next save.
  if (!open(await optimiser.getRun(runId))) return null;
  await w.catalog.patch('optimisation_runs', runId, {stopRequested: true});
  return 'asked';
}

/** Saves a run with no runner as stopped (its round in progress too) and records its end. */
async function endStopped(w: Scope, run: OptimisationRun) {
  const last = run.history.at(-1);
  const history = last?.outcome === 'running' ? [...run.history.slice(0, -1), {...last, outcome: 'stopped' as const}] : run.history;
  await w.catalog.patch('optimisation_runs', run.id, {state: 'stopped', stopReason: 'user', error: null, finishedAt: now(), step: null, stepStartedAt: null, stepVersionId: null, history});
  stoppedMetrics(w, run);
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

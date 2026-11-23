import {SYSTEM_CALLER, type Job, type JobOutcome, type JobRequest, type Msg, type Notification, type NotificationKind} from '@yushiguang/sprint-contracts';
import {msg, msgText, versionLabel} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';
import {modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {computeKey} from './queue.ts';

/**
 * Notifications (docs/design/server.md, 8). Best effort: a send that fails is logged and counted
 * (`sprint_notifications_total{outcome="error"}`) and never fails the work that sent it. Without a
 * `NotificationPort` nothing is sent.
 */
export async function notify(w: Scope, n: {userIds: string[]; kind: NotificationKind; projectId: string | null; link: string; title: Msg; msg: Msg}): Promise<void> {
  const userIds = [...new Set(n.userIds.filter(Boolean))];
  if (!w.notifications || !userIds.length) return;
  const notification: Notification = {userIds, kind: n.kind, projectId: n.projectId, text: msgText(n.msg), link: n.link, title: msgText(n.title), msg: n.msg};
  try {
    await w.notifications.send(notification);
    w.tm.counter('sprint_notifications_total', {notification: n.kind, outcome: 'ok'});
  } catch (e) {
    w.tm.counter('sprint_notifications_total', {notification: n.kind, outcome: 'error'});
    console.warn(`[notification] ${n.kind} could not be sent: ${(e as Error).message}`);
  }
}

/** What a `notify.send` job tells about: the labeling task or Optimiser run whose job it follows. */
type Subject = {about: 'labeling'; taskId: string} | {about: 'optimiser'; runId: string};

/**
 * The `finally` of a labeling or Optimiser job: once that job ends in any way, a `notify.send`
 * job tells the person who started it how the work ended. It runs as that job's caller, so the
 * recipient is whoever queued the work; work Sprint queued itself (a page's check after a Save,
 * the sweep) goes to the project's creator.
 */
export const notifyWhenEnded = (w: Scope, projectId: string, subject: Subject): JobRequest => ({
  kind: 'notify.send',
  projectId,
  concurrencyKey: computeKey(w),
  args: subject.about === 'labeling' ? {about: 'labeling', taskId: subject.taskId} : {about: 'optimiser', runId: subject.runId},
});

const promptTuning = (projectId: string) => `/prompt/?p=${encodeURIComponent(projectId)}`;

/**
 * The `notify.send` executor. It reads how the work ended from its record, not from the job: a
 * finished task says finished, a failed one failed. A Stop the user pressed, and work that has
 * not really ended (a run paused, a job lost and queued again), send nothing. Only a job that
 * ended done or failed is told about: a cancelled one is a Stop (or a runner that found the work
 * already taken), even while the record still shows how an earlier try ended. Always ends done:
 * a notification is never tried again.
 */
export async function runNotify(w: Scope, job: Job): Promise<JobOutcome> {
  if (!job.projectId) return {state: 'done'};
  const projectId = job.projectId;
  const parentId = job.idempotencyKey?.startsWith('finally:') ? job.idempotencyKey.slice('finally:'.length) : null;
  const parent = parentId ? await w.jobs.get(w.ctx, parentId) : null;
  if (!parent || (parent.state !== 'done' && parent.state !== 'failed')) return {state: 'done'};
  // How the job ended decides what is said; a record that has moved on since (a Retry that
  // already finished) says nothing, so a late notice never reports another try's outcome.
  const finished = parent.state === 'done';
  const state = await loadProjectState(w, projectId);
  if (!state) return {state: 'done'};
  const project = state.project.name;
  const recipient = w.ctx.caller === SYSTEM_CALLER ? state.project.createdById : w.ctx.user.id;
  if (!recipient) return {state: 'done'};
  // Sprint's own work is checked for the tenant only: the creator it goes to must still read the project.
  if (w.ctx.caller === SYSTEM_CALLER && w.authorization) {
    const creator = {requestId: w.ctx.requestId, user: {id: recipient, name: state.project.createdBy}, tenantId: state.project.tenantId, caller: 'worker'};
    if (!(await w.authorization.allowed(creator, {action: `job.${job.kind}`, permission: 'read', projectId}))) return {state: 'done'};
  }
  const to = [recipient];
  if (job.args.about === 'labeling') {
    const task = await w.labeling.getTask(String(job.args.taskId));
    if (!task || task.projectId !== projectId) return {state: 'done'};
    if (finished ? task.state !== 'done' : task.state !== 'failed' && task.state !== 'needs_attention') return {state: 'done'};
    const v = state.versions.find(x => x.id === task.promptVersionId);
    const params = {version: v ? versionLabel(v) : '?', model: modelName(state, task.endpoint), project};
    await notify(w, {
      userIds: to,
      kind: finished ? 'scoring_finished' : 'scoring_failed',
      projectId,
      link: promptTuning(projectId),
      title: finished ? msg('Scoring finished') : msg('Scoring failed'),
      msg: finished ? msg('Scoring {version} on {model} finished in {project}.', params) : msg('Scoring {version} on {model} failed in {project}.', params),
    });
  } else if (job.args.about === 'optimiser') {
    const run = state.optimisation.find(o => o.id === String(job.args.runId));
    if (!run || run.state !== (finished ? 'done' : 'failed')) return {state: 'done'};
    await notify(w, {
      userIds: to,
      kind: finished ? 'optimiser_finished' : 'optimiser_failed',
      projectId,
      link: promptTuning(projectId),
      title: finished ? msg('Auto Optimise finished') : msg('Auto Optimise failed'),
      msg: finished ? msg('Auto Optimise finished in {project}.', {project}) : msg('Auto Optimise failed in {project}.', {project}),
    });
  }
  return {state: 'done'};
}

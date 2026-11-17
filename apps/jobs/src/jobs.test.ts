import assert from 'node:assert/strict';
import test from 'node:test';
import type {Job, JobControl, JobExecutor, JobKind, JobOutcome, RequestContext} from '@sprint/contracts';
import {memoryJobStore} from '@sprint/platform';
import {createJobs} from './jobs.ts';

/**
 * The job module's lifecycle (deployment readiness spec, 3 and 8): enqueue once per key, one
 * runner per job, progress, cancel, a dead runner's job taken over after its lease ends, retries,
 * chains, and fairness across tenants. The store is the in-memory stand-in; two `createJobs` over
 * one store stand for two worker processes.
 */

const ctx = (tenantId?: string): RequestContext => ({requestId: 'rq_1', user: {id: 'u_1', name: 'Ann'}, caller: 'test', ...(tenantId ? {tenantId} : {})});
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** An executor whose runs the test ends by hand. */
function manual(kind: JobKind = 'report.build') {
  const runs: {job: Job; ctl: JobControl; end: (o: JobOutcome) => void; fail: (e: Error) => void}[] = [];
  const executor: JobExecutor = {
    kind,
    run: (job, ctl) =>
      new Promise<JobOutcome>((resolve, reject) => {
        runs.push({job, ctl, end: resolve, fail: reject});
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason));
      }),
  };
  return {executor, runs};
}

async function until(cond: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a job runs as soon as it is enqueued, reports progress, and ends done; the same key while it runs returns the same job', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store});
  const m = manual();
  jobs.register(m.executor);
  const a = await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
  const again = await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
  assert.equal(again.id, a.id, 'a repeat of a queued or running key is the same job');
  await until(() => m.runs.length === 1, 'the run');
  assert.deepEqual(m.runs[0].job.ctx, {requestId: 'rq_1', user: {id: 'u_1', name: 'Ann'}, caller: 'test'}, 'the job runs as its caller');
  m.runs[0].ctl.progress({done: 3, total: 10});
  await until(async () => (await jobs.api.get(ctx(), a.id))?.progress?.done === 3, 'the progress');
  assert.equal((await jobs.api.get(ctx(), a.id))?.state, 'running');
  m.runs[0].end({state: 'done'});
  await jobs.idle();
  const ended = (await jobs.api.get(ctx(), a.id))!;
  assert.deepEqual([ended.state, ended.attempts, ended.lease], ['done', 1, null]);
  // Once it ended, the key starts new work.
  const b = await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
  assert.notEqual(b.id, a.id);
  await until(() => m.runs.length === 2, 'the second run');
  m.runs[1].end({state: 'done'});
  await jobs.idle();
});

test('cancel: a queued job is cancelled at once; a running one stops through its signal and ends cancelled', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store, concurrency: 1});
  const m = manual();
  jobs.register(m.executor);
  const first = await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  const second = await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  await until(() => m.runs.length === 1, 'the first run');
  await jobs.api.cancel(ctx(), second.id);
  assert.equal((await jobs.api.get(ctx(), second.id))?.state, 'cancelled', 'never started');
  await jobs.api.cancel(ctx(), first.id);
  assert.equal(m.runs[0].ctl.signal.aborted, true);
  await jobs.idle();
  assert.equal((await jobs.api.get(ctx(), first.id))?.state, 'cancelled');
  assert.equal(m.runs.length, 1, 'the cancelled queued job never ran');
});

test('a cancel asked of another runner reaches its job on the next heartbeat', async () => {
  const store = memoryJobStore();
  const worker = createJobs({store, owner: 'worker', heartbeatMs: 10});
  const front = createJobs({store, owner: 'front'}); // registers nothing: it only enqueues and cancels
  const m = manual();
  worker.register(m.executor);
  const job = await front.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  worker.drain();
  await until(() => m.runs.length === 1, 'the worker runs it');
  await front.api.cancel(ctx(), job.id);
  await until(() => m.runs[0].ctl.signal.aborted, 'the worker sees the cancel');
  await worker.idle();
  assert.equal((await store.get(job.id))?.state, 'cancelled');
});

test("a runner that died: its lease ends, the sweep puts the job back, and another runner resumes it; after too many tries it fails", async () => {
  let now = Date.parse('2026-11-17T10:00:00Z');
  const store = memoryJobStore();
  const dead = createJobs({store, owner: 'dead', leaseMs: 1000, heartbeatMs: 60_000, clock: () => now});
  const m1 = manual();
  dead.register(m1.executor);
  const job = await dead.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  await until(() => m1.runs.length === 1, 'the first runner');
  // The first runner stops answering (no heartbeat comes); the lease runs out.
  now += 1500;
  const live = createJobs({store, owner: 'live', leaseMs: 1000, heartbeatMs: 60_000, clock: () => now, maxAttempts: 2});
  const m2 = manual();
  live.register(m2.executor);
  assert.deepEqual(await live.sweep(), {requeued: 1, failed: 0});
  await until(() => m2.runs.length === 1, 'the second runner resumes it');
  assert.equal(m2.runs[0].job.attempts, 2);
  // The dead runner wakes up and tries to finish: it no longer holds the job.
  m1.runs[0].end({state: 'done'});
  await dead.idle();
  assert.equal((await store.get(job.id))?.state, 'running', "the dead runner's finish is refused");
  assert.equal((await store.get(job.id))?.lease?.owner, 'live');
  // The second runner dies too: with 2 tries used, the sweep fails the job.
  now += 1500;
  assert.deepEqual(await live.sweep(), {requeued: 0, failed: 1});
  assert.equal((await store.get(job.id))?.state, 'failed');
  m2.runs[0].end({state: 'done'});
  await live.idle();
});

test('a lost lease aborts the work: the runner sees on its heartbeat that another runner holds the job', async () => {
  let now = Date.parse('2026-11-17T10:00:00Z');
  const store = memoryJobStore();
  const slow = createJobs({store, owner: 'slow', leaseMs: 1000, heartbeatMs: 15, clock: () => now});
  const m = manual();
  slow.register(m.executor);
  const job = await slow.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  await until(() => m.runs.length === 1, 'the run');
  // The clock jumps past the lease before the next heartbeat; a sweep elsewhere hands it on.
  now += 5000;
  await store.recoverExpired(new Date(now).toISOString(), 3);
  await store.claimNext(['report.build'], 'other', 1000, new Date(now).toISOString());
  await until(() => m.runs[0].ctl.signal.aborted, 'the slow runner stops');
  await slow.idle();
  assert.equal((await store.get(job.id))?.lease?.owner, 'other');
});

test('an executor that throws is tried again as many times as it allows, then fails with its message', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store, retryDelayMs: 1});
  let tries = 0;
  jobs.register({
    kind: 'dataset.sample',
    retries: 1,
    run: async () => {
      tries++;
      throw new Error('The example source did not answer.');
    },
  });
  const job = await jobs.api.enqueue(ctx(), {kind: 'dataset.sample', projectId: 'pr_1', args: {n: 5}});
  await until(async () => (await store.get(job.id))?.state === 'failed', 'the failure');
  assert.equal(tries, 2, 'one try and one retry');
  assert.equal((await store.get(job.id))?.error, 'The example source did not answer.');
});

test('a chain: the next step is enqueued with the same context only when the job ends done', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store});
  const ran: string[] = [];
  jobs.register({kind: 'labeling.runTask', run: async job => (ran.push(`label:${job.args.taskId}`), job.args.taskId === 'lt_ok' ? {state: 'done'} : {state: 'failed', error: 'needs attention'})});
  jobs.register({kind: 'report.build', run: async job => (ran.push(`report:${job.args.v}:${job.ctx.user.name}`), {state: 'done'})});
  await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', projectId: 'pr_1', args: {taskId: 'lt_ok'}, then: {kind: 'report.build', projectId: 'pr_1', args: {v: 'pv_1'}}});
  await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', projectId: 'pr_1', args: {taskId: 'lt_bad'}, then: {kind: 'report.build', projectId: 'pr_1', args: {v: 'pv_2'}}});
  await jobs.idle();
  assert.deepEqual(ran.sort(), ['label:lt_bad', 'label:lt_ok', 'report:pv_1:Ann']);
});

test('fair across tenants: a free runner takes the tenant with the fewest running jobs first', async () => {
  const store = memoryJobStore();
  // A worker that polls: the queue fills before it looks.
  const jobs = createJobs({store, concurrency: 2, runOnEnqueue: false});
  const m = manual();
  jobs.register(m.executor);
  for (let i = 0; i < 3; i++) await jobs.api.enqueue(ctx('big'), {kind: 'report.build', projectId: `pr_big_${i}`, args: {}});
  await jobs.api.enqueue(ctx('small'), {kind: 'report.build', projectId: 'pr_small', args: {}});
  jobs.drain();
  await until(() => m.runs.length === 2, 'two runs');
  const tenants = m.runs.map(r => r.job.ctx.tenantId);
  assert.deepEqual(tenants.sort(), ['big', 'small'], "the small tenant does not wait behind the big tenant's queue");
  for (const r of m.runs) r.end({state: 'done'});
  await until(() => m.runs.length === 4, 'the rest');
  for (const r of m.runs.slice(2)) r.end({state: 'done'});
  await jobs.idle();
});

test('list and get read through the store: by project, kind and state, newest first', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store, runOnEnqueue: false});
  await jobs.api.enqueue(ctx(), {kind: 'dataset.sample', projectId: 'pr_1', args: {n: 1}});
  await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_1', args: {}});
  await jobs.api.enqueue(ctx(), {kind: 'report.build', projectId: 'pr_2', args: {}});
  assert.deepEqual((await jobs.api.list(ctx(), {projectId: 'pr_1'})).map(j => j.kind).sort(), ['dataset.sample', 'report.build']);
  assert.equal((await jobs.api.list(ctx(), {kinds: ['report.build'], states: ['queued']})).length, 2);
  // Values cross as JSON, as through a real store: a caller never holds the stored object.
  const [j] = await jobs.api.list(ctx(), {projectId: 'pr_2'});
  j.state = 'done';
  assert.equal((await jobs.api.get(ctx(), j.id))?.state, 'queued');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type {Job, JobControl, JobExecutor, JobKind, JobOutcome, RequestContext} from '@yushiguang/sprint-contracts';
import {memoryJobStore} from '@yushiguang/sprint-platform';
import {createJobs} from './jobs.ts';

/**
 * The job module's lifecycle (deployment readiness spec, 3 and 8): enqueue once per key, one
 * runner per job, progress, cancel, a dead runner's job taken over after its lease ends, retries,
 * chains, and fairness across tenants. The store is the in-memory stand-in; two `createJobs` over
 * one store stand for two worker processes.
 */

const ctx = (tenantId?: string): RequestContext => ({requestId: 'rq_1', user: {id: 'u_1', name: 'Ann'}, caller: 'test', ...(tenantId ? {tenantId} : {})});
/** A compute key with the default limit (10), for tests about something else. */
const KEY = 'compute:default';
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
  const a = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
  const again = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
  assert.equal(again.id, a.id, 'a repeat of a queued or running key is the same job');
  await until(() => m.runs.length === 1, 'the run');
  assert.deepEqual(m.runs[0].job.ctx, {requestId: 'rq_1', user: {id: 'u_1', name: 'Ann'}, caller: 'test'}, 'the job runs as its caller');
  await m.runs[0].ctl.progress({done: 3, total: 10});
  await until(async () => (await jobs.api.get(ctx(), a.id))?.progress?.done === 3, 'the progress');
  assert.equal((await jobs.api.get(ctx(), a.id))?.state, 'running');
  m.runs[0].end({state: 'done'});
  await jobs.idle();
  const ended = (await jobs.api.get(ctx(), a.id))!;
  assert.deepEqual([ended.state, ended.attempts, ended.lease], ['done', 1, null]);
  // Once it ended, the key starts new work.
  const b = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {v: 'pv_1'}, idempotencyKey: 'report:pv_1'});
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
  const first = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
  const second = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
  await until(() => m.runs.length === 1, 'the first run');
  await jobs.api.cancel(ctx(), second.id);
  assert.equal((await jobs.api.get(ctx(), second.id))?.state, 'cancelled', 'never started');
  await jobs.api.cancel(ctx(), first.id);
  assert.equal(m.runs[0].ctl.signal.aborted, true);
  assert.equal(m.runs[0].ctl.cancelled(), true, 'a cancel, not a lost lease');
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
  const job = await front.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
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
  const job = await dead.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
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
  const job = await slow.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
  await until(() => m.runs.length === 1, 'the run');
  // The clock jumps past the lease before the next heartbeat; a sweep elsewhere hands it on.
  now += 5000;
  await store.recoverExpired(new Date(now).toISOString(), 3);
  await store.claimNext(['report.build'], 'other', 1000, new Date(now).toISOString(), async () => 1);
  await until(() => m.runs[0].ctl.signal.aborted, 'the slow runner stops');
  assert.equal(m.runs[0].ctl.cancelled(), false, 'a lost lease is not a cancel: the work is not stopped for good');
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
  const job = await jobs.api.enqueue(ctx(), {kind: 'dataset.sample', concurrencyKey: KEY, projectId: 'pr_1', args: {n: 5}});
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
  await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', concurrencyKey: KEY, projectId: 'pr_1', args: {taskId: 'lt_ok'}, then: {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {v: 'pv_1'}}});
  await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', concurrencyKey: KEY, projectId: 'pr_1', args: {taskId: 'lt_bad'}, then: {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {v: 'pv_2'}}});
  await jobs.idle();
  assert.deepEqual(ran.sort(), ['label:lt_bad', 'label:lt_ok', 'report:pv_1:Ann']);
});

test('finishing fails: the runner tries again, and the chain is queued exactly once (#26)', async () => {
  // The store fails to save the end twice, then recovers.
  const base = memoryJobStore();
  let failures = 2;
  const store = {...base, finish: (...a: Parameters<typeof base.finish>) => (failures-- > 0 ? Promise.reject(new Error('store down')) : base.finish(...a))};
  const jobs = createJobs({store, retryDelayMs: 1});
  const ran: string[] = [];
  jobs.register({kind: 'labeling.runTask', run: async () => (ran.push('label'), {state: 'done'})});
  jobs.register({kind: 'report.build', run: async () => (ran.push('report'), {state: 'done'})});
  const parent = await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', concurrencyKey: KEY, projectId: 'pr_1', args: {}, then: {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}}});
  await jobs.idle();
  assert.equal((await jobs.api.get(ctx(), parent.id))?.state, 'done');
  assert.deepEqual(ran, ['label', 'report']);
});

test('finishing keeps failing: the sweep runs the job again and that run chains; on the last attempt the runner chains (#26)', async () => {
  const base = memoryJobStore();
  let down = true;
  const store = {...base, finish: (...a: Parameters<typeof base.finish>) => (down ? Promise.reject(new Error('store down')) : base.finish(...a))};
  let now = Date.parse('2026-11-18T00:00:00Z');
  const jobs = createJobs({store, retryDelayMs: 1, leaseMs: 1000, maxAttempts: 2, clock: () => now});
  const ran: string[] = [];
  jobs.register({kind: 'labeling.runTask', run: async () => (ran.push('label'), {state: 'done'})});
  jobs.register({kind: 'report.build', run: async () => (ran.push('report'), {state: 'done'})});
  const parent = await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', concurrencyKey: KEY, projectId: 'pr_1', args: {}, then: {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}}});
  await until(() => ran.length === 1, 'the first run');
  await tick(30);
  // First attempt: the end was not saved and nothing is chained yet; the job keeps its lease.
  assert.deepEqual(ran, ['label']);
  assert.equal((await jobs.api.get(ctx(), parent.id))?.state, 'running');
  // The lease ends; the sweep runs it again. That is its last attempt, so the runner chains.
  now += 2000;
  await jobs.sweep();
  await until(() => ran.length === 3, 'the second run and the chain');
  assert.deepEqual(ran, ['label', 'label', 'report']);
  // The sweep later fails the job (its end never saved); the chain is not queued again. (The
  // chained job's own end was not saved either, so the sweep runs that one again: one job.)
  down = false;
  now += 2000;
  await jobs.sweep();
  await jobs.idle();
  assert.equal((await jobs.api.get(ctx(), parent.id))?.state, 'failed');
  assert.equal(ran.filter(r => r === 'label').length, 2);
  assert.equal((await jobs.api.list(ctx(), {kinds: ['report.build']})).length, 1);
});

test('fair across tenants: keys take turns, so a small tenant does not wait behind a big one', async () => {
  const store = memoryJobStore();
  // A worker that polls: the queue fills before it looks.
  const jobs = createJobs({store, concurrency: 2, runOnEnqueue: false});
  const m = manual();
  jobs.register(m.executor);
  for (let i = 0; i < 3; i++) await jobs.api.enqueue(ctx('big'), {kind: 'report.build', concurrencyKey: 'compute:big', projectId: `pr_big_${i}`, args: {}});
  await jobs.api.enqueue(ctx('small'), {kind: 'report.build', concurrencyKey: 'compute:small', projectId: 'pr_small', args: {}});
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
  await jobs.api.enqueue(ctx(), {kind: 'dataset.sample', concurrencyKey: KEY, projectId: 'pr_1', args: {n: 1}});
  await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}});
  await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_2', args: {}});
  assert.deepEqual((await jobs.api.list(ctx(), {projectId: 'pr_1'})).map(j => j.kind).sort(), ['dataset.sample', 'report.build']);
  assert.equal((await jobs.api.list(ctx(), {kinds: ['report.build'], states: ['queued']})).length, 2);
  // Values cross as JSON, as through a real store: a caller never holds the stored object.
  const [j] = await jobs.api.list(ctx(), {projectId: 'pr_2'});
  j.state = 'done';
  assert.equal((await jobs.api.get(ctx(), j.id))?.state, 'queued');
});

test('an executor reads configuration for the job tenant through its control', async () => {
  const seen: number[] = [];
  const config = {forTenant: (tenantId: string | undefined) => ({get: async () => null, jobLimit: async () => (tenantId === 't1' ? 7 : 1)})};
  const jobs = createJobs({store: memoryJobStore(), config});
  jobs.register({kind: 'report.build', run: async (job, ctl) => (seen.push(await ctl.config.forTenant(job.ctx.tenantId).jobLimit({kind: 'compute'})), {state: 'done'})});
  await jobs.api.enqueue(ctx('t1'), {kind: 'report.build', concurrencyKey: 'compute:t1', projectId: null, args: {}});
  await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: null, args: {}, idempotencyKey: 'b'});
  await jobs.idle();
  assert.deepEqual(seen.sort(), [1, 7]);
});

test("a key's limit comes from the configuration of its tenant and target, across runners", async () => {
  const store = memoryJobStore();
  const asked: string[] = [];
  const config = {
    forTenant: (tenantId: string | undefined) => ({
      get: async () => null,
      jobLimit: async (t: {kind: 'model'; endpointId: string} | {kind: 'compute'}) => (asked.push(`${tenantId}:${t.kind === 'model' ? t.endpointId : 'compute'}`), t.kind === 'model' ? 1 : 10),
    }),
  };
  const a = createJobs({store, owner: 'a', config});
  const b = createJobs({store, owner: 'b', config});
  const ma = manual('labeling.runTask');
  const mb = manual('labeling.runTask');
  a.register(ma.executor);
  b.register(mb.executor);
  const first = await a.api.enqueue(ctx('t1'), {kind: 'labeling.runTask', concurrencyKey: 'model:t1:gpt-5.x', projectId: 'pr_1', args: {n: 1}});
  const second = await a.api.enqueue(ctx('t1'), {kind: 'labeling.runTask', concurrencyKey: 'model:t1:gpt-5.x', projectId: 'pr_1', args: {n: 2}});
  const other = await a.api.enqueue(ctx('t2'), {kind: 'labeling.runTask', concurrencyKey: 'model:t2:gpt-5.x', projectId: 'pr_2', args: {n: 3}});
  b.drain();
  await until(() => ma.runs.length + mb.runs.length === 2, 'one job per key');
  await tick(20);
  const started = [...ma.runs, ...mb.runs].map(r => r.job.id).sort();
  assert.deepEqual(started, [first.id, other.id].sort(), 'the second job of t1 waits for the endpoint, in both runners');
  assert.ok(asked.includes('t1:gpt-5.x') && asked.includes('t2:gpt-5.x'));
  assert.equal(await a.api.ahead(ctx('t1'), second.id), 0);
  assert.equal(await a.api.ahead(ctx('t1'), first.id), null, 'a running job has no place in the queue');
  [...ma.runs, ...mb.runs].find(r => r.job.id === first.id)!.end({state: 'done'});
  await until(() => ma.runs.length + mb.runs.length === 3, 'the second job once the first ended');
  for (const r of [...ma.runs, ...mb.runs]) if (r.job.id !== first.id) r.end({state: 'done'});
  await a.idle();
  await b.idle();
});

test('a job whose key, or the key of what it chains, is not a concurrency key is refused at enqueue', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store});
  const bad = {kind: 'report.build' as const, concurrencyKey: 'gpt-5.x', projectId: null, args: {}};
  await assert.rejects(jobs.api.enqueue(ctx(), bad), /Not a job concurrency key/);
  await assert.rejects(jobs.api.enqueue(ctx(), {...bad, concurrencyKey: KEY, then: bad}), /Not a job concurrency key/);
  await assert.rejects(jobs.api.enqueue(ctx(), {...bad, concurrencyKey: KEY, finally: {...bad, concurrencyKey: KEY, then: bad}}), /Not a job concurrency key/);
  assert.deepEqual(await store.find({}), [], 'nothing was queued');
});

test('idle() of a free runner returns while the only queued work waits for a key another runner fills', async () => {
  const store = memoryJobStore();
  const busy = createJobs({store, owner: 'busy'});
  const free = createJobs({store, owner: 'free', runOnEnqueue: false});
  const m = manual('labeling.runTask');
  busy.register(m.executor);
  free.register(manual('labeling.runTask').executor);
  const req = {kind: 'labeling.runTask' as const, concurrencyKey: 'model:t1:A', projectId: 'pr_1', args: {}};
  await busy.api.enqueue(ctx('t1'), req);
  await until(() => m.runs.length === 1, 'the first job');
  await busy.api.enqueue(ctx('t1'), req);
  await free.idle();
  assert.equal((await store.find({states: ['queued']})).length, 1, 'still queued: the key is full');
  m.runs[0].end({state: 'done'});
  await until(() => m.runs.length === 2, 'the second job');
  m.runs[1].end({state: 'done'});
  await busy.idle();
});

test('a finished job queues what follows before the runner counts it gone (server worker mode)', async () => {
  const store = memoryJobStore();
  const jobs = createJobs({store, runOnEnqueue: false});
  const ran: string[] = [];
  jobs.register({kind: 'labeling.runTask', run: async () => (ran.push('label'), {state: 'failed', error: 'x'})});
  jobs.register({kind: 'report.build', run: async () => (ran.push('finally'), {state: 'done'})});
  await jobs.api.enqueue(ctx(), {kind: 'labeling.runTask', concurrencyKey: KEY, projectId: 'pr_1', args: {}, finally: {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {}}});
  jobs.drain();
  // No poll and no idle(): only the drain at the end of the first job can take the finally.
  await until(() => ran.length === 2, 'the finally, taken by the drain after the end');
  assert.deepEqual(ran, ['label', 'finally']);
});

test('finally follows every end: done, failed, cancelled while running, cancelled while queued, failed by the sweep; then only done', async () => {
  let now = Date.parse('2026-11-22T10:00:00Z');
  const store = memoryJobStore();
  const jobs = createJobs({store, concurrency: 1, leaseMs: 1000, heartbeatMs: 60_000, maxAttempts: 1, clock: () => now});
  const m = manual('labeling.runTask');
  jobs.register(m.executor);
  const after: string[] = [];
  jobs.register({kind: 'report.build', run: async job => (after.push(`${job.args.of}:${job.ctx.user.name}`), {state: 'done'})});
  const req = (of: string) => ({kind: 'labeling.runTask' as const, concurrencyKey: KEY, projectId: 'pr_1', args: {of}, then: {kind: 'report.build' as const, concurrencyKey: KEY, projectId: 'pr_1', args: {of: `then:${of}`}}, finally: {kind: 'report.build' as const, concurrencyKey: KEY, projectId: 'pr_1', args: {of}}});
  const ends: [string, (r: (typeof m.runs)[number]) => void | Promise<void>][] = [
    ['done', r => r.end({state: 'done'})],
    ['failed', r => r.end({state: 'failed', error: 'too many failed'})],
    ['paused', r => r.end({state: 'paused'})],
    ['cancelled', async r => jobs.api.cancel(ctx(), r.job.id)],
  ];
  for (const [of, end] of ends) {
    await jobs.api.enqueue(ctx(), req(of));
    await until(() => m.runs.length > 0 && m.runs[m.runs.length - 1].job.args.of === of, of);
    await end(m.runs[m.runs.length - 1]);
    await jobs.idle();
  }
  // Cancelled before it started: a job waits behind a running one (concurrency 1).
  await jobs.api.enqueue(ctx(), req('lost'));
  await until(() => m.runs[m.runs.length - 1].job.args.of === 'lost', 'the blocker');
  const queued = await jobs.api.enqueue(ctx(), req('queued'));
  await jobs.api.cancel(ctx(), queued.id);
  // The running one's runner stops answering: the sweep fails it on its last attempt. The late
  // end of its work is refused and queues nothing more.
  now += 5000;
  await jobs.sweep();
  assert.equal((await store.find({kinds: ['report.build'], states: ['queued']})).length, 2, 'the finally of both is queued');
  m.runs[m.runs.length - 1].end({state: 'done'});
  await jobs.idle();
  assert.deepEqual(after.sort(), ['cancelled:Ann', 'done:Ann', 'failed:Ann', 'lost:Ann', 'queued:Ann', 'then:done:Ann'].sort(), 'paused is not an end; then follows done only');
});

test('job ids sort in the order this runner made them, within one millisecond and across', async () => {
  let now = Date.parse('2026-11-22T10:00:00Z');
  const store = memoryJobStore();
  const jobs = createJobs({store, runOnEnqueue: false, clock: () => now});
  const ids: string[] = [];
  for (let i = 0; i < 1400; i++) {
    if (i === 700) now += 1;
    const j = await jobs.api.enqueue(ctx(), {kind: 'report.build', concurrencyKey: KEY, projectId: 'pr_1', args: {i}});
    ids.push(j.id);
  }
  assert.deepEqual([...ids].sort(), ids);
});

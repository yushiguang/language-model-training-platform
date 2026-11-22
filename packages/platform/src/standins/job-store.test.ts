import assert from 'node:assert/strict';
import test from 'node:test';
import type {Job, JobKind, JobStorePort} from '@yushiguang/sprint-contracts';
import {memoryJobStore} from './job-store.ts';

/**
 * The job store's rules (`JobStorePort`, docs/design/server.md 5.2), written against the port so
 * that a deployment's store (MySQL with the SQL of 5.2) can run the same cases: copy
 * `jobStoreCases` and call it with a factory of that store. Each case gets a fresh store.
 */
export function jobStoreCases(name: string, make: () => JobStorePort | Promise<JobStorePort>) {
  const T0 = '2026-11-22T10:00:00.000Z';
  const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
  const job = (id: string, concurrencyKey: string, createdAt: string, kind: JobKind = 'labeling.runTask', more: Partial<Job> = {}): Job => ({
    id, kind, projectId: 'pr_1', args: {}, idempotencyKey: null, concurrencyKey, then: null, finally: null, state: 'queued', progress: null, error: null, attempts: 0,
    notBefore: null, cancelRequested: false, ctx: {requestId: 'rq_1', user: {id: 'u_1', name: 'Ann'}}, lease: null, createdAt, startedAt: null, heartbeatAt: null, endedAt: null, ...more,
  });
  const KINDS: JobKind[] = ['labeling.runTask', 'report.build'];
  const limits = (by: Record<string, number>, fallback = 1) => async (key: string) => by[key] ?? fallback;
  const claim = (s: JobStorePort, now = at(100), limitOf = limits({})) => s.claimNext(KINDS, 'runner', 30_000, now, limitOf);
  const fill = async (s: JobStorePort, jobs: Job[]) => {
    for (const j of jobs) await s.enqueueOnce(j);
  };

  test(`${name}: one key at its limit waits; the next job starts once one ends`, async () => {
    const s = await make();
    await fill(s, [job('j_2', 'model:t1:e1', at(2)), job('j_1', 'model:t1:e1', at(1))]);
    assert.equal((await claim(s))?.id, 'j_1', 'the oldest first');
    assert.equal(await claim(s), null, 'limit 1: the second waits');
    await s.finish('j_1', 'runner', {state: 'done'}, at(101));
    assert.equal((await claim(s))?.id, 'j_2');
  });

  test(`${name}: a full key never blocks another key; two tenants on one endpoint count apart`, async () => {
    const s = await make();
    await fill(s, [job('a_1', 'model:t1:e1', at(1)), job('a_2', 'model:t1:e1', at(2)), job('b_1', 'model:t1:e2', at(3)), job('c_1', 'model:t2:e1', at(4))]);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await claim(s))?.id ?? null);
    assert.deepEqual(ids, ['a_1', 'b_1', 'c_1', null]);
  });

  test(`${name}: the limit comes from limitOf on every claim`, async () => {
    const s = await make();
    await fill(s, [job('j_1', 'compute:t1', at(1), 'report.build'), job('j_2', 'compute:t1', at(2), 'report.build'), job('j_3', 'compute:t1', at(3), 'report.build')]);
    assert.equal((await claim(s, at(100), limits({'compute:t1': 2})))?.id, 'j_1');
    assert.equal((await claim(s, at(100), limits({'compute:t1': 2})))?.id, 'j_2');
    assert.equal(await claim(s, at(100), limits({'compute:t1': 2})), null);
    assert.equal((await claim(s, at(100), limits({'compute:t1': 3})))?.id, 'j_3', 'a raised limit counts at once');
  });

  test(`${name}: keys take turns, the one claimed longest ago first`, async () => {
    const s = await make();
    await fill(s, [job('a_1', 'compute:a', at(1), 'report.build'), job('a_2', 'compute:a', at(2), 'report.build'), job('a_3', 'compute:a', at(3), 'report.build'), job('b_1', 'compute:b', at(4), 'report.build')]);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await claim(s, at(100 + i), limits({}, 10)))?.id);
    assert.deepEqual(ids, ['a_1', 'b_1', 'a_2', 'a_3'], "b's one job does not wait behind a's queue");
  });

  test(`${name}: turns stay strict when claims share one moment`, async () => {
    const s = await make();
    await fill(s, ['a_1', 'a_2', 'a_3', 'b_1', 'b_2', 'b_3'].map((id, i) => job(id, `compute:${id[0]}`, at(i), 'report.build')));
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await claim(s, at(100), limits({}, 10)))?.id);
    assert.deepEqual(ids, ['a_1', 'b_1', 'a_2', 'b_2', 'a_3', 'b_3']);
  });

  test(`${name}: within a key, by creation time and then id; only due jobs of the asked kinds`, async () => {
    const s = await make();
    await fill(s, [
      job('j_b', 'model:t1:e1', at(1)),
      job('j_a', 'model:t1:e1', at(1)),
      job('j_later', 'model:t1:e1', at(0), 'labeling.runTask', {notBefore: at(500)}),
      job('j_other', 'model:t1:e1', at(0), 'optimiser.run'),
    ]);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await claim(s, at(100), limits({}, 10)))?.id ?? null);
    assert.deepEqual(ids, ['j_a', 'j_b', null], 'a retry that is not due and a kind not asked for are left');
    assert.equal((await claim(s, at(600), limits({}, 10)))?.id, 'j_later');
  });

  test(`${name}: a claimed job is running with a lease and one more attempt`, async () => {
    const s = await make();
    await fill(s, [job('j_1', 'model:t1:e1', at(1))]);
    const j = (await claim(s, at(100)))!;
    assert.deepEqual([j.state, j.attempts, j.lease, j.startedAt], ['running', 1, {owner: 'runner', until: at(130)}, at(100)]);
  });

  test(`${name}: countAhead counts the queued jobs of the key that go first`, async () => {
    const s = await make();
    await fill(s, [job('j_1', 'model:t1:e1', at(1)), job('j_2', 'model:t1:e1', at(2)), job('j_3', 'model:t1:e1', at(2)), job('j_4', 'model:t1:e1', at(3)), job('x_1', 'model:t1:e2', at(0))]);
    assert.equal(await s.countAhead('model:t1:e1', at(3), 'j_4'), 3);
    assert.equal(await s.countAhead('model:t1:e1', at(2), 'j_3'), 2, 'same time: the smaller id goes first');
    await claim(s);
    assert.equal(await s.countAhead('model:t1:e1', at(3), 'j_4'), 2, 'a running job is not ahead');
    assert.equal(await s.countAhead('model:t1:e1', at(1), 'j_1'), 0);
  });

  test(`${name}: a cancel says whether it ended the job; the sweep returns the jobs it ended`, async () => {
    const s = await make();
    await fill(s, [job('q_1', 'compute:t1', at(1), 'report.build'), job('r_1', 'compute:t1', at(2), 'report.build'), job('r_2', 'compute:t1', at(3), 'report.build', {attempts: 2})]);
    const queued = await s.requestCancel('q_1', at(10));
    assert.deepEqual([queued.job?.state, queued.ended], ['cancelled', true]);
    await claim(s, at(10), limits({}, 10));
    await claim(s, at(10), limits({}, 10));
    const running = await s.requestCancel('r_1', at(11));
    assert.deepEqual([running.job?.state, running.ended], ['running', false], 'a running job ends when its runner looks');
    assert.deepEqual(await s.requestCancel('nope', at(11)), {job: null, ended: false});
    const out = await s.recoverExpired(at(100), 3);
    assert.deepEqual([out.requeued, out.failed, out.ended.map(j => `${j.id}:${j.state}`).sort()], [0, 1, ['r_1:cancelled', 'r_2:failed']]);
  });

  test(`${name}: enqueueOnce keeps one active job per idempotency key, across keys`, async () => {
    const s = await make();
    const a = await s.enqueueOnce(job('j_1', 'model:t1:e1', at(1), 'labeling.runTask', {idempotencyKey: 'label:lt_1'}));
    const b = await s.enqueueOnce(job('j_2', 'compute:t1', at(2), 'report.build', {idempotencyKey: 'label:lt_1'}));
    assert.deepEqual([a.created, b.created, b.job.id], [true, false, 'j_1']);
  });
}

jobStoreCases('memoryJobStore', memoryJobStore);

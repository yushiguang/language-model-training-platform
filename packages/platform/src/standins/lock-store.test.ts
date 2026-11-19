import assert from 'node:assert/strict';
import test from 'node:test';
import {leaseLocks, memoryLockStore} from './lock-store.ts';

/**
 * The lock store and its adapter (`LockStorePort`, issue #46): one owner per lock name, leases
 * that end, and renew/release that count only for the owner — the semantics a shared store gets
 * from `SET NX PX`, a script or a conditional update. Two adapters over one store stand for two
 * processes: their lock objects share nothing but the store.
 */

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

test('memoryLockStore: a second owner is refused while the first lease lasts, and may take over once it ends', async () => {
  const store = memoryLockStore();
  assert.equal(await store.acquire('labeling:lt_1', 'one', 1000, 0), true);
  assert.equal(await store.acquire('labeling:lt_1', 'two', 1000, 0), false);
  assert.equal(await store.acquire('labeling:lt_1', 'two', 1000, 999), false, 'still held just before the lease ends');
  assert.equal(await store.isHeld('labeling:lt_1', 999), true);
  assert.equal(await store.isHeld('labeling:lt_1', 1000), false, 'the lease has ended');
  assert.equal(await store.acquire('labeling:lt_1', 'two', 1000, 1000), true, 'an ended lease may be taken over');
  // A lock on another name is a different lock.
  assert.equal(await store.acquire('labeling:lt_2', 'one', 1000, 1000), true);
});

test('memoryLockStore: renew and release count only for the owner, and renew never revives an ended lease', async () => {
  const store = memoryLockStore();
  await store.acquire('labeling:lt_1', 'one', 1000, 0);
  assert.equal(await store.renew('labeling:lt_1', 'two', 1000, 500), false, 'another owner cannot extend the lease');
  assert.equal(await store.isHeld('labeling:lt_1', 1200), false, 'the lease still ends at 1000');
  // Take it again and renew as the owner: the end moves.
  await store.acquire('labeling:lt_1', 'one', 1000, 2000);
  assert.equal(await store.renew('labeling:lt_1', 'one', 1000, 2500), true);
  assert.equal(await store.isHeld('labeling:lt_1', 3200), true, 'renewed past the original end');
  await store.release('labeling:lt_1', 'two');
  assert.equal(await store.isHeld('labeling:lt_1', 3200), true, "another owner's release frees nothing");
  await store.release('labeling:lt_1', 'one');
  assert.equal(await store.isHeld('labeling:lt_1', 3200), false);
  assert.equal(await store.renew('labeling:lt_1', 'one', 1000, 3200), false, 'a released lock cannot be renewed');
  await store.acquire('labeling:lt_1', 'one', 100, 4000);
  assert.equal(await store.renew('labeling:lt_1', 'one', 100, 4100), false, 'a lease that already ended cannot be renewed');
});

test('leaseLocks: run returns null at once while another process holds the lock, and the holder releases it as it ends', async () => {
  const store = memoryLockStore();
  const one = leaseLocks(store);
  const two = leaseLocks(store);
  const running = one.run('labeling:lt_1', async () => {
    await tick(40);
    return 'done';
  });
  await tick(5);
  assert.equal(await two.isHeld('labeling:lt_1'), true);
  assert.equal(
    await two.run('labeling:lt_1', async () => 'second'),
    null,
    'a second runner in another process gets null, as a second tab does',
  );
  assert.equal(await running, 'done');
  assert.equal(await two.isHeld('labeling:lt_1'), false, 'the lock is free once the run ends');
  assert.equal(await two.run('labeling:lt_1', async () => 'second'), 'second');
});

test('leaseLocks: a run keeps its lock past one lease while it renews, and a failed run still releases it', async () => {
  const store = memoryLockStore();
  const locks = leaseLocks(store, {leaseMs: 90, renewMs: 20});
  const other = leaseLocks(store, {leaseMs: 90, renewMs: 20});
  const running = locks.run('labeling:lt_1', async () => {
    await tick(220);
    return 'done';
  });
  // Past the first 90 ms lease: only the renewals can still be holding it.
  await tick(140);
  assert.equal(await other.isHeld('labeling:lt_1'), true, 'the lease was renewed during the long run');
  assert.equal(await other.run('labeling:lt_1', async () => 'second'), null);
  assert.equal(await running, 'done');
  assert.equal(await other.isHeld('labeling:lt_1'), false);

  await assert.rejects(
    locks.run('labeling:lt_1', async () => {
      throw new Error('the work failed');
    }),
    /the work failed/,
  );
  assert.equal(await other.isHeld('labeling:lt_1'), false, 'a run that throws still releases its lock');
});

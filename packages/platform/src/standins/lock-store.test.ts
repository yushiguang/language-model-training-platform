import assert from 'node:assert/strict';
import test from 'node:test';
import type {LockStorePort} from '@yushiguang/sprint-contracts';
import {leaseLocks, memoryLockStore} from './lock-store.ts';

/**
 * The lock store and its adapter (`LockStorePort`, issue #46): one owner per lock name, leases
 * that end, and renew/release that count only for the owner — the semantics a shared store gets
 * from `SET NX PX`, a script or a conditional update. Two adapters over one store stand for two
 * processes: their lock objects share nothing but the store.
 */

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A promise the test resolves by hand, so a run stays inside its lock until the test lets it out. */
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(res => (resolve = res));
  return {promise, resolve};
}

/** Waits until a condition the test can observe holds (the `until` pattern of the jobs tests). */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await tick(1);
  }
  assert.fail(`timed out waiting for ${what}`);
}

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

test('memoryLockStore: a lock retaken after its lease ended is untouched by the first owner arriving late', async () => {
  const store = memoryLockStore();
  assert.equal(await store.acquire('labeling:lt_1', 'one', 100, 0), true);
  assert.equal(await store.acquire('labeling:lt_1', 'two', 1000, 99), false, 'one still holds it just before the lease ends');
  assert.equal(await store.acquire('labeling:lt_1', 'two', 1000, 100), true, 'the lease ended, so two takes over');
  assert.equal(await store.renew('labeling:lt_1', 'one', 100, 150), false, "one's late renewal does not revive or extend its lock");
  await store.release('labeling:lt_1', 'one');
  assert.equal(await store.isHeld('labeling:lt_1', 150), true, "one's late release leaves two's lock intact");
  assert.equal(await store.acquire('labeling:lt_1', 'three', 100, 150), false);
  assert.equal(await store.renew('labeling:lt_1', 'two', 1000, 150), true, 'two still holds and renews its own lock');
  assert.equal(await store.isHeld('labeling:lt_1', 1149), true, 'renewed by two to 1150');
  await store.release('labeling:lt_1', 'two');
  assert.equal(await store.isHeld('labeling:lt_1', 1149), false);
});

test('leaseLocks: run returns null at once while another process holds the lock, and the holder releases it as it ends', async () => {
  const store = memoryLockStore();
  const one = leaseLocks(store);
  const two = leaseLocks(store);
  // The first run stays inside its lock until the test opens the gate, so nothing races a timer.
  const entered = deferred();
  const gate = deferred();
  const running = one.run('labeling:lt_1', async () => {
    entered.resolve('in');
    return gate.promise;
  });
  await entered.promise;
  assert.equal(await two.isHeld('labeling:lt_1'), true);
  assert.equal(
    await two.run('labeling:lt_1', async () => 'second'),
    null,
    'a second runner in another process gets null, as a second tab does',
  );
  gate.resolve('done');
  assert.equal(await running, 'done');
  assert.equal(await two.isHeld('labeling:lt_1'), false, 'the lock is free once the run ends');
  assert.equal(await two.run('labeling:lt_1', async () => 'second'), 'second');
});

test('leaseLocks: a run keeps its lock past one lease while it renews, and the renewals stop when the run ends or fails', async () => {
  let now = 0;
  const clock = () => now;
  const base = memoryLockStore();
  const renewsAt: number[] = [];
  const store: LockStorePort = {
    ...base,
    renew: async (name, owner, leaseMs, at) => {
      renewsAt.push(at);
      return base.renew(name, owner, leaseMs, at);
    },
  };
  const locks = leaseLocks(store, {leaseMs: 1000, renewMs: 5, clock});
  const other = leaseLocks(store, {leaseMs: 1000, renewMs: 5, clock});

  // A long run, gated by the test: the injected clock moves past the first lease's end (1000)
  // only after a renewal at 600 has extended it to 1600, so no real duration decides the outcome.
  const entered = deferred();
  const gate = deferred();
  const running = locks.run('labeling:lt_1', async () => {
    entered.resolve('in');
    return gate.promise;
  });
  await entered.promise;
  await until(() => renewsAt.length >= 1, 'the first renewal');
  now = 600;
  await until(() => renewsAt.includes(600), 'a renewal under the moved clock');
  now = 1200;
  assert.equal(await other.isHeld('labeling:lt_1'), true, 'the lease was renewed during the long run');
  assert.equal(await other.run('labeling:lt_1', async () => 'second'), null);
  gate.resolve('done');
  assert.equal(await running, 'done');
  assert.equal(await other.isHeld('labeling:lt_1'), false, 'a run that ends releases its lock');
  const renewsAfterResolve = renewsAt.length;
  await tick(30);
  assert.equal(renewsAt.length, renewsAfterResolve, 'no renewal fires after the run resolved: the timer was cleared');

  // The same for a run whose work fails once the gate opens.
  const enteredAgain = deferred();
  const gateAgain = deferred();
  const failing = locks.run('labeling:lt_1', async () => {
    enteredAgain.resolve('in');
    await gateAgain.promise;
    throw new Error('the work failed');
  });
  const rejected = assert.rejects(failing, /the work failed/);
  await enteredAgain.promise;
  await until(() => renewsAt.length > renewsAfterResolve, 'a renewal of the failing run');
  gateAgain.resolve('go');
  await rejected;
  assert.equal(await other.isHeld('labeling:lt_1'), false, 'a run that throws still releases its lock');
  const renewsAfterReject = renewsAt.length;
  await tick(30);
  assert.equal(renewsAt.length, renewsAfterReject, 'no renewal fires after the run rejected: the timer was cleared');
});

test('leaseLocks: a run that outlives its lease does not free the runner that took over', async () => {
  let now = 0;
  const clock = () => now;
  const store = memoryLockStore();
  // A renewal interval far beyond the test, so only the injected clock decides when leases end.
  const one = leaseLocks(store, {leaseMs: 100, renewMs: 60_000, clock});
  const two = leaseLocks(store, {leaseMs: 1000, renewMs: 60_000, clock});
  const firstEntered = deferred();
  const firstGate = deferred();
  const first = one.run('labeling:lt_1', async () => {
    firstEntered.resolve('in');
    return firstGate.promise;
  });
  await firstEntered.promise;
  // One's lease ends while its work is still gated; two takes the lock over.
  now = 150;
  const secondEntered = deferred();
  const secondGate = deferred();
  const second = two.run('labeling:lt_1', async () => {
    secondEntered.resolve('in');
    return secondGate.promise;
  });
  await secondEntered.promise;
  assert.equal(await two.run('labeling:lt_1', async () => 'third'), null, 'two holds the lock it took over');
  // One's work ends now: its release is owner-checked and must leave two's lock intact.
  firstGate.resolve('first');
  assert.equal(await first, 'first');
  assert.equal(await two.isHeld('labeling:lt_1'), true, "one's late release freed nothing");
  assert.equal(await two.run('labeling:lt_1', async () => 'third'), null);
  secondGate.resolve('second');
  assert.equal(await second, 'second');
  assert.equal(await two.isHeld('labeling:lt_1'), false);
});

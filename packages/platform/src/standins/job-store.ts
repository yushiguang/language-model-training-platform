import {ACTIVE_JOB_STATES, type Job, type JobFilter, type JobKind, type JobStorePort} from '@yushiguang/sprint-contracts';

/**
 * The job store stand-in: jobs in this process's memory. Right for the browser (each tab runs its
 * own work, as before the job module) and for tests. Each operation runs to its end before the
 * next starts (one thread), which is the atomicity a shared store gets from SET NX PX, a script
 * or a conditional update. Jobs go in and out as JSON copies, as they would through a store.
 *
 * `claimNext` follows the SQL of docs/design/server.md 5.2 step by step: the candidate keys first
 * (with their limits, read before any "lock"), then one key at a time, where the part that runs
 * without an `await` stands for the short transaction holding the key's row.
 */
export function memoryJobStore(): JobStorePort {
  const jobs = new Map<string, string>();
  /**
   * The `job_keys` rows: when each concurrency key last had a job claimed (null: never), with a
   * claim number that keeps the turns strict when several claims share one millisecond.
   */
  const keys = new Map<string, {at: string; seq: number} | null>();
  let seq = 0;
  const read = (id: string): Job | null => {
    const j = jobs.get(id);
    return j ? (JSON.parse(j) as Job) : null;
  };
  const write = (job: Job) => void jobs.set(job.id, JSON.stringify(job));
  const all = () => [...jobs.keys()].map(id => read(id)!);
  const active = (j: Job) => ACTIVE_JOB_STATES.includes(j.state);
  const matches = (j: Job, f: JobFilter) => (f.projectId === undefined || j.projectId === f.projectId) && (!f.kinds || f.kinds.includes(j.kind)) && (!f.states || f.states.includes(j.state));
  /** Code-unit order, as a binary collation in SQL (and as `countAhead` compares). */
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  /** Oldest first, as `ORDER BY created_at, id`. */
  const byAge = (a: Job, b: Job) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
  /** Never-claimed keys first (by the key itself), then the key claimed longest ago. */
  const byTurn = (a: string, b: string) => {
    const x = keys.get(a) ?? null;
    const y = keys.get(b) ?? null;
    if (!x || !y) return x === y ? cmp(a, b) : x ? 1 : -1;
    return cmp(x.at, y.at) || x.seq - y.seq;
  };
  const holds = (j: Job | null, owner: string): j is Job => !!j && j.state === 'running' && j.lease?.owner === owner;

  return {
    async enqueueOnce(job) {
      if (job.idempotencyKey) {
        const same = all().find(j => j.idempotencyKey === job.idempotencyKey && active(j));
        if (same) return {job: same, created: false};
      }
      if (!keys.has(job.concurrencyKey)) keys.set(job.concurrencyKey, null);
      write(job);
      return {job: read(job.id)!, created: true};
    },
    get: async id => read(id),
    async find(f) {
      return all()
        .filter(j => matches(j, f))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async claimNext(kinds: JobKind[], owner, leaseMs, now, limitOf) {
      const due = (j: Job) => j.state === 'queued' && kinds.includes(j.kind) && (!j.notBefore || j.notBefore <= now);
      // Step 1, no lock: the keys with a due job, in turn order, and their limits.
      const candidates = [...new Set(all().filter(due).map(j => j.concurrencyKey))].sort(byTurn);
      const limits = new Map<string, number>();
      for (const key of candidates) limits.set(key, await limitOf(key));
      // Step 2: one key at a time. No await from here on: the key's "transaction".
      for (const key of candidates) {
        const list = all().filter(j => j.concurrencyKey === key);
        if (list.filter(j => j.state === 'running').length >= limits.get(key)!) continue;
        const next = list.filter(due).sort(byAge)[0];
        if (!next) continue;
        const claimed: Job = {...next, state: 'running', attempts: next.attempts + 1, lease: {owner, until: plus(now, leaseMs)}, startedAt: next.startedAt ?? now, heartbeatAt: now};
        write(claimed);
        keys.set(key, {at: now, seq: ++seq});
        return read(claimed.id);
      }
      return null;
    },
    async countAhead(concurrencyKey, createdAt, id) {
      return all().filter(j => j.concurrencyKey === concurrencyKey && j.state === 'queued' && (j.createdAt < createdAt || (j.createdAt === createdAt && j.id < id))).length;
    },
    async heartbeat(id, owner, leaseMs, now, progress) {
      const j = read(id);
      if (!holds(j, owner)) return {held: false, cancelRequested: !!read(id)?.cancelRequested};
      write({...j, lease: {owner, until: plus(now, leaseMs)}, heartbeatAt: now, ...(progress ? {progress} : {})});
      return {held: true, cancelRequested: j.cancelRequested};
    },
    async finish(id, owner, outcome, now) {
      const j = read(id);
      if (!holds(j, owner)) return null;
      const ended: Job = {...j, state: outcome.state, error: outcome.state === 'done' ? null : (outcome.error ?? null), lease: null, endedAt: now};
      write(ended);
      return read(id);
    },
    async requeue(id, owner, notBefore, error) {
      const j = read(id);
      if (!holds(j, owner)) return;
      write({...j, state: 'queued', lease: null, notBefore, error});
    },
    async requestCancel(id, now) {
      const j = read(id);
      if (!j) return {job: null, ended: false};
      const ended = j.state === 'queued';
      if (ended) write({...j, state: 'cancelled', cancelRequested: true, error: 'Cancelled before it started.', endedAt: now});
      else if (j.state === 'running') write({...j, cancelRequested: true});
      return {job: read(id), ended};
    },
    async recoverExpired(now, maxAttempts) {
      let requeued = 0;
      let failed = 0;
      const ended: Job[] = [];
      for (const j of all()) {
        if (j.state !== 'running' || !j.lease || j.lease.until > now) continue;
        if (j.cancelRequested) {
          write({...j, state: 'cancelled', lease: null, endedAt: now, error: j.error ?? 'Cancelled.'});
          ended.push(read(j.id)!);
        } else if (j.attempts >= maxAttempts) {
          write({...j, state: 'failed', lease: null, endedAt: now, error: 'The work stopped answering too many times.'});
          ended.push(read(j.id)!);
          failed++;
        } else {
          write({...j, state: 'queued', lease: null});
          requeued++;
        }
      }
      return {requeued, failed, ended};
    },
  };
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

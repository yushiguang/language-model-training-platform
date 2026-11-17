import {ACTIVE_JOB_STATES, type Job, type JobFilter, type JobKind, type JobStorePort} from '@sprint/contracts';

/**
 * The job store stand-in: jobs in this process's memory. Right for the browser (each tab runs its
 * own work, as before the job module) and for tests. Each operation runs to its end before the
 * next starts (one thread), which is the atomicity a shared store gets from SET NX PX, a script
 * or a conditional update. Jobs go in and out as JSON copies, as they would through a store.
 */
export function memoryJobStore(): JobStorePort {
  const jobs = new Map<string, string>();
  const read = (id: string): Job | null => {
    const j = jobs.get(id);
    return j ? (JSON.parse(j) as Job) : null;
  };
  const write = (job: Job) => void jobs.set(job.id, JSON.stringify(job));
  const all = () => [...jobs.keys()].map(id => read(id)!);
  const active = (j: Job) => ACTIVE_JOB_STATES.includes(j.state);
  const matches = (j: Job, f: JobFilter) => (f.projectId === undefined || j.projectId === f.projectId) && (!f.kinds || f.kinds.includes(j.kind)) && (!f.states || f.states.includes(j.state));
  const tenantOf = (j: Job) => j.ctx.tenantId ?? '';
  const holds = (j: Job | null, owner: string): j is Job => !!j && j.state === 'running' && j.lease?.owner === owner;

  return {
    async enqueueOnce(job) {
      if (job.idempotencyKey) {
        const same = all().find(j => j.idempotencyKey === job.idempotencyKey && active(j));
        if (same) return {job: same, created: false};
      }
      write(job);
      return {job: read(job.id)!, created: true};
    },
    get: async id => read(id),
    async find(f) {
      return all()
        .filter(j => matches(j, f))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async claimNext(kinds: JobKind[], owner, leaseMs, now) {
      const list = all();
      const running = new Map<string, number>();
      for (const j of list) if (j.state === 'running') running.set(tenantOf(j), (running.get(tenantOf(j)) ?? 0) + 1);
      const next = list
        .filter(j => j.state === 'queued' && kinds.includes(j.kind) && (!j.notBefore || j.notBefore <= now))
        .sort((a, b) => (running.get(tenantOf(a)) ?? 0) - (running.get(tenantOf(b)) ?? 0) || a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return null;
      const claimed: Job = {...next, state: 'running', attempts: next.attempts + 1, lease: {owner, until: plus(now, leaseMs)}, startedAt: next.startedAt ?? now, heartbeatAt: now};
      write(claimed);
      return read(claimed.id);
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
      if (!j) return null;
      if (j.state === 'queued') write({...j, state: 'cancelled', cancelRequested: true, error: 'Cancelled before it started.', endedAt: now});
      else if (j.state === 'running') write({...j, cancelRequested: true});
      return read(id);
    },
    async recoverExpired(now, maxAttempts) {
      let requeued = 0;
      let failed = 0;
      for (const j of all()) {
        if (j.state !== 'running' || !j.lease || j.lease.until > now) continue;
        if (j.cancelRequested) write({...j, state: 'cancelled', lease: null, endedAt: now, error: j.error ?? 'Cancelled.'});
        else if (j.attempts >= maxAttempts) {
          write({...j, state: 'failed', lease: null, endedAt: now, error: 'The work stopped answering too many times.'});
          failed++;
        } else {
          write({...j, state: 'queued', lease: null});
          requeued++;
        }
      }
      return {requeued, failed};
    },
  };
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

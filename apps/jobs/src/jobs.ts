import {NO_TELEMETRY, type ConfigReader, type Job, type JobContext, type JobControl, type JobExecutor, type JobKind, type JobOutcome, type JobProgress, type JobRequest, type JobsContract, type JobStorePort, type RequestContext, type TelemetryPort} from '@yushiguang/sprint-contracts';
import {newId, parseConcurrencyKey, processConfigReader} from '@yushiguang/sprint-domain';

/**
 * The job module (`@yushiguang/sprint-jobs`, deployment readiness spec, 3): one way to run every piece of
 * background work. It owns the queue (through the injected `JobStorePort`), one runner per job
 * (a lease that a heartbeat extends), recovery of jobs whose runner died (`sweep`), retries,
 * cancellation, and how many jobs of one concurrency key run at once (the key's limit from
 * configuration, counted in the store across every runner; docs/design/server.md, 5). It knows
 * no business rule: each kind's work is a `JobExecutor` registered by the app that owns it.
 *
 * In the browser and in tests the store is in memory and a job starts as soon as it is enqueued
 * (`runOnEnqueue`). On a server, a worker process registers the executors and calls `poll`, and a
 * cron job calls `sweep`; the other processes only enqueue.
 */
export interface JobsDeps {
  store: JobStorePort;
  /** This runner's name on the leases it holds. Default: a new id per process. */
  owner?: string;
  /** How long a lease lasts without a heartbeat (default 30 s). */
  leaseMs?: number;
  /** How often a running job's lease is extended (default a third of the lease). */
  heartbeatMs?: number;
  /** A job whose lease ended this many times fails instead of running again (default 3). */
  maxAttempts?: number;
  /** Jobs this runner runs at once, whatever their keys (default 16): this process's own cap. */
  concurrency?: number;
  /** The wait before a retry, times the attempt (default 1 s). */
  retryDelayMs?: number;
  /** Start queued jobs in this process as soon as they are enqueued here (default true). */
  runOnEnqueue?: boolean;
  telemetry?: TelemetryPort;
  /**
   * Configuration: each concurrency key's limit (`jobLimit` of the key's tenant and target), and
   * the executors' `JobControl.config`. Default: process-level values only.
   */
  config?: ConfigReader;
  clock?: () => number;
}

export interface Jobs {
  /** What callers use: enqueue, read, cancel. */
  api: JobsContract;
  /** Registers the work of one kind; this runner then takes jobs of that kind. */
  register(executor: JobExecutor): void;
  /** Takes queued jobs until none is left or `concurrency` jobs run. */
  drain(): void;
  /** Puts jobs whose lease ended back in the queue (or fails them), then drains. For a cron job. */
  sweep(): Promise<{requeued: number; failed: number}>;
  /** Takes queued jobs every `intervalMs` (a server worker). Returns the stop. */
  poll(intervalMs: number): () => void;
  /** Resolves once this runner runs nothing and has nothing queued that it could take. */
  idle(): Promise<void>;
  /** A job was enqueued, moved on or ended. Carries no data: listeners read again. */
  onChange(fn: () => void): () => void;
}

interface Running {
  job: Job;
  ctrl: AbortController;
  progress: JobProgress | null;
  /** The last heartbeat or progress write, so they go to the store one after another. */
  writing: Promise<unknown>;
  cancelled: boolean;
  lost: boolean;
}

/** How many times a runner tries to save how a job ended before it gives up on the store. */
const FINISH_TRIES = 3;

export function createJobs(deps: JobsDeps): Jobs {
  const {store} = deps;
  const owner = deps.owner ?? newId('runner');
  const leaseMs = deps.leaseMs ?? 30_000;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(leaseMs / 3));
  const maxAttempts = deps.maxAttempts ?? 3;
  const concurrency = deps.concurrency ?? 16;
  const retryDelayMs = deps.retryDelayMs ?? 1000;
  const runOnEnqueue = deps.runOnEnqueue ?? true;
  const tm = deps.telemetry ?? NO_TELEMETRY;
  const clock = deps.clock ?? Date.now;
  const config = deps.config ?? processConfigReader();
  const nowIso = () => new Date(clock()).toISOString();

  const executors = new Map<JobKind, JobExecutor>();
  const running = new Map<string, Running>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());

  /**
   * Job ids that sort by when they were made: a queue takes jobs by `createdAt` and then `id`, so
   * two jobs enqueued in the same millisecond by this runner still go in the order they came.
   */
  let seq = 0;
  const jobId = () => `job_${clock().toString(36).padStart(9, '0')}${(seq++ % 1296).toString(36).padStart(2, '0')}${newId('').slice(1, 9)}`;

  let draining = false;
  /** Drain passes ended, and jobs claimed, so far: `idle()` sees a pass that took nothing. */
  let passes = 0;
  let claimed = 0;
  let again = false;

  function contextOf(ctx: RequestContext | JobContext): JobContext {
    const out: JobContext = {requestId: ctx.requestId, user: {id: ctx.user.id, name: ctx.user.name, ...(ctx.user.email ? {email: ctx.user.email} : {})}};
    if (ctx.tenantId) out.tenantId = ctx.tenantId;
    if (ctx.locale) out.locale = ctx.locale;
    if (ctx.timeZone) out.timeZone = ctx.timeZone;
    if (ctx.appVersion) out.appVersion = ctx.appVersion;
    if (ctx.caller) out.caller = ctx.caller;
    return out;
  }

  /** A key's limit, read for its tenant and target. */
  async function limitOf(key: string): Promise<number> {
    const parsed = parseConcurrencyKey(key);
    // enqueue refuses such keys; one written by another program waits rather than runs unlimited.
    if (!parsed) return 0;
    return config.forTenant(parsed.tenantId).jobLimit(parsed.target);
  }

  /** Refuses a request whose key, or the key of anything it chains, is not a concurrency key. */
  function checkKeys(req: JobRequest) {
    if (!parseConcurrencyKey(req.concurrencyKey)) throw new Error(`Not a job concurrency key: "${req.concurrencyKey}".`);
    if (req.then) checkKeys(req.then);
    if (req.finally) checkKeys(req.finally);
  }

  async function enqueue(ctx: RequestContext | JobContext, req: JobRequest): Promise<Job> {
    checkKeys(req);
    const job: Job = {
      id: jobId(),
      kind: req.kind,
      projectId: req.projectId,
      args: req.args,
      idempotencyKey: req.idempotencyKey ?? null,
      concurrencyKey: req.concurrencyKey,
      then: req.then ?? null,
      finally: req.finally ?? null,
      state: 'queued',
      progress: null,
      error: null,
      attempts: 0,
      notBefore: null,
      cancelRequested: false,
      ctx: contextOf(ctx),
      lease: null,
      createdAt: nowIso(),
      startedAt: null,
      heartbeatAt: null,
      endedAt: null,
    };
    const {job: kept, created} = await store.enqueueOnce(job);
    if (created) {
      tm.counter('sprint_jobs_enqueued_total', {job_kind: req.kind});
      emit();
      if (runOnEnqueue) drain();
    }
    return kept;
  }

  /** Extends the lease and saves progress; aborts the work when the lease is lost or a cancel came. */
  function beat(r: Running) {
    r.writing = r.writing
      .then(() => store.heartbeat(r.job.id, owner, leaseMs, nowIso(), r.progress))
      .then(
        ({held, cancelRequested}) => {
          if (!held && !r.ctrl.signal.aborted) {
            r.lost = true;
            r.ctrl.abort(new Error('Another runner took this job over.'));
          } else if (cancelRequested && !r.ctrl.signal.aborted) {
            r.cancelled = true;
            r.ctrl.abort(new Error('Cancelled.'));
          }
        },
        () => undefined,
      );
    return r.writing;
  }

  /**
   * Saves how the job ended, trying again when the store fails. Returns the ended job, null when
   * this runner no longer holds it (another runner took it over), or 'error' when the store
   * kept failing.
   */
  async function finish(job: Job, outcome: JobOutcome): Promise<Job | null | 'error'> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.finish(job.id, owner, outcome, nowIso());
      } catch {
        if (attempt >= FINISH_TRIES) return 'error';
        await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }

  /**
   * The job chained after `job`. Its idempotency key names the parent, so the chain queued
   * by a runner and again by a later run of the same parent is one job while it is active.
   */
  const chained = (job: Job): JobRequest => ({...job.then!, idempotencyKey: job.then!.idempotencyKey ?? `then:${job.id}`});

  /**
   * Queues the `finally` of a job that has ended (in any way), once: its idempotency key names
   * the job, and only the one place that saw the end (the runner's finish, a cancel of a queued
   * job, the sweep) calls this.
   */
  async function afterEnd(job: Job) {
    if (!job.finally || !['done', 'failed', 'cancelled'].includes(job.state)) return;
    await enqueue(job.ctx, {...job.finally, idempotencyKey: job.finally.idempotencyKey ?? `finally:${job.id}`}).catch(() => undefined);
  }

  function start(job: Job) {
    const executor = executors.get(job.kind)!;
    const r: Running = {job, ctrl: new AbortController(), progress: job.progress, writing: Promise.resolve(), cancelled: false, lost: false};
    running.set(job.id, r);
    const startedAt = clock();
    const timer = setInterval(() => void beat(r), heartbeatMs);
    const ctl: JobControl = {
      job,
      signal: r.ctrl.signal,
      async progress(p) {
        r.progress = p;
        await beat(r);
        emit();
      },
      cancelled: () => r.cancelled,
      config,
    };
    emit();
    void (async () => {
      let outcome: JobOutcome;
      try {
        outcome = await executor.run(job, ctl);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        if (r.cancelled) outcome = {state: 'cancelled', error: 'Cancelled.'};
        else if (!r.lost && job.attempts <= (executor.retries ?? 0)) {
          clearInterval(timer);
          await r.writing;
          const notBefore = clock() + retryDelayMs * job.attempts;
          await store.requeue(job.id, owner, new Date(notBefore).toISOString(), message);
          tm.counter('sprint_jobs_ended_total', {job_kind: job.kind, outcome: 'retried'});
          done();
          wakeAt(notBefore);
          return;
        } else outcome = {state: 'failed', error: message};
      }
      // A cancel that came while the work ended cleanly still ends it as cancelled.
      if (r.cancelled && outcome.state === 'done') outcome = {state: 'cancelled', error: 'Cancelled.'};
      clearInterval(timer);
      await r.writing;
      const ended = await finish(job, outcome);
      tm.histogram('sprint_job_duration_seconds', (clock() - startedAt) / 1000, {job_kind: job.kind});
      tm.counter('sprint_jobs_ended_total', {job_kind: job.kind, outcome: ended === 'error' ? 'store_error' : ended ? ended.state : 'lost'});
      // The chained job follows work that ended done. A lost lease queues nothing: the runner
      // that took the job over chains it. When the store kept failing, the job stays running
      // until its lease ends; the sweep then runs it again, and that run chains. On the job's
      // last attempt the sweep fails it instead, so the chain is queued here, once (#26).
      const chainNow = ended === 'error' ? outcome.state === 'done' && job.then && job.attempts >= maxAttempts : ended?.state === 'done' && ended.then;
      if (chainNow) await enqueue(job.ctx, chained(job)).catch(() => undefined);
      // The end that this runner saved (a lost lease or a store that kept failing saved none:
      // the runner that took over, or the sweep that fails the job, queues it).
      if (ended && ended !== 'error') await afterEnd(ended);
      // Only now: what follows is in the store before this runner counts the job gone, wakes
      // `idle()` and drains again.
      done();
    })();
    function done() {
      clearInterval(timer);
      running.delete(job.id);
      emit();
      drain();
    }
  }

  /**
   * Drains once `clock()` has reached `at`. A timer may fire a little before the wall clock gets
   * there (timers and `Date.now` are different clocks), and a drain then would find the job not
   * due yet with nothing left to wake it: so it checks, and waits again if early.
   */
  function wakeAt(at: number) {
    setTimeout(() => (clock() >= at ? drain() : wakeAt(at)), Math.max(1, at - clock()));
  }

  function drain() {
    if (draining) {
      again = true;
      return;
    }
    if (!executors.size) return;
    draining = true;
    void (async () => {
      try {
        do {
          again = false;
          while (running.size < concurrency) {
            const job = await store.claimNext([...executors.keys()], owner, leaseMs, nowIso(), limitOf);
            if (!job) break;
            claimed++;
            start(job);
          }
        } while (again);
      } catch {
        // The store did not answer: the next enqueue, poll or sweep tries again.
      } finally {
        draining = false;
        passes++;
        emit();
      }
    })();
  }

  const api: JobsContract = {
    enqueue: (ctx, req) => enqueue(ctx, req),
    get: async (_ctx, jobId) => store.get(jobId),
    list: async (_ctx, filter) => store.find(filter),
    async cancel(_ctx, jobId) {
      const {job: after, ended} = await store.requestCancel(jobId, nowIso());
      const r = running.get(jobId);
      if (r && !r.ctrl.signal.aborted) {
        r.cancelled = true;
        r.ctrl.abort(new Error('Cancelled.'));
      }
      if (after) emit();
      if (after && ended) await afterEnd(after);
    },
    async ahead(_ctx, jobId) {
      const job = await store.get(jobId);
      if (!job || job.state !== 'queued') return null;
      return store.countAhead(job.concurrencyKey, job.createdAt, job.id);
    },
  };

  return {
    api,
    register(executor) {
      executors.set(executor.kind, executor);
      if (runOnEnqueue) drain();
    },
    drain,
    async sweep() {
      const out = await store.recoverExpired(nowIso(), maxAttempts);
      if (out.requeued) tm.counter('sprint_jobs_recovered_total', {outcome: 'requeued'}, out.requeued);
      if (out.failed) tm.counter('sprint_jobs_recovered_total', {outcome: 'failed'}, out.failed);
      if (out.requeued || out.ended.length) emit();
      for (const job of out.ended) await afterEnd(job);
      drain();
      return {requeued: out.requeued, failed: out.failed};
    },
    poll(intervalMs) {
      const t = setInterval(drain, intervalMs);
      drain();
      return () => clearInterval(t);
    },
    async idle() {
      // The drain this call started, and the claims before it: a whole pass that took nothing
      // means what is queued waits for a key's limit (another runner holds it), not for us.
      let mine: {pass: number; claimed: number} | null = null;
      for (;;) {
        if (!running.size && !draining) {
          const now = nowIso();
          const queued = await store.find({states: ['queued']});
          if (!queued.some(j => executors.has(j.kind) && (!j.notBefore || j.notBefore <= now))) return;
          if (mine && passes > mine.pass && claimed === mine.claimed) return;
          mine = {pass: passes, claimed};
          drain();
        }
        await new Promise<void>(resolve => {
          const off = new Set<() => void>();
          const t = setTimeout(finish, 20);
          function finish() {
            clearTimeout(t);
            off.forEach(f => f());
            resolve();
          }
          const fn = () => finish();
          listeners.add(fn);
          off.add(() => listeners.delete(fn));
        });
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

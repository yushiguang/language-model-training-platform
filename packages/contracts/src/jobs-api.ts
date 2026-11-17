import type {RequestContext} from './platform-api.ts';

/**
 * Contract: background work (deployment readiness spec, 3). Every piece of work that outlives a
 * request (labeling an eval set, building a report, sampling a dataset, an Optimiser run,
 * deleting a project) is a job. The job module (`@yushiguang/sprint-jobs`) owns the queue, one runner per
 * job (a lease with expiry), heartbeats, recovery of expired leases, retries, cancellation and
 * fair scheduling across tenants. It knows no business rule: the work itself is done by an
 * executor that the owning app registers per kind.
 *
 * A job record holds ids, never records. Domain state stays with the domain: a labeling job points
 * at its `LabelingTask` (counters, failed lists), an Optimiser job at its run. The job record is
 * only the lease and lifecycle around them, so an executor resumes from the saved records.
 */

/** The kinds of work. `batch_labeling.run` and `export.run` are reserved: no executor yet. */
export type JobKind = 'labeling.runTask' | 'report.build' | 'dataset.sample' | 'optimiser.run' | 'project.delete' | 'batch_labeling.run' | 'export.run';

/**
 * - `queued`: waiting for a runner.
 * - `running`: a runner holds its lease.
 * - `paused`: the work stopped part-way and can go on later (a closed budget, a Stop that keeps
 *   what was done); a new job continues it.
 * - `failed`, `done`, `cancelled`: ended.
 */
export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'done' | 'cancelled';
export const ACTIVE_JOB_STATES: readonly JobStatus[] = ['queued', 'running'];

/** Plain JSON arguments: ids, counts and flags, never records. */
export type JobArgs = Record<string, string | number | boolean | null>;

export interface JobRequest {
  kind: JobKind;
  /** The project the work is for; null for work that belongs to no project. */
  projectId: string | null;
  args: JobArgs;
  /**
   * The same key never has two jobs at once: while a job with this key is queued or running,
   * enqueueing it again returns that job. Once it ended, the key may start new work (executors
   * resume from saved records, so finished work is not done again).
   */
  idempotencyKey?: string;
  /** Enqueued with the same context when this job ends `done`: the next step of a chain. */
  then?: JobRequest;
}

/** How far a job is, as the executor last reported it. */
export interface JobProgress {
  done: number;
  total: number;
  /** All items are in and the results are being saved (no Stop any more). */
  saving?: boolean;
}

/** Who the work runs as: the caller that enqueued it (ids and names only). */
export type JobContext = Pick<RequestContext, 'requestId' | 'user' | 'tenantId' | 'locale' | 'timeZone' | 'appVersion' | 'caller'>;

export interface Job {
  id: string;
  kind: JobKind;
  projectId: string | null;
  args: JobArgs;
  idempotencyKey: string | null;
  then: JobRequest | null;
  state: JobStatus;
  progress: JobProgress | null;
  /** Why it failed or was cancelled, in words a person can read. */
  error: string | null;
  /** Times a runner took it (a lease that expired counts). */
  attempts: number;
  /** Not before this time (a retry waits a little). */
  notBefore: string | null;
  /** Set by `cancel`; the runner sees it on its next heartbeat. */
  cancelRequested: boolean;
  ctx: JobContext;
  /** The runner that holds it and until when; null when no runner does. */
  lease: {owner: string; until: string} | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  endedAt: string | null;
}

/** How an executor's work ended. */
export type JobOutcome = {state: 'done'} | {state: 'paused' | 'failed' | 'cancelled'; error?: string};

/** What a runner gives an executor while it runs one job (in the runner's own process). */
export interface JobControl {
  readonly job: Job;
  /** Aborted when the job is cancelled or its lease is lost: stop at the next safe point. */
  readonly signal: AbortSignal;
  /** Saves progress with a heartbeat; resolves once it is in the store. */
  progress(p: JobProgress): Promise<void>;
  /**
   * True when `signal` was aborted by a cancel (the user's Stop); false when the lease was lost
   * (another runner took the job over, and resumes it from the saved records).
   */
  cancelled(): boolean;
}

/**
 * The work of one kind, registered by the app that owns it with the job module of its process.
 * It must be resumable from saved records at any point: a job whose runner died runs again.
 */
export interface JobExecutor {
  kind: JobKind;
  run(job: Job, ctl: JobControl): Promise<JobOutcome>;
  /** Times a job that threw is tried again before it fails (default 0). */
  retries?: number;
}

export interface JobFilter {
  projectId?: string;
  kinds?: JobKind[];
  states?: JobStatus[];
}

/** What callers ask of the job module, in or across processes. */
export interface JobsContract {
  /** Enqueues work, or returns the queued or running job with the same idempotency key. */
  enqueue(ctx: RequestContext, req: JobRequest): Promise<Job>;
  get(ctx: RequestContext, jobId: string): Promise<Job | null>;
  /** Jobs that match, newest first. */
  list(ctx: RequestContext, filter: JobFilter): Promise<Job[]>;
  /** A queued job is cancelled at once; a running one when its runner next looks. */
  cancel(ctx: RequestContext, jobId: string): Promise<void>;
}

/**
 * Where jobs are kept: injected into the job module (deployment readiness spec, 3; review P1). It
 * asks for whole operations, each atomic in the store, so several runners in several processes
 * never take the same job: a shared store (Redis with SET NX PX and scripts, or SQL with
 * conditional updates) implements them; `memoryJobStore` in `@yushiguang/sprint-platform` is the stand-in
 * for one process. Times are ISO strings; `now` is passed in so tests control the clock.
 */
export interface JobStorePort {
  /** Saves the job unless one with its idempotency key is queued or running; returns the one kept. */
  enqueueOnce(job: Job): Promise<{job: Job; created: boolean}>;
  get(jobId: string): Promise<Job | null>;
  find(filter: JobFilter): Promise<Job[]>;
  /**
   * Takes the next queued job of these kinds whose `notBefore` has passed: marks it running with
   * a lease for `owner` until `now + leaseMs`, and counts the attempt. Fair across tenants: the
   * oldest job of the tenant with the fewest running jobs goes first.
   */
  claimNext(kinds: JobKind[], owner: string, leaseMs: number, now: string): Promise<Job | null>;
  /**
   * Extends the lease and saves progress, if `owner` still holds it. Says whether it does, and
   * whether a cancel was asked for.
   */
  heartbeat(jobId: string, owner: string, leaseMs: number, now: string, progress: JobProgress | null): Promise<{held: boolean; cancelRequested: boolean}>;
  /** Ends the job, if `owner` still holds it; null when it does not (another runner took over). */
  finish(jobId: string, owner: string, outcome: JobOutcome, now: string): Promise<Job | null>;
  /** Back to the queue (a retry), if `owner` holds it, not before `notBefore`. */
  requeue(jobId: string, owner: string, notBefore: string, error: string): Promise<void>;
  /** Cancels a queued job at once, or flags a running one. Returns the job after. */
  requestCancel(jobId: string, now: string): Promise<Job | null>;
  /**
   * The sweep: every running job whose lease ended before `now` goes back to the queue, or fails
   * once it has had `maxAttempts`. Returns how many were recovered and failed.
   */
  recoverExpired(now: string, maxAttempts: number): Promise<{requeued: number; failed: number}>;
}

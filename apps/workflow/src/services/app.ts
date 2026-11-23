import {NO_TELEMETRY, type AuthorizationPort, type PermissionAdminPort, type ConfigReader, type TicketPort, type NotificationPort, type AgentRuntimeContract, type CallerUser, type CatalogContract, type ExampleSource, type DocumentSource, type FeatureInfoSource, type FeatureStorePort, type FileStore, type JobsContract, type MediaSource, type LabelingContract, type LlmGatewayContract, type LockPort, type OptimiserContract, type Prediction, type RequestContext, type SharedStatePort, type TelemetryPort} from '@yushiguang/sprint-contracts';
import {newId, processConfigReader} from '@yushiguang/sprint-domain';

/**
 * The workflow module's wiring (deployment readiness spec, 2). `createWorkflow` builds one
 * `Instance` from these dependencies; nothing lives at module level, so two instances (two test
 * worlds, two tenants) never share state. Every call then runs in a `Scope`: the instance plus the
 * caller's `RequestContext`, so who did what comes from the call, never from a process-wide user.
 */

/** One runner per piece of work across the tabs of this browser; see `LockPort`. */
export type WorkLocks = LockPort;

export interface WorkflowDeps {
  catalog: CatalogContract;
  labeling: LabelingContract;
  gateway: LlmGatewayContract;
  files: FileStore;
  examples: ExampleSource;
  /**
   * Where taken examples' frozen features are written, a batch at a time (docs/design/server.md
   * 6): the object-storage store the catalog reads them from (`objectFeatureStore` in
   * `@yushiguang/sprint-catalog`), whose batch is one write that lands whole or not at all. Leave
   * it out otherwise: features are then written one document each through the catalog, so one
   * failed write skips only its own example.
   */
  features?: FeatureStorePort;
  /** Optional media for people to look at; see `MediaSource`. */
  media?: MediaSource;
  /** Optional feature descriptions (hover text, and the agents' read_feature_info tool). */
  featureInfo?: FeatureInfoSource;
  /** Optional document reading for links in Ask AI (the helpers' read_doc tool). */
  documents?: DocumentSource;
  /** Where problem reports go (spec 1.1.0, 3). Without it the helpers say reports cannot be sent. */
  tickets?: TicketPort;
  /**
   * Sends notifications (docs/design/server.md, 8): the person who started scoring or an
   * Optimiser run hears how it ended. Best effort; without it nothing is sent.
   */
  notifications?: NotificationPort;
  /** The app's version, written into problem reports. */
  appVersion?: string;
  standIns: string[];
  telemetry?: TelemetryPort;
  /** Keeps a second tab from running the same optimiser; without it, only this instance is covered. */
  locks?: WorkLocks;
  /**
   * Short-lived state every instance of the module must see (the live turn, the helper that
   * answers, problem-report drafts), with TTL expiry. `@yushiguang/sprint-platform` has an in-memory stand-in.
   */
  sharedState: SharedStatePort;
  /**
   * Where background work goes (`@yushiguang/sprint-jobs`): scoring, reports, sampling, Optimiser runs and
   * project deletion are jobs; the workflow only enqueues and reads them back.
   */
  jobs: JobsContract;
  /**
   * Whether the pages' `tick` checks what should run (default true: the browser build). A server
   * deployment sets false and calls `sweep()` from a cron job instead, so a page never becomes a
   * second driver (review G8).
   */
  tickFromPages?: boolean;
  /**
   * Writes to one project within this window give one new revision (review G9; default 200 ms),
   * so a labeling run does not write the revision once per example.
   */
  revisionCoalesceMs?: number;
  /**
   * Configuration read per tenant (docs/design/server.md, 7): `w.config.forTenant(w.ctx.tenantId)`.
   * Default: process-level values only.
   */
  config?: ConfigReader;
  /**
   * Asks the permission platform before every read and write (docs/design/server.md, 2). Without
   * it every signed-in caller may do everything; the tenant of a project is checked either way.
   */
  authorization?: AuthorizationPort;
  /** Writes permissions (the creator's project write). Without it no grant is written. */
  permissionAdmin?: PermissionAdminPort;
  /** The first wait before a failed grant is tried again (default 200 ms, doubling; tests pass 0). */
  grantRetryMs?: number;
}

/** Built after the workflow, since they call back into it (`connect`). */
export interface Connected {
  agents: AgentRuntimeContract;
  /** The Optimiser service (`@yushiguang/sprint-optimiser`). Without it Auto Optimise is not available. */
  optimiser?: OptimiserContract;
}

export interface Instance extends WorkflowDeps, Connected {
  locks: WorkLocks;
  config: ConfigReader;
  tm: TelemetryPort;
  shared: SharedStatePort;
  /**
   * Some record of `projectId` changed (null: of no single project, such as the project list):
   * the `changes` event, and a new revision of the project (review G9). Events carry no data;
   * listeners read again.
   */
  emitChange(projectId: string | null): void;
  /** The project's revision as last written; a write still waiting in this instance is written first. */
  revisionOf(projectId: string): Promise<string>;
  /** A running turn moved on: the `agent_live` event. */
  emitLive(): void;
  onChange(fn: () => void): () => void;
  onLive(fn: () => void): () => void;
  /** Stops this instance from starting the same step twice while the first is still being set up. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
  busy(key: string): boolean;
  /**
   * Ask AI turns run on after the call that accepted them returned (deployment readiness spec, 6).
   * `turnRunning` keeps hold of one; `turnsIdle` waits for those running in this instance (tests,
   * and a server that drains before it stops).
   */
  turnRunning(turn: Promise<void>): void;
  turnsIdle(): Promise<void>;
  /**
   * State that stays with this instance: two caches of facts that can be worked out again.
   */
  local: {
    /** Reports that cannot be built from saved answers, as "versionId|endpoint|contextId" (R5-4). */
    cannotBuild: Set<string>;
    /** Saved answers on the whole eval set, by version, model and settings (R5-5). */
    fullAnswers: Map<string, Map<string, Prediction>>;
    /** Projects saved before `Project.tenantId` are given one once per instance, before the first read. */
    tenantsBackfilled?: Promise<void>;
  };
  /** The scope one call runs in. */
  scope(ctx: RequestContext): Scope;
}

/** One call: the instance and the caller's context. Every service function takes it first. */
export interface Scope extends Instance {
  ctx: RequestContext;
  /** The caller, from the context. */
  user(): Promise<CallerUser>;
}

export function createInstance(deps: WorkflowDeps): Instance & {connect(c: Connected): void} {
  const changeListeners = new Set<() => void>();
  const liveListeners = new Set<() => void>();
  const starting = new Set<string>();
  const turns = new Set<Promise<void>>();
  const revisions = projectRevisions(deps.sharedState, deps.revisionCoalesceMs ?? 200);
  const inst: Instance & {connect(c: Connected): void} = {
    ...deps,
    agents: notConnected,
    locks: deps.locks ?? memoryWorkLocks(),
    config: deps.config ?? processConfigReader(),
    tm: deps.telemetry ?? NO_TELEMETRY,
    shared: deps.sharedState,
    emitChange(projectId) {
      if (projectId) revisions.bump(projectId);
      changeListeners.forEach(fn => fn());
    },
    revisionOf: projectId => revisions.read(projectId),
    emitLive: () => liveListeners.forEach(fn => fn()),
    onChange(fn) {
      changeListeners.add(fn);
      return () => void changeListeners.delete(fn);
    },
    onLive(fn) {
      liveListeners.add(fn);
      return () => void liveListeners.delete(fn);
    },
    async once(key, fn) {
      if (starting.has(key)) return null;
      starting.add(key);
      try {
        return await fn();
      } finally {
        starting.delete(key);
      }
    },
    busy: key => starting.has(key),
    turnRunning(turn) {
      turns.add(turn);
      void turn.finally(() => turns.delete(turn));
    },
    async turnsIdle() {
      while (turns.size) await Promise.allSettled([...turns]);
    },
    local: {cannotBuild: new Set(), fullAnswers: new Map()},
    // The scope reads the instance live (not a copy), so services connected later are seen.
    scope: ctx => Object.assign(Object.create(inst) as Scope, {ctx, user: async () => ctx.user}),
    connect(c) {
      inst.agents = c.agents;
      inst.optimiser = c.optimiser;
    },
  };
  return inst;
}

/**
 * Per-project revisions (review G9), in shared state so every replica sees them. A revision is a
 * new random id on every change, not a count: shared state has no atomic increment, so two
 * replicas counting at once could both write the same number and a client would miss a change; two
 * fresh ids never collide. Clients compare it for equality only. Bumps are coalesced per project.
 */
function projectRevisions(shared: SharedStatePort, coalesceMs: number) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const key = (projectId: string) => `revision:${projectId}`;
  const write = (projectId: string) => shared.set(key(projectId), newId('rev'), REVISION_TTL_MS).catch(() => undefined);
  async function flush() {
    timer = null;
    const ids = [...pending];
    pending.clear();
    await Promise.all(ids.map(write));
  }
  return {
    bump(projectId: string) {
      pending.add(projectId);
      timer ??= setTimeout(() => void flush(), coalesceMs);
    },
    async read(projectId: string): Promise<string> {
      if (pending.delete(projectId)) await write(projectId);
      // Expired or never written: a fixed value that differs from every written one.
      return (await shared.get<string>(key(projectId))) ?? 'rev_none';
    },
  };
}

/** A revision outlives any page left open; after it expires, the next write starts a new one. */
const REVISION_TTL_MS = 30 * 24 * 3600 * 1000;

/** A context for work no person started by this call (the Optimiser's loop, a helper's tool with no turn). */
export function systemContext(caller: string, from?: RequestContext): RequestContext {
  return {...from, requestId: newId('rq'), user: from?.user ?? {id: caller, name: caller}, caller};
}

const notConnected = new Proxy({} as AgentRuntimeContract, {
  get() {
    throw new Error('The workflow is not connected to the agent runtime: call connect() first.');
  },
});

function memoryWorkLocks(): WorkLocks {
  const held = new Set<string>();
  return {
    async run(name, fn) {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    },
    isHeld: async name => held.has(name),
  };
}

export const now = () => new Date().toISOString();

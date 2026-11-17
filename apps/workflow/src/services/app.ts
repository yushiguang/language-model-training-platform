import {NO_TELEMETRY, type TicketPort, type AgentRuntimeContract, type AgentTurnProgress, type CallerUser, type CatalogContract, type ExampleSource, type DocumentSource, type FeatureInfoSource, type FileStore, type JobsContract, type MediaSource, type LabelingContract, type LlmGatewayContract, type LockPort, type OptimiserContract, type Prediction, type RequestContext, type SharedStatePort, type TelemetryPort} from '@sprint/contracts';
import {newId} from '@sprint/domain';

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
  /** Optional media for people to look at; see `MediaSource`. */
  media?: MediaSource;
  /** Optional feature descriptions (hover text, and the agents' read_feature_info tool). */
  featureInfo?: FeatureInfoSource;
  /** Optional document reading for links in Ask AI (the helpers' read_doc tool). */
  documents?: DocumentSource;
  /** Where problem reports go (spec 1.1.0, 3). Without it the helpers say reports cannot be sent. */
  tickets?: TicketPort;
  /** The app's version, written into problem reports. */
  appVersion?: string;
  standIns: string[];
  telemetry?: TelemetryPort;
  /** Keeps a second tab from running the same optimiser; without it, only this instance is covered. */
  locks?: WorkLocks;
  /**
   * Short-lived state every instance of the module must see (the live turn, the helper that
   * answers, problem-report drafts), with TTL expiry. `@sprint/platform` has an in-memory stand-in.
   */
  sharedState: SharedStatePort;
  /**
   * Where background work goes (`@sprint/jobs`): scoring, reports, sampling, Optimiser runs and
   * project deletion are jobs; the workflow only enqueues and reads them back.
   */
  jobs: JobsContract;
  /**
   * Whether the pages' `tick` checks what should run (default true: the browser build). A server
   * deployment sets false and calls `sweep()` from a cron job instead, so a page never becomes a
   * second driver (review G8).
   */
  tickFromPages?: boolean;
}

/** Built after the workflow, since they call back into it (`connect`). */
export interface Connected {
  agents: AgentRuntimeContract;
  /** The Optimiser service (`@sprint/optimiser`). Without it Auto Optimise is not available. */
  optimiser?: OptimiserContract;
}

export interface Instance extends WorkflowDeps, Connected {
  locks: WorkLocks;
  tm: TelemetryPort;
  shared: SharedStatePort;
  /** Some record changed: the `changes` event. Events carry no data; listeners read again. */
  emitChange(): void;
  /** A running turn moved on: the `agent_live` event. */
  emitLive(): void;
  onChange(fn: () => void): () => void;
  onLive(fn: () => void): () => void;
  /** Stops this instance from starting the same step twice while the first is still being set up. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
  busy(key: string): boolean;
  /**
   * State that stays with this instance: running turns' progress handlers (until the agent service,
   * spec 6) and two caches of facts that can be worked out again.
   */
  local: {
    turnProgress: Map<string, AgentTurnProgress>;
    /** Reports that cannot be built from saved answers, as "versionId|endpoint|contextId" (R5-4). */
    cannotBuild: Set<string>;
    /** Saved answers on the whole eval set, by version, model and settings (R5-5). */
    fullAnswers: Map<string, Map<string, Prediction>>;
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
  const inst: Instance & {connect(c: Connected): void} = {
    ...deps,
    agents: notConnected,
    locks: deps.locks ?? memoryWorkLocks(),
    tm: deps.telemetry ?? NO_TELEMETRY,
    shared: deps.sharedState,
    emitChange: () => changeListeners.forEach(fn => fn()),
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
    local: {turnProgress: new Map(), cannotBuild: new Set(), fullAnswers: new Map()},
    // The scope reads the instance live (not a copy), so services connected later are seen.
    scope: ctx => Object.assign(Object.create(inst) as Scope, {ctx, user: async () => ctx.user}),
    connect(c) {
      inst.agents = c.agents;
      inst.optimiser = c.optimiser;
    },
  };
  return inst;
}

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

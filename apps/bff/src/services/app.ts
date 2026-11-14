import {NO_TELEMETRY, type TicketPort, type AgentRuntimeContract, type CatalogContract, type ExampleSource, type DocumentSource, type FeatureInfoSource, type FileStore, type MediaSource, type Identity, type LabelingContract, type LlmGatewayContract, type LockPort, type OptimiserContract, type TelemetryPort} from '@tsp/contracts';

/**
 * What the bff talks to. The bff holds no records of its own: product records live in the
 * catalog, labeling tasks and predictions in labeling, model calls go through the llm-gateway.
 * The composition root (`apps/web/src/backend-api`) builds these and calls `configureBff` once.
 */
/** One runner per piece of work across the tabs of this browser; see `LockPort`. */
export type WorkLocks = LockPort;

export interface BffDeps {
  catalog: CatalogContract;
  labeling: LabelingContract;
  gateway: LlmGatewayContract;
  agents: AgentRuntimeContract;
  /** The Optimiser service (`@tsp/optimiser`). Without it Auto Optimise is not available. */
  optimiser?: OptimiserContract;
  identity: Identity;
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
  /** Keeps a second tab from running the same optimiser; without it, only this tab is covered. */
  locks?: WorkLocks;
}

export interface App extends BffDeps {
  locks: WorkLocks;
  user: () => Promise<{id: string; name: string}>;
  tm: TelemetryPort;
}

let app: App | null = null;

export function configureBff(deps: BffDeps): void {
  let user: Promise<{id: string; name: string}> | null = null;
  app = {...deps, locks: deps.locks ?? memoryWorkLocks(), tm: deps.telemetry ?? NO_TELEMETRY, user: () => (user ??= deps.identity.currentUser())};
}

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

export function getApp(): App {
  if (!app) throw new Error('The bff is not configured: call configureBff() first.');
  return app;
}

export const now = () => new Date().toISOString();

/** Tiny event bus so pages refresh when a background run writes something. */
type Listener = () => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const emitChange = () => listeners.forEach(fn => fn());

/**
 * Stops this page from starting the same step twice while the first is still being set up
 * (for example tick firing again before a new task is saved). Other tabs are kept out by the
 * labeling app's lock per task, not by this.
 */
const starting = new Set<string>();
export async function once<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (starting.has(key)) return null;
  starting.add(key);
  try {
    return await fn();
  } finally {
    starting.delete(key);
  }
}
export const busy = (key: string) => starting.has(key);

/** Metrics and product events from bff code; a no-op until configureBff ran with a port. */
export const tm = (): TelemetryPort => app?.tm ?? NO_TELEMETRY;

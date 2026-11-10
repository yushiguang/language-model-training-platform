import {NO_TELEMETRY, type AgentRuntimeContract, type CatalogContract, type ExampleSource, type FileStore, type Identity, type LabelingContract, type LlmGatewayContract, type TelemetryPort} from '@tsp/contracts';

/**
 * What the bff talks to. The bff holds no records of its own: product records live in the
 * catalog, labeling tasks and predictions in labeling, model calls go through the llm-gateway.
 * The composition root (`apps/web/src/backend-api`) builds these and calls `configureBff` once.
 */
export interface BffDeps {
  catalog: CatalogContract;
  labeling: LabelingContract;
  gateway: LlmGatewayContract;
  agents: AgentRuntimeContract;
  identity: Identity;
  files: FileStore;
  examples: ExampleSource;
  standIns: string[];
  telemetry?: TelemetryPort;
}

export interface App extends BffDeps {
  user: () => Promise<{id: string; name: string}>;
  tm: TelemetryPort;
}

let app: App | null = null;

export function configureBff(deps: BffDeps): void {
  let user: Promise<{id: string; name: string}> | null = null;
  app = {...deps, tm: deps.telemetry ?? NO_TELEMETRY, user: () => (user ??= deps.identity.currentUser())};
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

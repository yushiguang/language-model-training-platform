import type {AgentLive, BffContract, ChatAttachment, GoldLine} from '@sprint/contracts';
import {configureSystem, systemConfig} from '@sprint/domain';
import {createCatalog} from '@sprint/catalog';
import {createTelemetry} from '@sprint/telemetry';
import {createGateway} from '@sprint/llm-gateway';
import {browserLocks, createLabeling} from '@sprint/labeling';
import {createAgentRuntime} from '@sprint/agents';
import {createPlatform} from '@sprint/platform-impl';
import {loopback, memorySharedState} from '@sprint/platform';
import {createOptimiser} from '@sprint/optimiser';
import {createWorkflow} from '@sprint/workflow';
import {createBffApi} from '@sprint/bff';
import type {BffClient} from './client';
import {webTelemetry} from './web-telemetry';
import {callFailed, callId, pageOpened, snapshot} from './diagnostics';

/**
 * Composition root. The only place that knows which implementation sits behind each contract:
 * `@sprint/platform-impl` is the stand-ins by default and the internal adapters when the build sets
 * SPRINT_PLATFORM_IMPL (see docs/handover/integration.md).
 */
const platform = createPlatform();
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';
/** The system's tunable numbers: the defaults with the platform's overrides on top. */
configureSystem(platform.config);
/** Metrics and product events go to the platform's sink; with none, they stay in memory. */
const telemetry = createTelemetry({
  sink: platform.telemetry ?? {pushMetrics: async () => {}, pushEvents: async () => {}},
  appVersion: APP_VERSION,
  env: process.env.NEXT_PUBLIC_SPRINT_ENV ?? 'dev',
});
const gateway = createGateway(platform, {telemetry});
const catalog = createCatalog(platform.db, {telemetry});
const labeling = createLabeling({db: platform.db, catalog, gateway, locks: browserLocks(), resolveUrl: absoluteUrl, onChange: () => workflow.changed(), telemetry});
/** The application module, with no state of its own; short-lived shared state goes to the platform's store. */
const workflow = createWorkflow({catalog, labeling, gateway, files: platform.files, examples: platform.examples, media: platform.media, featureInfo: platform.featureInfo, documents: platform.documents, tickets: platform.tickets, appVersion: APP_VERSION, standIns: platform.standIns, telemetry, locks: browserLocks(), sharedState: platform.sharedState ?? memorySharedState()});
/** The helpers, built once with their model, the project tools and where live progress goes. */
const agentRuntime = createAgentRuntime({llm: gateway.agentModel(), tools: projectId => workflow.agentTools(projectId), progress: workflow.agentProgress});
const optimiser = createOptimiser({catalog, labeling, agents: agentRuntime, host: workflow.optimiserHost, locks: browserLocks(), telemetry, onChange: () => workflow.changed()});
workflow.connect({agents: agentRuntime, optimiser});
/**
 * The bff calls the workflow through a loopback: every call's context, arguments, result and
 * error go through JSON as they would over RPC, so the browser check proves the workflow can be
 * moved behind RPC without the bff or the pages changing.
 */
const api = createBffApi({workflow: loopback(workflow.api), identity: platform.identity, appVersion: APP_VERSION, timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone});
const events = workflow.events;
const web = webTelemetry(telemetry);
void platform.identity.currentUser().then(u => telemetry.setContext({userId: u.id}));

/**
 * Every bff call is counted and timed (`sprint_bff_calls_total`, `sprint_bff_call_duration_seconds`);
 * a failed call also counts as a backend error on the page, and goes into the browser's record
 * for problem reports with its call id (an HTTP client sends that id as `X-Request-Id`).
 */
function timed<A extends unknown[], R>(method: string, fn: (...a: A) => R): (...a: A) => R {
  telemetry.allowLabelValues('method', [method]);
  return (...a: A): R => {
    const started = Date.now();
    const id = callId();
    const end = (outcome: 'ok' | 'error', error?: unknown) => {
      if (outcome === 'error') callFailed(method, id, error);
      const seconds = (Date.now() - started) / 1000;
      telemetry.counter('sprint_bff_calls_total', {method, outcome});
      telemetry.histogram('sprint_bff_call_duration_seconds', seconds, {method});
      if (method === 'loadProjectState') telemetry.histogram('sprint_bff_project_state_load_seconds', seconds);
      if (outcome === 'error') web.backendError();
    };
    try {
      const r = fn(...a);
      if (r instanceof Promise) {
        r.then(() => end('ok'), e => end('error', e));
      } else end('ok');
      return r;
    } catch (e) {
      end('error', e);
      throw e;
    }
  };
}

/** Image URLs in prompts are relative to the site; the model needs absolute ones. */
function absoluteUrl(url: string): string {
  if (/^(https?:|data:)/.test(url) || typeof location === 'undefined') return url;
  return new URL(url, location.origin + (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + '/').toString();
}

/** Every contract method, counted and timed. */
const timedApi = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, timed(name, fn as (...a: unknown[]) => unknown)])) as unknown as BffContract;

/**
 * Subscribes to backend state invalidations.
 * In-browser mode listens to the local event bus; an HTTP client implementation can back this
 * with polling or Server-Sent Events.
 */
function subscribeChanges(listener: () => void): () => void {
  const off = events.subscribe('changes', listener);
  localChanges.add(listener);
  const fromOtherTab = () => {
    web.crossTab();
    listener();
  };
  tabs?.addEventListener('message', fromOtherTab);
  return () => {
    off();
    localChanges.delete(listener);
    tabs?.removeEventListener('message', fromOtherTab);
  };
}

/**
 * Other tabs of the same site hear about writes too, so a second tab shows a run's progress.
 * (Stand-in for the store's own change feed; the real storage runtime can use `subscribe`.)
 */
const tabs = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sprint-changes') : null;
let tabNotice: ReturnType<typeof setTimeout> | null = null;
events.subscribe('changes', () => {
  if (!tabs || tabNotice) return;
  tabNotice = setTimeout(() => {
    tabNotice = null;
    tabs.postMessage('changed');
  }, 200);
});

/** Pages that listen for changes this client makes itself (a turn it sent ended). */
const localChanges = new Set<() => void>();

/**
 * Ask AI's live line, read synchronously by the page: the turn running now, per project, as last
 * read through the contract. `agent_live` carries no data, so on each one the projects a page
 * looks at are read again (`getAgentLive`); an older read never overwrites a newer one.
 */
const live = new Map<string, AgentLive | null>();
const liveListeners = new Set<() => void>();
const liveReads = new Map<string, number>();
function readLive(projectId: string) {
  const n = (liveReads.get(projectId) ?? 0) + 1;
  liveReads.set(projectId, n);
  void timedApi.getAgentLive(projectId).then(
    l => {
      if (liveReads.get(projectId) !== n) return;
      live.set(projectId, l);
      liveListeners.forEach(fn => fn());
    },
    () => undefined,
  );
}
events.subscribe('agent_live', () => [...live.keys()].forEach(readLive));
function agentLive(projectId: string): AgentLive | null {
  if (!live.has(projectId)) {
    live.set(projectId, null);
    readLive(projectId);
  }
  return live.get(projectId) ?? null;
}

/** Turns this client has asked for that have not answered yet, per project: Ask AI is busy meanwhile. */
const asking = new Map<string, number>();
async function asked<T>(projectId: string, call: () => Promise<T>): Promise<T> {
  asking.set(projectId, (asking.get(projectId) ?? 0) + 1);
  try {
    return await call();
  } finally {
    asking.set(projectId, (asking.get(projectId) ?? 1) - 1);
    localChanges.forEach(fn => fn());
  }
}
const isAgentBusy = (projectId: string) => (asking.get(projectId) ?? 0) > 0 || !!agentLive(projectId);

async function uploadAsset(file: File): Promise<{url: string}> {
  telemetry.histogram('sprint_files_upload_bytes', file.size, {kind: file.type.startsWith('image/') ? 'image' : 'other'});
  return platform.files.upload(file, file.name);
}

/**
 * The in-process client: every service runs in this page, on `@sprint/platform-impl` (the stand-ins
 * by default). The whole product can be accepted in a local browser this way.
 */
export const inProcessClient: BffClient = {
  ...timedApi,
  // Each Ask AI message carries the browser's record, for a problem report (spec 1.1.0, 3.2).
  sendUserMessage: req => asked(req.projectId, () => timedApi.sendUserMessage({...req, client: req.client ?? snapshot()})),
  improveWithAi: (projectId, versionId, locale) => asked(projectId, () => timedApi.improveWithAi(projectId, versionId, locale)),
  subscribeChanges,
  subscribeAgentLive(listener) {
    liveListeners.add(listener);
    return () => void liveListeners.delete(listener);
  },
  agentLive,
  isAgentBusy,
  uploadAsset,
  async prepareChatAttachment(file): Promise<ChatAttachment> {
    if (file.type.startsWith('image/')) {
      const {url} = await uploadAsset(file);
      return {name: file.name, size: file.size, url};
    }
    const text = await file.text();
    return {name: file.name, size: file.size, content: text.slice(0, systemConfig().agent.maxAttachmentChars)};
  },
  async uploadDatasetFile(projectId, file) {
    return timedApi.uploadDatasetText(projectId, file.name, await file.text());
  },
  async appendDatasetFile(projectId, file) {
    return timedApi.appendUpload(projectId, file.name, await file.text());
  },
  async uploadGoldFile(projectId, file) {
    const lines = (await file.text())
      .split(/\r?\n/)
      .filter(l => l.trim())
      .map(l => {
        try {
          return JSON.parse(l) as GoldLine;
        } catch {
          return null;
        }
      })
      .filter((x): x is GoldLine => x !== null);
    return timedApi.uploadGold({projectId, lines});
  },
  pageViewed(pathname, search) {
    pageOpened(pathname + search);
    web.pageViewed(pathname, search);
  },
  track: web.track,
};

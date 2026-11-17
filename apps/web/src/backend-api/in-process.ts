import type {BffContract, ChatAttachment, GoldLine} from '@tsp/contracts';
import {configureSystem, systemConfig} from '@tsp/domain';
import {createCatalog} from '@tsp/catalog';
import {createTelemetry} from '@tsp/telemetry';
import {createGateway} from '@tsp/llm-gateway';
import {browserLocks, createLabeling} from '@tsp/labeling';
import {createAgentRuntime} from '@tsp/agents';
import {createPlatform} from '@tsp/platform-impl';
import {createOptimiser} from '@tsp/optimiser';
import {agentLive, agentProgress, agentTools, answeringAgent, bffEvents, configureBff, createBffApi, emitChange, isAgentBusy, onChange, optimiserHost} from '@tsp/bff';
import type {BffClient} from './client';
import {webTelemetry} from './web-telemetry';
import {callFailed, callId, pageOpened, snapshot} from './diagnostics';

/**
 * Composition root. The only place that knows which implementation sits behind each contract:
 * `@tsp/platform-impl` is the stand-ins by default and the internal adapters when the build sets
 * TSP_PLATFORM_IMPL (see docs/handover/integration.md).
 */
const platform = createPlatform();
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';
/** The system's tunable numbers: the defaults with the platform's overrides on top. */
configureSystem(platform.config);
/** Metrics and product events go to the platform's sink; with none, they stay in memory. */
const telemetry = createTelemetry({
  sink: platform.telemetry ?? {pushMetrics: async () => {}, pushEvents: async () => {}},
  appVersion: APP_VERSION,
  env: process.env.NEXT_PUBLIC_TSP_ENV ?? 'dev',
});
const gateway = createGateway(platform, {telemetry});
const catalog = createCatalog(platform.db, {telemetry});
const labeling = createLabeling({db: platform.db, catalog, gateway, locks: browserLocks(), resolveUrl: absoluteUrl, onChange: emitChange, telemetry});
/** The helpers, built once with their model, the project tools and where live progress goes. */
const agentRuntime = createAgentRuntime({llm: gateway.agentModel(), tools: agentTools, progress: agentProgress});
const optimiser = createOptimiser({catalog, labeling, agents: agentRuntime, host: optimiserHost(), locks: browserLocks(), telemetry, onChange: emitChange});
configureBff({catalog, labeling, gateway, agents: agentRuntime, optimiser, identity: platform.identity, files: platform.files, examples: platform.examples, media: platform.media, featureInfo: platform.featureInfo, documents: platform.documents, tickets: platform.tickets, appVersion: APP_VERSION, standIns: platform.standIns, telemetry, locks: browserLocks()});
const web = webTelemetry(telemetry);
void platform.identity.currentUser().then(u => telemetry.setContext({userId: u.id}));

/**
 * Every bff call is counted and timed (`tsp_bff_calls_total`, `tsp_bff_call_duration_seconds`);
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
      telemetry.counter('tsp_bff_calls_total', {method, outcome});
      telemetry.histogram('tsp_bff_call_duration_seconds', seconds, {method});
      if (method === 'loadProjectState') telemetry.histogram('tsp_bff_project_state_load_seconds', seconds);
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

const api = createBffApi();
const events = bffEvents();

/** Every contract method, counted and timed. */
const timedApi = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, timed(name, fn as (...a: unknown[]) => unknown)])) as unknown as BffContract;

/**
 * Subscribes to backend state invalidations.
 * In-browser mode listens to the local event bus; an HTTP client implementation can back this
 * with polling or Server-Sent Events.
 */
function subscribeChanges(listener: () => void): () => void {
  const off = onChange(listener);
  const fromOtherTab = () => {
    web.crossTab();
    listener();
  };
  tabs?.addEventListener('message', fromOtherTab);
  return () => {
    off();
    tabs?.removeEventListener('message', fromOtherTab);
  };
}

/**
 * Other tabs of the same site hear about writes too, so a second tab shows a run's progress.
 * (Stand-in for the store's own change feed; the real storage runtime can use `subscribe`.)
 */
const tabs = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tsp-changes') : null;
let tabNotice: ReturnType<typeof setTimeout> | null = null;
onChange(() => {
  if (!tabs || tabNotice) return;
  tabNotice = setTimeout(() => {
    tabNotice = null;
    tabs.postMessage('changed');
  }, 200);
});

async function uploadAsset(file: File): Promise<{url: string}> {
  telemetry.histogram('tsp_files_upload_bytes', file.size, {kind: file.type.startsWith('image/') ? 'image' : 'other'});
  return platform.files.upload(file, file.name);
}

/**
 * The in-process client: every service runs in this page, on `@tsp/platform-impl` (the stand-ins
 * by default). The whole product can be accepted in a local browser this way.
 */
export const inProcessClient: BffClient = {
  ...timedApi,
  // Each Ask AI message carries the browser's record, for a problem report (spec 1.1.0, 3.2).
  sendUserMessage: req => timedApi.sendUserMessage({...req, client: req.client ?? snapshot()}),
  subscribeChanges,
  subscribeAgentLive: listener => events.subscribe('agent_live', listener),
  agentLive,
  isAgentBusy,
  answeringAgent,
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

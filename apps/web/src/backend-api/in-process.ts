import type {AgentLive, BffContract, ChatAttachment, GoldLine} from '@yushiguang/sprint-contracts';
import {configureSystem, systemConfig} from '@yushiguang/sprint-domain';
import {createCatalog, docFeatureStore, objectFeatureStore} from '@yushiguang/sprint-catalog';
import {createTelemetry} from '@yushiguang/sprint-telemetry';
import {createGateway} from '@yushiguang/sprint-llm-gateway';
import {browserLocks, createLabeling, labelingExecutor, objectLabelingStore} from '@yushiguang/sprint-labeling';
import {createAgentRuntime} from '@yushiguang/sprint-agents';
import {createPlatform} from '@yushiguang/sprint-platform-impl';
import {leaseLocks, loopback, memoryJobStore, memoryLimiterStore, memorySharedState} from '@yushiguang/sprint-platform';
import {createJobs} from '@yushiguang/sprint-jobs';
import {createConfig} from '@yushiguang/sprint-config';
import {createOptimiser, optimiserExecutor} from '@yushiguang/sprint-optimiser';
import {createWorkflow, systemContext} from '@yushiguang/sprint-workflow';
import {createBffApi} from '@yushiguang/sprint-bff';
import type {BffClient} from './client';
import {webTelemetry} from './web-telemetry';
import {currentTenant} from './tenant';
import {callFailed, callId, pageOpened, snapshot} from './diagnostics';

/**
 * Composition root. The only place that knows which implementation sits behind each contract:
 * `@yushiguang/sprint-platform-impl` is the stand-ins by default and a deployment's adapters when the build sets
 * SPRINT_PLATFORM_IMPL (see docs/integration.md).
 */
const platform = createPlatform();
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';
/** The system's tunable numbers: the defaults with the platform's overrides on top. */
configureSystem(platform.config);
/**
 * The configuration platform's values go over those (docs/design/server.md, 7), refreshed every
 * 30 s; until the first read lands, the values above are in force. Tenants read their job limits
 * through `config.reader`.
 */
const config = platform.configStore ? createConfig({port: platform.configStore, base: platform.config}) : null;
void config?.start();
/** Metrics and product events go to the platform's sink; with none, they stay in memory. */
const telemetry = createTelemetry({
  sink: platform.telemetry ?? {pushMetrics: async () => {}, pushEvents: async () => {}},
  appVersion: APP_VERSION,
  env: process.env.NEXT_PUBLIC_SPRINT_ENV ?? 'dev',
});
/**
 * Frozen features (docs/design/server.md 6): packed in segment files in the platform's object
 * storage when it has one (examples saved before stay readable from `db`). Without it the catalog
 * and the workflow keep one document per example, each written and skipped on its own, as before.
 */
const features = platform.objectStore ? objectFeatureStore(platform.objectStore, docFeatureStore(platform.db)) : undefined;
const catalog = createCatalog(platform.db, {telemetry, features});
/**
 * One process: the limits are counted here unless the platform shares a store (spec 5). Each
 * tenant's own models come from the catalog (docs/design/server.md, 9), read per tenant and kept
 * briefly, so a model added in tenant settings is callable without a restart.
 */
const gateway = createGateway(platform, {telemetry, limiterStore: platform.limiterStore ?? memoryLimiterStore(), tenantModels: {list: tenantId => catalog.find('tenant_models', {tenantId})}});
/**
 * Background work (scoring, reports, sampling, Optimiser runs, deleting a project) runs as jobs.
 * In the browser this page is the runner: jobs start as soon as they are queued, kept in the
 * platform's job store (by default this tab's memory, so a closed page drops its queue and the
 * pages' tick picks the work up again, as before). Built before labeling, whose orphan check
 * below reads the queue.
 */
const jobs = createJobs({store: platform.jobStore ?? memoryJobStore(), telemetry, config: config?.reader});
/**
 * One locks object for labeling, the workflow and the Optimiser in this process (issue #46):
 * over the platform's shared lock store when it supplies one (a server composition), so a lock
 * taken in one unit is seen in every other; in the browser, Web Locks as before. The same object
 * goes to all three, so their `isHeld` checks agree with each other's runs.
 */
const locks = platform.lockStore ? leaseLocks(platform.lockStore) : browserLocks();
const labeling = createLabeling({
  db: platform.db,
  /**
   * With object storage, answers go into segment files of up to 50, each saved within 10 s of
   * its first answer (docs/design/server.md 6); without it, each answer is a document, saved at once.
   */
  ...(platform.objectStore ? {store: objectLabelingStore(platform.db, platform.objectStore), answerBatch: {size: 50, maxWaitMs: 10_000}} : {}),
  catalog,
  gateway,
  locks,
  resolveUrl: absoluteUrl,
  onChange: projectId => workflow.changed(projectId),
  telemetry,
  /**
   * A running task whose lock this process cannot see may still be live as queued or running
   * job work (in another unit, whose runner holds the job's lease): such a task is never read
   * as abandoned. An Optimiser run's labeling is a `labeling.runTask` job of its own too (#79).
   */
  liveElsewhere: async task => {
    const live = await jobs.api.list(systemContext('labeling'), {projectId: task.projectId, kinds: ['labeling.runTask'], states: ['queued', 'running']});
    return live.some(j => j.args.taskId === task.id);
  },
});
/** The application module, with no state of its own; short-lived shared state goes to the platform's store. */
const workflow = createWorkflow({jobs: jobs.api, catalog, features, labeling, gateway, files: platform.files, examples: platform.examples, media: platform.media, featureInfo: platform.featureInfo, documents: platform.documents, tickets: platform.tickets, notifications: platform.notifications, appVersion: APP_VERSION, standIns: platform.standIns, telemetry, locks, sharedState: platform.sharedState ?? memorySharedState(), config: config?.reader, authorization: platform.authorization, permissionAdmin: platform.permissionAdmin, accessRequests: platform.accessRequests});
/** The helpers, built once with their model, the project tools and where live progress goes. */
const agentRuntime = createAgentRuntime({llm: gateway.agentModel(), tools: workflow.toolHost, progress: workflow.agentProgress});
const optimiser = createOptimiser({catalog, labeling, agents: agentRuntime, host: workflow.optimiserHost, locks, telemetry, onChange: projectId => workflow.changed(projectId)});
workflow.connect({agents: agentRuntime, optimiser});
// Executors tell open pages when their records change, as before; a job's own life does not, so a
// job that changes nothing never makes the pages read again (and tick again).
for (const e of [labelingExecutor(labeling), optimiserExecutor(optimiser), ...workflow.executors]) jobs.register(e);
/**
 * The bff calls the workflow through a loopback: every call's context, arguments, result and
 * error go through JSON as they would over RPC, so the browser check proves the workflow can be
 * moved behind RPC without the bff or the pages changing.
 */
// Each call works in the page's tenant (#94).
const api = createBffApi({workflow: loopback(workflow.api), identity: platform.identity, appVersion: APP_VERSION, timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone, tenant: currentTenant});
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
/**
 * Resolves when no turn is live on the project. `sendUserMessage` returns once the turn started;
 * Ask AI stays busy until the turn ended, as it did when the call waited for the answer.
 */
async function turnEnded(projectId: string): Promise<void> {
  while (await timedApi.getAgentLive(projectId)) {
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(t);
        liveListeners.delete(done);
        resolve();
      };
      const t = setTimeout(done, 1000);
      liveListeners.add(done);
    });
  }
}
const isAgentBusy = (projectId: string) => (asking.get(projectId) ?? 0) > 0 || !!agentLive(projectId);

async function uploadAsset(file: File): Promise<{url: string}> {
  telemetry.histogram('sprint_files_upload_bytes', file.size, {kind: file.type.startsWith('image/') ? 'image' : 'other'});
  return platform.files.upload(file, file.name);
}

/**
 * The in-process client: every service runs in this page, on `@yushiguang/sprint-platform-impl` (the stand-ins
 * by default). The whole product can be accepted in a local browser this way. It is the default
 * module behind `@yushiguang/sprint-client-impl`; any other client module exports `client` the same way.
 */
export const client: BffClient = {
  ...timedApi,
  // Each Ask AI message carries the browser's record, for a problem report (spec 1.1.0, 3.2).
  sendUserMessage: req =>
    asked(req.projectId, async () => {
      const out = await timedApi.sendUserMessage({...req, client: req.client ?? snapshot()});
      await turnEnded(req.projectId);
      return out;
    }),
  // A Prompt helper turn (#39): Ask AI stays busy until it ended, as for a message.
  improveWithAi: (projectId, versionId, locale) =>
    asked(projectId, async () => {
      const out = await timedApi.improveWithAi(projectId, versionId, locale);
      await turnEnded(projectId);
      return out;
    }),
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
  async createDataSourceFile(name, file) {
    return timedApi.createDataSource({name, fileName: file.name, text: await file.text()});
  },
  async addSourceFileFile(sourceId, file) {
    return timedApi.addSourceFile({sourceId, fileName: file.name, text: await file.text()});
  },
  async uploadGoldFile(projectId, file) {
    return timedApi.uploadGoldText(projectId, file.name, await file.text());
  },
  pageViewed(pathname, search) {
    pageOpened(pathname + search);
    web.pageViewed(pathname, search);
  },
  track: web.track,
};

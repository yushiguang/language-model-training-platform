import type {
  AgentLive,
  AgentProposal,
  Answer,
  ChatAttachment,
  ChatMessage,
  DatasetSnapshot,
  EndpointId,
  EndpointInfo,
  EvalReport,
  Example,
  GoldLabel,
  ModelSettings,
  NewVersion,
  NodeId,
  PageContext,
  Prediction,
  Project,
  ProjectState,
  PromptVersion,
  RuntimeInfo,
  Schema,
  SetupPatch,
  SetupVersion,
  TrainingRow,
  TrainingSet,
} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {createTelemetry} from '@tsp/telemetry';
import {webTelemetry} from './web-telemetry';
import {createGateway} from '@tsp/llm-gateway';
import {browserLocks, createLabeling} from '@tsp/labeling';
import {agentRuntime} from '@tsp/agents';
import {createPlatform} from '@tsp/platform-impl';
import * as bff from '@tsp/bff';
import {configureBff, emitChange, hasBundledGold, onChange} from '@tsp/bff';

export type {NewVersion, PageContext, ProjectState, RuntimeInfo, SetupPatch};

/**
 * Composition root. The only place that knows which implementation sits behind each contract:
 * `@tsp/platform-impl` is the stand-ins by default and the internal adapters when the build sets
 * TSP_PLATFORM_IMPL (see docs/handover/integration.md).
 */
const platform = createPlatform();
/** Metrics and product events go to the platform's sink; with none, they stay in memory. */
const telemetry = createTelemetry({
  sink: platform.telemetry ?? {pushMetrics: async () => {}, pushEvents: async () => {}},
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
  env: process.env.NEXT_PUBLIC_TSP_ENV ?? 'dev',
});
const gateway = createGateway(platform, {telemetry});
const catalog = createCatalog(platform.db, {telemetry});
const labeling = createLabeling({db: platform.db, catalog, gateway, locks: browserLocks(), resolveUrl: absoluteUrl, onChange: emitChange, telemetry});
configureBff({catalog, labeling, gateway, agents: agentRuntime, identity: platform.identity, files: platform.files, examples: platform.examples, media: platform.media, featureInfo: platform.featureInfo, documents: platform.documents, standIns: platform.standIns, telemetry, locks: browserLocks()});
const web = webTelemetry(telemetry);
void platform.identity.currentUser().then(u => telemetry.setContext({userId: u.id}));

/** Pages report route changes and product events through these. */
export const pageViewed = web.pageViewed;
export const track = web.track;

/**
 * Every bff call is counted and timed (`tsp_bff_calls_total`, `tsp_bff_call_duration_seconds`);
 * a failed call also counts as a backend error on the page.
 */
function timed<A extends unknown[], R>(method: string, fn: (...a: A) => R): (...a: A) => R {
  telemetry.allowLabelValues('method', [method]);
  return (...a: A): R => {
    const started = Date.now();
    const end = (outcome: 'ok' | 'error') => {
      const seconds = (Date.now() - started) / 1000;
      telemetry.counter('tsp_bff_calls_total', {method, outcome});
      telemetry.histogram('tsp_bff_call_duration_seconds', seconds, {method});
      if (method === 'loadProjectState') telemetry.histogram('tsp_bff_project_state_load_seconds', seconds);
      if (outcome === 'error') web.backendError();
    };
    try {
      const r = fn(...a);
      if (r instanceof Promise) {
        r.then(() => end('ok'), () => end('error'));
      } else end('ok');
      return r;
    } catch (e) {
      end('error');
      throw e;
    }
  };
}

/** Image URLs in prompts are relative to the site; the model needs absolute ones. */
function absoluteUrl(url: string): string {
  if (/^(https?:|data:)/.test(url) || typeof location === 'undefined') return url;
  return new URL(url, location.origin + (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + '/').toString();
}

/**
 * The HTTP-friendly contract client between the frontend UI (`apps/web`) and the BFF (`apps/bff`).
 *
 * In the MVP, these methods invoke the `@tsp/bff` service in-process.
 * When the BFF moves to a remote Go microservice, replace the bodies below with `fetch()`
 * calls (and polling/SSE for `subscribeChanges`) without modifying any page component.
 */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const u = await platform.identity.currentUser();
  return {
    user: u,
    standIns: platform.standIns,
    endpoints: gateway.labelingEndpoints(),
    hasBundledGold: hasBundledGold(),
  };
}

/**
 * Subscribes to backend state invalidations.
 * In-browser mode listens to the local event bus; an HTTP client implementation can back this
 * with polling or Server-Sent Events.
 */
export function subscribeChanges(listener: () => void): () => void {
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

/**
 * Client-side file boundary for uploading prompt images or assets.
 * In HTTP mode, this sends `multipart/form-data` or uploads directly to object storage.
 */
export async function uploadAsset(file: File): Promise<{url: string}> {
  telemetry.histogram('tsp_files_upload_bytes', file.size, {kind: file.type.startsWith('image/') ? 'image' : 'other'});
  return platform.files.upload(file, file.name);
}

/**
 * Client-side file boundary for chat attachments.
 * Images are uploaded to the file store; text/CSV/JSONL/Markdown files have their content
 * excerpted into a JSON-serialisable `ChatAttachment` record for the agent context.
 */
export async function prepareChatAttachment(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith('image/')) {
    const {url} = await uploadAsset(file);
    return {name: file.name, size: file.size, url};
  }
  const text = await file.text();
  return {
    name: file.name,
    size: file.size,
    content: text.slice(0, 8000),
  };
}

/**
 * Client-side file boundary for dataset uploads. Reads text on the client in in-browser mode,
 * or sends `multipart/form-data` to `/projects/:id/dataset/upload` in HTTP mode.
 */
export async function uploadDatasetFile(projectId: string, file: File): Promise<{snapshot?: DatasetSnapshot; error?: string}> {
  const text = await file.text();
  return uploadDatasetText(projectId, file.name, text);
}

/**
 * Client-side file boundary for gold-label JSONL uploads.
 */
export async function uploadGoldFile(
  projectId: string,
  schema: Schema,
  schemaVersion: number,
  examples: Example[],
  file: File,
): Promise<{saved: number; skipped: number}> {
  const text = await file.text();
  const lines = text
    .split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => {
      try {
        return JSON.parse(l) as {externalId: string; answer: Record<string, string[]>};
      } catch {
        return null;
      }
    })
    .filter((x): x is {externalId: string; answer: Record<string, string[]>} => x !== null);
  return uploadGold(projectId, schema, schemaVersion, examples, lines);
}

export const listProjects = timed('listProjects', bff.listProjects);
export const createProject = timed('createProject', bff.createProject);
export const getProject = timed('getProject', bff.getProject);
export const loadProjectState = timed('loadProjectState', bff.loadProjectState);
export const approveNode = timed('approveNode', bff.approveNode);
export const skipGold = timed('skipGold', bff.skipGold);
export const saveSetup = timed('saveSetup', bff.saveSetup);
export const getSamplePoolSize = timed('getSamplePoolSize', bff.getSamplePoolSize);
export const exampleMedia = timed('exampleMedia', bff.exampleMedia);
export const startSampleDataset = timed('startSampleDataset', bff.startSampleDataset);
export const stopSampleDataset = timed('stopSampleDataset', bff.stopSampleDataset);
export const applySplit = timed('applySplit', bff.applySplit);
export const saveGold = timed('saveGold', bff.saveGold);
export const importBundledGold = timed('importBundledGold', bff.importBundledGold);
export const createVersion = timed('createVersion', bff.createVersion);
export const scoreVersion = timed('scoreVersion', bff.scoreVersion);
export const tick = timed('tick', bff.tick);
export const stopRun = timed('stopRun', bff.stopRun);
export const startOptimiser = timed('startOptimiser', bff.startOptimiser);
export const stopOptimiser = timed('stopOptimiser', bff.stopOptimiser);
export const retryOptimiser = timed('retryOptimiser', bff.retryOptimiser);
export const improveWithAi = timed('improveWithAi', bff.improveWithAi);
export const featureInfo = timed('featureInfo', bff.featureInfo);
export const predictionsFor = timed('predictionsFor', bff.predictionsFor);
export const labelTestSet = timed('labelTestSet', bff.labelTestSet);
export const startTrainingSet = timed('startTrainingSet', bff.startTrainingSet);
export const stopTrainingSet = timed('stopTrainingSet', bff.stopTrainingSet);
export const trainingRows = timed('trainingRows', bff.trainingRows);
export const chatHistory = timed('chatHistory', bff.chatHistory);
export const sendUserMessage = timed('sendUserMessage', bff.sendUserMessage);
export const openProposals = timed('openProposals', bff.openProposals);
export const proposals = timed('proposals', bff.proposals);
export const closeProposal = timed('closeProposal', bff.closeProposal);
const uploadDatasetText = timed('uploadDatasetText', bff.uploadDatasetText);
export const uploadGold = timed('uploadGold', bff.uploadGold);
export const isAgentBusy = bff.isAgentBusy;
export const agentLive = bff.agentLive;
export const subscribeAgentLive = bff.subscribeAgentLive;
export const answeringAgent = bff.answeringAgent;

export type {
  AgentLive,
  AgentProposal,
  Answer,
  ChatAttachment,
  ChatMessage,
  DatasetSnapshot,
  EndpointId,
  EndpointInfo,
  EvalReport,
  Example,
  GoldLabel,
  ModelSettings,
  NodeId,
  Prediction,
  Project,
  PromptVersion,
  Schema,
  SetupVersion,
  TrainingRow,
  TrainingSet,
};

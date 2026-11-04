import type {
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
import {createGateway} from '@tsp/llm-gateway';
import {browserLocks, createLabeling} from '@tsp/labeling';
import {agentRuntime} from '@tsp/agents';
import {createPlatform} from '@tsp/platform-impl';
import {
  applySplit,
  approveNode,
  chatHistory,
  closeProposal,
  configureBff,
  createProject,
  createVersion,
  emitChange,
  getProject,
  getSamplePoolSize,
  hasBundledGold,
  importBundledGold,
  isAgentBusy,
  labelTestSet,
  listProjects,
  loadProjectState,
  onChange,
  openProposals,
  predictionsFor,
  saveGold,
  saveSetup,
  scoreVersion,
  sendUserMessage,
  skipGold,
  startOptimiser,
  startSampleDataset,
  startTrainingSet,
  stopOptimiser,
  stopRun,
  stopSampleDataset,
  stopTrainingSet,
  tick,
  trainingRows,
  uploadDatasetText,
  uploadGold,
} from '@tsp/bff';

export type {NewVersion, PageContext, ProjectState, RuntimeInfo, SetupPatch};

/**
 * Composition root. The only place that knows which implementation sits behind each contract:
 * `@tsp/platform-impl` is the stand-ins by default and the internal adapters when the build sets
 * TSP_PLATFORM_IMPL (see docs/handover/integration.md).
 */
const platform = createPlatform();
const gateway = createGateway(platform);
const catalog = createCatalog(platform.db);
const labeling = createLabeling({db: platform.db, catalog, gateway, locks: browserLocks(), resolveUrl: absoluteUrl, onChange: emitChange});
configureBff({catalog, labeling, gateway, agents: agentRuntime, identity: platform.identity, files: platform.files, examples: platform.examples, standIns: platform.standIns});

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
  const fromOtherTab = () => listener();
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

export {
  listProjects,
  createProject,
  getProject,
  loadProjectState,
  approveNode,
  skipGold,
  saveSetup,
  getSamplePoolSize,
  startSampleDataset,
  stopSampleDataset,
  applySplit,
  saveGold,
  uploadGold,
  importBundledGold,
  createVersion,
  scoreVersion,
  tick,
  stopRun,
  startOptimiser,
  stopOptimiser,
  predictionsFor,
  labelTestSet,
  startTrainingSet,
  stopTrainingSet,
  trainingRows,
  chatHistory,
  isAgentBusy,
  sendUserMessage,
  openProposals,
  closeProposal,
};

export type {
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

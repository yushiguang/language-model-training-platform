import type {AgentLive, AgentPreset, BffContract, ChatAttachment, DatasetUploadResult, EventName, EventProps, GoldUploadResult, PageContext} from '@tsp/contracts';

/**
 * What the pages call (spec 1.0.0, section 7.3): the bff's contract, plus the few things that only
 * exist on the client side of the wire.
 *
 * - Live updates. Listeners and the current turn are read synchronously by the pages; a client
 *   keeps them up to date from its event stream (in-process: the services' own bus; HTTP:
 *   Server-Sent Events or polling, with `getAgentLive` and `getAnsweringAgent` to fill the cache).
 * - Files. A browser `File` never crosses the contract: the client reads or uploads it and sends
 *   plain JSON.
 * - Page telemetry.
 *
 * `in-process.ts` is the default client (every service runs in the page). A microservice
 * deployment adds an HTTP client with this same interface and exports it from `index.ts`; no page
 * changes, and no backend app is bundled into the browser.
 */
export interface BffClient extends BffContract {
  /** Some record changed (also in another tab): read again. */
  subscribeChanges(listener: () => void): () => void;
  /** The running turn moved on (a new line, more of the reply). */
  subscribeAgentLive(listener: () => void): () => void;
  /** The turn running now as last heard from the stream, if any. */
  agentLive(projectId: string): AgentLive | null;
  isAgentBusy(projectId: string): boolean;
  /** Which helper answers the next message on this page, as last heard. */
  answeringAgent(projectId: string, page: PageContext): AgentPreset;

  /** Uploads a prompt image or another asset and returns where it is served from. */
  uploadAsset(file: File): Promise<{url: string}>;
  /** An image is uploaded; a text file's start is read into the attachment. */
  prepareChatAttachment(file: File): Promise<ChatAttachment>;
  uploadDatasetFile(projectId: string, file: File): Promise<DatasetUploadResult>;
  /** JSONL lines of {externalId, answer}; lines that are not JSON are skipped. */
  uploadGoldFile(projectId: string, file: File): Promise<GoldUploadResult>;

  /** Pages report route changes and product events through these. */
  pageViewed(pathname: string, search: string): void;
  track<E extends EventName>(name: E, props: EventProps[E]): void;
}

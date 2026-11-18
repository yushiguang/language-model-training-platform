import type {AgentLive, BffContract, ChatAttachment, EventName, EventProps, GoldUploadResult, SourceUploadResult} from '@yushiguang/sprint-contracts';

/**
 * What the pages call (spec 1.0.0, section 7.3): the bff's contract, plus the few things that only
 * exist on the client side of the wire.
 *
 * - Live updates. Listeners and the current turn are read synchronously by the pages; a client
 *   keeps them up to date from its event stream (in-process: the services' own bus; HTTP:
 *   Server-Sent Events or polling, with `getAgentLive` to fill the cache).
 * - Files. A browser `File` never crosses the contract: the client reads or uploads it and sends
 *   plain JSON.
 * - Page telemetry.
 *
 * `in-process.ts` is the default client (every service runs in the page). A server deployment
 * builds with SPRINT_CLIENT_IMPL naming its own module (an HTTP client) that exports `client` with
 * this same interface; `index.ts` takes it through `@yushiguang/sprint-client-impl`. No page changes, and no
 * backend app is bundled into the browser.
 */
export interface BffClient extends BffContract {
  /** Some record changed (also in another tab): read again. */
  subscribeChanges(listener: () => void): () => void;
  /** The running turn moved on (a new line, more of the reply). */
  subscribeAgentLive(listener: () => void): () => void;
  /** The turn running now as last heard from the stream, if any. */
  agentLive(projectId: string): AgentLive | null;
  /** A turn is running, or one this client asked for has not answered yet. */
  isAgentBusy(projectId: string): boolean;

  /** Uploads a prompt image or another asset and returns where it is served from. */
  uploadAsset(file: File): Promise<{url: string}>;
  /** An image is uploaded; a text file's start is read into the attachment. */
  prepareChatAttachment(file: File): Promise<ChatAttachment>;
  /** Creates a data source of the caller's tenant from a file of item ids (#29). */
  createDataSourceFile(name: string, file: File): Promise<SourceUploadResult>;
  /** Adds a file of item ids to a data source. */
  addSourceFileFile(sourceId: string, file: File): Promise<SourceUploadResult>;
  /** Upload labels: a CSV or JSONL file of item ids and answers (`uploadGoldText`). */
  uploadGoldFile(projectId: string, file: File): Promise<GoldUploadResult>;

  /** Pages report route changes and product events through these. */
  pageViewed(pathname: string, search: string): void;
  track<E extends EventName>(name: E, props: EventProps[E]): void;
}

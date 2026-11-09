import type {TelemetrySink} from './telemetry.ts';
import type {EndpointInfo} from './types.ts';
import type {EndpointConfig} from './gateway-api.ts';

export type {EndpointInfo};

/**
 * Contract 3: Infrastructure Runtime API (`@tsp/contracts/infra-api`).
 *
 * Defines the complete set of capabilities exposed by the underlying infrastructure runtime
 * (document database, online labeling models, agent LLM gateway, SSO identity, file storage,
 * and example pools).
 *
 * - `packages/infra` provides browser/local stand-ins so the public repository runs end-to-end.
 * - `internal/` provides the real platform adapters injected during internal builds.
 * - Keep this file completely free of internal company product or vendor names.
 */

// ---------------------------------------------------------------------------------------------
// Supported LLM models exposed to the Agent Runtime (`apps/agents`) and Labeling presets.

export type LlmModelId = 'gpt-5.4' | 'gpt-5.5' | 'gpt-5.6-luna' | 'gpt-5.6-terra';

export interface LlmModelInfo {
  id: LlmModelId;
  name: string;
  tier: 'fast' | 'balanced' | 'reasoning';
  description: string;
  supportsTemperature: boolean;
  /** USD per million input tokens (for cost estimation). */
  priceIn: number;
  /** USD per million output tokens (for cost estimation). */
  priceOut: number;
  /** True when the model is active on the runtime gateway. */
  available: boolean;
}

/**
 * Complete catalog of LLM models supported by the hosting runtime.
 * `apps/agents` can inspect this list (via `AVAILABLE_LLM_MODELS` or `llm.models()`) and choose
 * which model to pass in `llm.chat(messages, {model})` for each agent preset or reasoning step.
 */
export const AVAILABLE_LLM_MODELS: LlmModelInfo[] = [
  {
    id: 'gpt-5.6-terra',
    name: 'gpt-5.6-terra',
    tier: 'reasoning',
    description: 'Highest-quality reasoning model for schema design, prompt drafting, and optimiser reflection.',
    supportsTemperature: false,
    priceIn: 1.25,
    priceOut: 5.0,
    available: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'gpt-5.6-luna',
    tier: 'balanced',
    description: 'Balanced quality and latency model for multi-turn agent tasks and evaluation analysis.',
    supportsTemperature: false,
    priceIn: 1.0,
    priceOut: 4.0,
    available: true,
  },
  {
    id: 'gpt-5.4',
    name: 'gpt-5.4',
    tier: 'fast',
    description: 'Fast, lower-cost model suitable for front-desk routing and high-volume labeling.',
    supportsTemperature: false,
    priceIn: 0.75,
    priceOut: 3.0,
    available: true,
  },
  {
    id: 'gpt-5.5',
    name: 'gpt-5.5',
    tier: 'balanced',
    description: 'SDK-listed model identifier (currently inactive on the gateway; prefer gpt-5.6-terra or gpt-5.6-luna).',
    supportsTemperature: false,
    priceIn: 1.1,
    priceOut: 4.4,
    available: false,
  },
];

// ---------------------------------------------------------------------------------------------
// Storage: a schemaless document-collection runtime supporting structured queries, atomic field
// transforms, partial updates, polling subscriptions, and non-atomic batch writes.

export interface StoredDoc<T = Record<string, unknown>> {
  docId: string;
  data: T;
  createdAt?: string;
}

/**
 * Comparison operators supported by structured queries:
 * - `'=='`, `'!='`, `'<'`, `'<='`, `'>'`, `'>='`: standard scalar comparisons
 * - `'in'`, `'not-in'`: value is in (or not in) the given array (up to 30 entries)
 * - `'array-contains'`: array field contains the given element
 * - `'array-contains-any'`: array field contains any element from the given array (up to 30 entries)
 * - `'contains'`: case-insensitive substring match on a string field
 */
export type DocWhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'array-contains'
  | 'array-contains-any'
  | 'in'
  | 'not-in'
  | 'contains';

export interface DocFieldFilter {
  type: 'field';
  field: string;
  op: DocWhereOp;
  value: unknown;
}

export interface DocCompositeFilter {
  type: 'and' | 'or';
  filters: DocFilterExpression[];
}

export type DocFilterExpression = DocFieldFilter | DocCompositeFilter;

/** Helper for constructing structured field and composite (`AND` / `OR`) filter expressions. */
export const DocFilter = {
  where(field: string, op: DocWhereOp, value: unknown): DocFieldFilter {
    return {type: 'field', field, op, value};
  },
  and(...filters: DocFilterExpression[]): DocCompositeFilter {
    return {type: 'and', filters};
  },
  or(...filters: DocFilterExpression[]): DocCompositeFilter {
    return {type: 'or', filters};
  },
};

export interface DocOrder {
  field: string;
  dir: 'asc' | 'desc';
}

export interface DocStructuredQuery {
  where?: DocFilterExpression | DocFilterExpression[] | Record<string, unknown>;
  orderBy?: DocOrder | DocOrder[];
  limit?: number;
  offset?: number;
}

export interface DocPage<T = Record<string, unknown>> {
  documents: StoredDoc<T>[];
  /** Total number of documents matching the filter (ignoring limit and offset). */
  total: number;
}

/**
 * Sentinel value representing an atomic field transform inside `DocCollection.update` or
 * `DocWriteBatch.update` patches (`$inc`, `$addToSet`, `$pull`, `$unset`).
 */
export interface DocFieldValueSentinel {
  __docFieldValue: 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
  value?: unknown;
}

/** Factory helpers for atomic field updates inside `update()` patches. */
export const DocFieldValue = {
  /** Atomically increments (or decrements, when negative) a numeric field. */
  increment(value: number): DocFieldValueSentinel {
    return {__docFieldValue: 'increment', value};
  },
  /** Atomically adds values to an array field using set-union semantics (no duplicates). */
  arrayUnion(...values: unknown[]): DocFieldValueSentinel {
    return {__docFieldValue: 'arrayUnion', value: values};
  },
  /** Atomically removes all occurrences of the given values from an array field. */
  arrayRemove(...values: unknown[]): DocFieldValueSentinel {
    return {__docFieldValue: 'arrayRemove', value: values};
  },
  /** Deletes the field from the document. */
  delete(): DocFieldValueSentinel {
    return {__docFieldValue: 'delete'};
  },
};

export type DocUpdatePatch<T extends object> = {
  [K in keyof T]?: T[K] | DocFieldValueSentinel;
} & Record<string, unknown>;

export interface DocSubscriptionHandlers<T extends object> {
  intervalMs?: number;
  onSnapshot?: (documents: StoredDoc<T>[]) => void;
  onCreate?: (document: StoredDoc<T>) => void;
  onUpdate?: (document: StoredDoc<T>) => void;
  onDelete?: (docId: string) => void;
  onError?: (error: unknown) => void;
}

export interface DocCollection<T extends object = Record<string, unknown>> {
  readonly name: string;
  /** Inserts a new document and returns its server-assigned document ID. */
  add(data: T): Promise<{docId: string}>;
  /** Reads a single document by its server-assigned `docId`, or returns `null` if not found. */
  get(docId: string): Promise<StoredDoc<T> | null>;
  /** Full replacement of an existing document at `docId`. Fails if the document does not exist. */
  set(docId: string, data: T): Promise<void>;
  /**
   * Partial update of an existing document at `docId`. Only the specified fields are modified;
   * field values may be `DocFieldValue` sentinels for atomic increment/array/delete transforms.
   */
  update(docId: string, patch: DocUpdatePatch<T>): Promise<void>;
  /** Deletes an existing document at `docId`. */
  delete(docId: string): Promise<void>;
  /**
   * Fetches all documents matching `where` (accepts either a plain equality map `{field: value}`
   * or a `DocFilterExpression` built with `DocFilter`), ordered by `order`, automatically
   * paging through the collection.
   */
  find(where?: Record<string, unknown> | DocFilterExpression, order?: DocOrder | DocOrder[]): Promise<StoredDoc<T>[]>;
  /**
   * Executes a single paginated structured query with full support for `DocFilterExpression`,
   * multiple `orderBy` clauses, `limit`, and `offset`, returning `{documents, total}`.
   */
  query(q: DocStructuredQuery): Promise<DocPage<T>>;
  /** Subscribes to collection changes via client-side polling. Returns an `{unsubscribe}` handle. */
  subscribe(handlers: DocSubscriptionHandlers<T>): {unsubscribe(): void};
}

export type DocBatchOpResult =
  | {index: number; status: 'ok'; docId?: string}
  | {index: number; status: 'error'; error: string};

/**
 * Groups multiple `set` / `update` / `delete` operations across one or more collections into a
 * single network round-trip.
 *
 * Note: Operations execute sequentially on a standalone document node and are not transactional
 * (a failure partway through does not roll back earlier operations). Inspect the returned
 * `results` array for per-operation status.
 */
export interface DocWriteBatch {
  set<T extends object>(collectionName: string, docId: string, data: T): DocWriteBatch;
  update<T extends object>(collectionName: string, docId: string, patch: DocUpdatePatch<T>): DocWriteBatch;
  delete(collectionName: string, docId: string): DocWriteBatch;
  commit(): Promise<{results: DocBatchOpResult[]}>;
}

export interface DocRuntime {
  collection<T extends object = Record<string, unknown>>(name: string): DocCollection<T>;
  /** Creates a batch writer for grouping multiple document mutations into one request. */
  batch(): DocWriteBatch;
}

// ---------------------------------------------------------------------------------------------
// Labeling models & Agent LLM runtime (non-streaming and SSE streaming).

export type ContentPart = {type: 'text'; text: string} | {type: 'image'; url: string};

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * Streaming event yielded by `chatStream`:
 * - `delta`: incremental text fragment
 * - `thinking`: incremental reasoning/thinking fragment (when the model emits thinking blocks)
 * - `done`: stream completed
 * - `error`: stream failed with `message`
 */
export type LlmStreamChunk =
  | {type: 'delta'; text: string}
  | {type: 'thinking'; thinking: string}
  | {type: 'done'; createdAt: string}
  | {type: 'error'; message: string};

export interface ChatRequest {
  endpoint: 'A' | 'B';
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  /** Opaque trace id (the example id). Real adapters may log it; they must not send it to the model. */
  traceId?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  thinking?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LabelingModels {
  endpoints(): EndpointInfo[];
  /** One online call (eval runs, optimiser runs, training set runs). Throw on failure; the caller retries. */
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Streaming variant of `chat()` yielding incremental `LlmStreamChunk` events. */
  chatStream(req: ChatRequest): AsyncGenerator<LlmStreamChunk>;
}

export interface AgentChatOptions {
  /**
   * Target model ID selected by the agent runtime (from `AVAILABLE_LLM_MODELS`).
   * If omitted, the adapter uses its default active model (`gpt-5.4`).
   */
  model?: LlmModelId;
  /** When true, instructs the model to respond with a single valid JSON object. */
  json?: boolean;
  /** Optional cap on output tokens. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AgentCompletionResult {
  text: string;
  /** Concatenated reasoning/thinking content, if returned by the model. */
  thinking?: string;
  model: string;
  id?: string;
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentModel {
  /** Returns the catalog of LLM models supported by the runtime. */
  models(): LlmModelInfo[];
  /** Returns the model's text. With json: true the model is asked for one JSON object. */
  chat(messages: ModelMessage[], opts?: AgentChatOptions): Promise<string>;
  /** Full completion call returning `text`, `thinking`, `model`, `stopReason`, and token `usage`. */
  complete(messages: ModelMessage[], opts?: AgentChatOptions): Promise<AgentCompletionResult>;
  /** Streaming chat call yielding `LlmStreamChunk` (`delta`, `thinking`, `done`, `error`) events. */
  chatStream(messages: ModelMessage[], opts?: AgentChatOptions): AsyncGenerator<LlmStreamChunk>;
}

// ---------------------------------------------------------------------------------------------
// Identity: who is using the page (identification only, not access control).

export interface Identity {
  currentUser(): Promise<{id: string; name: string; email?: string; organization?: string}>;
}

// ---------------------------------------------------------------------------------------------
// Files: prompt images, uploaded label files and exports (supports chunked progress reporting).

export interface FileUploadOptions {
  mimeType?: string;
  onProgress?: (progress: {uploadedBytes: number; totalBytes: number}) => void;
}

export interface UploadedFileInfo {
  url: string;
  key?: string;
  size?: number;
  mimeType?: string;
}

export interface FileStore {
  upload(file: Blob | string, name: string, options?: FileUploadOptions): Promise<UploadedFileInfo>;
}

// ---------------------------------------------------------------------------------------------
// Examples: the MVP mocks automatic sampling from a prepared file of examples with features.

export interface RawExample {
  externalId: string;
  type: 'video' | 'photo_text';
  title: string;
  features: Record<string, string | string[]>;
}

export interface ExampleSource {
  /** How many examples sampling can return. */
  available(): Promise<number>;
  /** Picks n examples at random. Calls onProgress while it works. */
  sample(n: number, onProgress?: (fetched: number) => void, signal?: AbortSignal): Promise<RawExample[]>;
  /** Looks up examples by id, for chat attachments. Unknown ids are left out. */
  lookup(ids: string[]): Promise<RawExample[]>;
  /** Gold labels shipped with the prepared file, if any (for "Upload labels"). */
  bundledLabels?(): Promise<{externalId: string; answer: Record<string, string[]>}[]>;
}

/**
 * What people see of one example (Gold Labels shows it above the features). Only for people:
 * the labeling models get image features through the prompt template, never through this.
 *
 * There is deliberately no direct video file URL: playback uses an embedded player page, not
 * a media file. The adapter decides which player (the item's official embed player, or a
 * fallback viewer when the item is no longer publicly playable) and may check availability
 * before answering; the page just loads `playerUrl` in an iframe.
 */
export interface ExampleMedia {
  kind: 'video' | 'images';
  /** URL of the player page to embed in an iframe; plays videos and photo posts alike. */
  playerUrl?: string;
  /** The cover or poster image. */
  coverUrl?: string;
  /** Still images: a photo-and-text post's images, or key frames of a video. May be empty. */
  imageUrls: string[];
  /** Video length in seconds, when known. */
  durationSec?: number;
}

/** Media for examples. Every URL must load in the signed-in user's browser. */
export interface MediaSource {
  /** The example's media by its external id (item id); null when it has none or it is gone. */
  media(externalId: string, type: RawExample['type']): Promise<ExampleMedia | null>;
}

export interface Platform {
  db: DocRuntime;
  models: LabelingModels;
  agent: AgentModel;
  identity: Identity;
  files: FileStore;
  examples: ExampleSource;
  /**
   * Media for people to look at (Gold Labels). Optional: without it pages show the item id only.
   * See docs/handover/integration.md, "Media".
   */
  media?: MediaSource;
  /**
   * Registered endpoints with their QPM/TPM. Optional: the gateway fills anything missing from its
   * assumed defaults (`apps/llm-gateway/src/registry.ts`).
   */
  endpoints?: EndpointConfig[];
  /**
   * Where telemetry goes (metrics are pushed as Prometheus text; events in batches). Optional:
   * without it nothing leaves the page. See the doc "Telemetry: events and metrics".
   */
  telemetry?: TelemetrySink;
  /** Shown in the header so nobody mistakes a stand-in for the real service. */
  standIns: string[];
}

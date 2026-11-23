import type {TelemetrySink} from './telemetry.ts';
import type {ClientDiagnostics, EndpointId, EndpointInfo, ExampleType, FeatureValue, ItemProblem, Locale, Msg, NodeId, PageId} from './types.ts';
import type {EndpointConfig} from './gateway-api.ts';
import type {DeepPartial, SystemConfig} from './config.ts';
import type {JobStorePort} from './jobs-api.ts';

export type {EndpointInfo};

/**
 * Contract 3: Platform Runtime API (`@yushiguang/sprint-contracts/platform-api`).
 *
 * Defines the complete set of capabilities exposed by the underlying hosting platform
 * (document database, online labeling models, agent LLM gateway, SSO identity, file storage,
 * and example pools).
 *
 * - `packages/platform` provides browser/local stand-ins so the public repository runs end-to-end.
 * - A deployment provides the real adapters (docs/integration.md).
 * - Keep this file free of company product or vendor names.
 */

// ---------------------------------------------------------------------------------------------
// The model registry (deployment readiness spec, 5): the models the hosting platform serves to the
// agent runtime (`apps/agents`) and the gateway's chat endpoints. Model ids are opaque strings the
// registry defines; nothing in this repository lists them as a type.

/** How hard a reasoning model thinks before it answers, where the model lets the caller choose. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** A model's speed and quality class, which the gateway's fallback and assumed limits use. */
export type ModelTier = 'fast' | 'balanced' | 'reasoning';

/** What a model can take and do. */
export interface ModelCapabilities {
  /** Takes images in a message. */
  vision: boolean;
  /** Calls tools natively (`AgentChatOptions.tools`). */
  tools: boolean;
  /** The reasoning effort levels it accepts; empty when it cannot be set. */
  reasoningEffort: ReasoningEffort[];
  /** The most tokens a call may hold, input and output together. */
  contextTokens: number;
  /** Takes a sampling temperature. */
  temperature: boolean;
}

/** One model in the registry. */
export interface LlmModelInfo {
  /** The registry's opaque id; agent presets name a model by it. */
  id: string;
  /** Display name. */
  name: string;
  tier: ModelTier;
  description: string;
  capabilities: ModelCapabilities;
  /** USD per million input tokens (for cost accounting). */
  priceIn: number;
  /** USD per million output tokens, reasoning tokens included. */
  priceOut: number;
  /** False while the platform does not serve it: calls fall back to another model. */
  active: boolean;
}

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

/**
 * A tool the model may call natively (spec 5), as an alternative to the JSON-in-the-answer tool
 * protocol the agents use today. Only for models whose registry entry says `capabilities.tools`.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** The arguments, as a JSON Schema object. */
  parameters: Record<string, unknown>;
}

/** A native tool call the model asked for. */
export interface ToolCall {
  /** The model's id for the call, to send its result back under. */
  id: string;
  name: string;
  /** The arguments as the model wrote them (JSON text); the caller parses and checks them. */
  arguments: string;
}

/**
 * What shape the answer must take: plain text, one JSON object, or JSON matching a schema.
 * A model service that cannot hold the answer to a schema may treat `json_schema` as `json_object`.
 */
export type ResponseFormat = {type: 'text'} | {type: 'json_object'} | {type: 'json_schema'; name: string; schema: Record<string, unknown>};

export interface ChatRequest {
  /**
   * What to call, decided at call time (docs/design/server.md, 9): a platform default's id, as
   * `LabelingModels.endpoints()` lists it, or the Endpoint a tenant admin entered for a tenant
   * model. An adapter must take any endpoint here, not only ones known when the process started.
   */
  endpoint: EndpointId;
  /** The tenant the call is for, when the gateway knows it (for the adapter's logs and quotas). */
  tenantId?: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  /** Opaque trace id (the example id). Real adapters may log it; they must not send it to the model. */
  traceId?: string;
  /** How hard a reasoning model thinks; left out, the model's default. */
  reasoningEffort?: ReasoningEffort;
  /** What shape the answer must take; left out, plain text. */
  responseFormat?: ResponseFormat;
  /**
   * The most this call may take, in ms. The adapter may pass it on (an HTTP timeout); the gateway
   * also stops waiting after it and counts the call as timed out (retried like a busy reply).
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  thinking?: string;
  inputTokens: number;
  /** Tokens of the answer, reasoning tokens not included. */
  outputTokens: number;
  /** Tokens the model spent reasoning, billed at the output price. Left out when none. */
  reasoningTokens?: number;
}

export interface LabelingModels {
  /** The platform's default labeling models, offered to every tenant beside its own. */
  endpoints(): EndpointInfo[];
  /** One online call (eval runs, optimiser runs, training set runs). Throw on failure; the caller retries. */
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Streaming variant of `chat()` yielding incremental `LlmStreamChunk` events. */
  chatStream(req: ChatRequest): AsyncGenerator<LlmStreamChunk>;
}

export interface AgentChatOptions {
  /**
   * The registry id of the model to use (`AgentModel.models()`). An unknown or inactive id, or
   * none, falls back to an active reasoning model, then to any active model (the gateway decides).
   */
  model?: string;
  /**
   * The tenant the call is for: the gateway counts its rate limits under tenant + endpoint, so one
   * tenant's calls never use up another's (docs/design/server.md, 9). Left out: `default`.
   */
  tenantId?: string;
  /**
   * Set by the gateway when it calls a tenant model: the Endpoint the tenant admin entered. An
   * adapter that receives it calls that endpoint instead of the registry model's own, and must
   * take one it has never seen. Callers of the gateway leave it out.
   */
  endpoint?: string;
  /** When true, instructs the model to respond with a single valid JSON object (`responseFormat` json_object). */
  json?: boolean;
  /** What shape the answer must take; wins over `json`. */
  responseFormat?: ResponseFormat;
  /** Optional cap on output tokens. */
  maxOutputTokens?: number;
  /**
   * How hard a reasoning model thinks. Dropped when the model's registry entry does not list the
   * level, so a preset never fails because its model changed.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Native tools (`complete` only). The answer's `toolCalls` holds the calls the model asked for.
   * Refused (`rejected`) on a model whose registry entry has no `capabilities.tools`.
   */
  tools?: ToolDefinition[];
  /** The most this call may take, in ms; see `ChatRequest.timeoutMs`. A stream passes it to the model service only. */
  timeoutMs?: number;
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
    /** Reasoning tokens not included. */
    outputTokens: number;
    /** Tokens the model spent reasoning, billed at the output price. */
    reasoningTokens?: number;
  };
  /** The native tool calls the model asked for, when `tools` were given. */
  toolCalls?: ToolCall[];
}

export interface AgentModel {
  /** The model registry the hosting platform supplies (spec 5). */
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
  /** The signed-in user. Rejects when nobody is signed in. */
  currentUser(): Promise<{id: string; name: string; email?: string; organization?: string; organizationName?: string}>;
  /** Ends the session (the hosting platform's single sign-on). Absent: the site offers no Sign out. */
  signOut?(): Promise<void>;
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
// Examples: an item's features, looked up by its id. Which items a project uses comes from the
// tenant's data sources (#29); the sample data that ships with the platform is one built-in source.

export interface RawExample {
  externalId: string;
  type: 'video' | 'photo_text';
  title: string;
  features: Record<string, FeatureValue>;
}

/** One item's checks (#32): its kind, or why it cannot be used. */
export interface ItemCheck {
  externalId: string;
  /** Photo-and-text or video; null when the item is not found. */
  type: ExampleType | null;
  /** Why it is left out; null when it passes every check. */
  problem: ItemProblem | null;
}

export interface ExampleSource {
  /**
   * The feature port: examples by id with their features (taking examples, chat attachments).
   * Unknown ids are left out; a feature that could not be fetched is left out of that item's
   * features. Called in batches of `dataset.featureBatch` ids.
   */
  lookup(ids: string[]): Promise<RawExample[]>;
  /**
   * The platform's item checks (#32), run on every item before its features are fetched: the item
   * exists, its creator is an adult, it is publicly recommendable, and its kind. Without it, an item
   * `lookup` does not know counts as missing. Called in batches of `dataset.featureBatch` ids.
   */
  check?(ids: string[]): Promise<ItemCheck[]>;
  /**
   * The item ids of the sample data that ships with the platform, if any: every tenant gets them
   * as a built-in data source (#29).
   */
  builtIn?(): Promise<{name: string; ids: string[]}>;
  /** Gold labels shipped with the sample data, if any (for "Upload labels"). */
  bundledLabels?(): Promise<{externalId: string; answer: string | string[] | Record<string, string | string[]>}[]>;
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
  /**
   * A page where a person can open the item in a new tab (resilience spec, 4), for when the player
   * cannot be embedded: cross-site embedding blocked, rate-limited, or needing a top-level sign-in.
   */
  externalUrl?: string;
}

/** Media for examples. Every URL must load in the signed-in user's browser. */
export interface MediaSource {
  /** The example's media by its external id (item id); null when it has none or it is gone. */
  media(externalId: string, type: RawExample['type']): Promise<ExampleMedia | null>;
}

/**
 * What a feature is and when it helps, for the agents (the Prompt helper and the Optimiser) and
 * for hover text on feature names. A deployment provides the real text; the repo has a
 * stand-in with made-up text. See docs/integration.md, "Feature descriptions".
 */
export interface FeatureInfo {
  description: string;
  goodFor?: string;
  caveats?: string;
}

export interface FeatureInfoSource {
  /** Descriptions by feature key (the placeholder name). Keys with no description are left out. */
  describe(keys: string[]): Promise<Record<string, FeatureInfo>>;
}

/** A document a user linked in Ask AI, as plain text (headings kept as lines). */
export interface LinkedDocument {
  title: string;
  text: string;
}

/**
 * Reads the documents users link in Ask AI (the deployment's document service), for the helpers'
 * `read_doc` tool. A deployment implements it; the repo's stand-in reads nothing. See
 * docs/integration.md, "Document links".
 */
export interface DocumentSource {
  /**
   * The document at `url` as the caller (`ctx.user`) may see it; null when it cannot be read.
   * The context is the Ask AI turn's, so a helper reads with the rights of the person it answers,
   * never with a service account (deployment readiness review, gap G3).
   */
  read(ctx: RequestContext, url: string): Promise<LinkedDocument | null>;
}

// ---------------------------------------------------------------------------------------------
// Enterprise extension ports (spec 1.0.0, section 7.1). All optional: the single-tenant stand-ins
// in `@yushiguang/sprint-platform` allow everything and run jobs in the page.

/** The person a call is made for, as the channel (the bff) authenticated them. */
export interface CallerUser {
  id: string;
  name: string;
  email?: string;
}

/**
 * Who a service call is made for and how it travels (deployment readiness spec, 2). Every
 * `WorkflowContract` method takes one as its first argument; the bff builds it from the
 * authenticated request, one per call. It carries ids and the caller, never a copy of a project:
 * a service loads the records itself, so they are never stale and a client cannot forge them.
 * Product events are stamped from it (request, user, project, page, app version) so a user's
 * actions can be followed across services; telemetry still carries ids and counts only.
 */
export interface RequestContext {
  /** One id per call, passed on to every hop (logs, problem reports, traces). */
  requestId: string;
  user: CallerUser;
  tenantId?: string;
  /** The language the user reads the site in. */
  locale?: Locale;
  /** The user's IANA time zone, for times written in messages. */
  timeZone?: string;
  /** The service that makes the call (`bff`, `optimiser`, `worker`), for service-to-service auth. */
  caller?: string;
  /** Epoch milliseconds after which the caller has given up: every hop stops work past it. */
  deadline?: number;
  /** The site version the user has open, to spot a page older than the server. */
  appVersion?: string;
  /** The W3C `traceparent` of the call, when the hosting platform traces requests. */
  traceParent?: string;
}

/**
 * Short-lived state shared by every replica of a service (deployment readiness spec, 2): the
 * running Ask AI turn's live line, the helper answering on a page, a problem-report draft, the
 * turn's page and browser record. Values are plain JSON; each key expires after its TTL. A server
 * deployment backs it with a key-value store with expiry; the browser build keeps it in memory.
 */
export interface SharedStatePort {
  get<T>(key: string): Promise<T | null>;
  /** Writes `value` under `key`; it is gone after `ttlMs`. */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Named locks shared by every process that may run the same work (deployment readiness spec, 2;
 * issue #46), so one labeling task, one prediction and one Optimiser run have one runner across
 * BFF replicas and worker units, not one per process. Each method is one atomic step on one lock
 * name (`name`): a Redis implementation runs each as a script (acquire as `SET NX PX`); SQL as
 * one conditional update. `@yushiguang/sprint-platform` has the in-memory one (`memoryLockStore`)
 * and the adapter that turns it into the locks the apps take (`leaseLocks`).
 *
 * A lock is a lease, as a job's and a limiter permit's are: `acquire` takes it only when it is
 * free or its lease has ended, `renew` and `release` count only for the `owner` that took it, and
 * `isHeld` is true only while the lease lasts, so a process that dies without releasing never
 * wedges the work — the lock frees when the lease ends. `now` is the caller's epoch milliseconds;
 * a shared store may use its own clock instead, so the replicas' clocks need not agree. A runner
 * frozen longer than its lease can lose the lock mid-run (the same fencing limit the job and
 * limiter leases accept); callers re-check saved work before paying again where it matters.
 */
export interface LockStorePort {
  /**
   * Takes the lock for `owner` until `now + leaseMs`; false when the lock is already held, by any
   * owner including this one — locks are not re-entrant, so a holder asking again is refused.
   */
  acquire(name: string, owner: string, leaseMs: number, now: number): Promise<boolean>;
  /** Extends the lease to `now + leaseMs`, if `owner` still holds it and it has not ended. */
  renew(name: string, owner: string, leaseMs: number, now: number): Promise<boolean>;
  /** Frees the lock, if `owner` still holds it; another owner's lock is left alone. */
  release(name: string, owner: string): Promise<void>;
  /** True while some owner's lease on the lock lasts at `now`. */
  isHeld(name: string, now: number): Promise<boolean>;
}

/** One endpoint's limits, as the gateway's registry has them. */
export interface LimiterLimits {
  /** Requests per window. */
  qpm: number;
  /** Tokens per window (input, output and reasoning). */
  tpm: number;
  /** Calls in flight at most (before a busy reply halves it). */
  maxConcurrency: number;
  /** The sliding window, one minute in production. */
  windowMs: number;
}

/** A waiter's try: a permit, or not yet (with when trying again may succeed, -1 unknown). */
export type LimiterTry = {granted: true; permitId: string} | {granted: false; waitMs: number};

export interface LimiterStats {
  inFlight: number;
  /** The cap on calls in flight now (lowered after a busy reply, back up one per quiet window). */
  concurrency: number;
  requestsInWindow: number;
  tokensInWindow: number;
  /** Waiters in the queue, from every process. */
  waiting: number;
}

/** Options of one object written (`ObjectStorePort.put`). */
export interface ObjectPutOptions {
  contentType?: string;
  contentEncoding?: string;
}

/**
 * Object storage (S3-compatible in a server deployment; docs/design/server.md 6): the one port
 * every write-once, read-in-bulk store is built on (feature segments, answer segments; later the
 * data sources' ID files, large tool results and training sets). Keys are plain paths
 * (`features/<snapshotId>/<segment>.jsonl`); Sprint never lists a prefix, it keeps every key it
 * needs in its records. `@yushiguang/sprint-platform` has the in-memory one (`memoryObjectStore`)
 * and the cases any implementation must pass (`objectStoreCases`).
 */
export interface ObjectStorePort {
  /** Writes (or replaces) an object whole. A string is stored as UTF-8. `size` is in bytes. */
  put(key: string, body: Uint8Array | string, opts?: ObjectPutOptions): Promise<{key: string; size: number}>;
  /** The whole object, or null when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Bytes `offset` to `offset + length` (HTTP Range GET), cut at the object's end: empty when
   * `offset` is at or past it. Null when there is no object. A negative offset or length throws.
   */
  getRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  /** Removes an object; a missing one is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Removes many objects in as few requests as the store allows (S3 `DeleteObjects`); missing
   * keys are not an error. Nothing is returned: a batch delete cannot tell which keys existed.
   */
  deleteBatch(keys: string[]): Promise<void>;
  /** Optional: a signed link to read the object for a while (images, previews). */
  signUrl?(key: string, expiresSec?: number): Promise<string>;
}

/**
 * The gateway's rate-limiter state for every endpoint, shared by every replica of every caller
 * (deployment readiness spec, 5), so one endpoint has one budget per tenant. Each method is one
 * atomic step on one key's state: a Redis implementation runs each as a script; SQL as one
 * transaction. A key is `<tenantId>:<endpointId>` (docs/design/server.md, 9): two tenants on the
 * same endpoint have separate QPM/TPM, and a busy reply slows down only the tenant that got it.
 * Treat the key as opaque. `@yushiguang/sprint-platform` has the in-memory one (`memoryLimiterStore`).
 *
 * Semantics, the same as one process's limiter: a sliding window of requests and tokens (QPM,
 * TPM), a cap on calls in flight, one FIFO queue of waiters, and after a busy reply half the
 * concurrency and a hold, with one call back per quiet window. A permit holds its slot until its
 * lease ends: a process that dies without releasing never wedges the endpoint. A waiter's ticket
 * expires the same way when the waiter stops asking. `now` is the caller's clock; a shared store
 * may use its own instead, so the replicas' clocks need not agree.
 */
export interface LimiterStorePort {
  /**
   * Drops what expired (window entries, permits whose lease ended, tickets not asked for within
   * `ticketTtlMs`), puts `ticket` in the queue or refreshes it, and grants a permit when the
   * ticket is first, the endpoint is not on hold, and `tokens` fit the window and a slot is free.
   * A single call larger than the whole TPM may go alone. The permit's lease ends at
   * `now + leaseMs`.
   */
  tryAcquire(key: string, req: {ticket: string; tokens: number; limits: LimiterLimits; leaseMs: number; ticketTtlMs: number; now: number}): Promise<LimiterTry>;
  /** Takes a waiter out of the queue (it was stopped). */
  leave(key: string, ticket: string): Promise<void>;
  /** Frees the permit's slot and corrects its window entry to the real token count, when known. */
  release(key: string, permitId: string, actualTokens: number | null, now: number): Promise<void>;
  /** Extends a permit's lease (a long call); false when the lease had already ended. */
  renew(key: string, permitId: string, leaseMs: number, now: number): Promise<boolean>;
  /** A busy reply: halves the concurrency and holds every call until `now + retryAfterMs`. */
  penalize(key: string, retryAfterMs: number, limits: LimiterLimits, now: number): Promise<void>;
  stats(key: string, limits: LimiterLimits, now: number): Promise<LimiterStats>;
}

/**
 * The configuration platform (docs/design/server.md, 7): string keys to string values. Keys are
 * Sprint's logical keys (`labeling.maxFailedShare`, `tenant.<tenantId>.jobs.limit.model`); an
 * adapter whose platform wants keys registered up front may keep them all in one JSON map key.
 * Sprint caches what it reads (`@yushiguang/sprint-config`), so a slow or failing platform never
 * stops a call.
 */
export interface ConfigPort {
  /**
   * The value of `key`, or null when it is not set (never a "not found" error). Throws when the
   * platform is down, times out or fails to read: the cache then keeps the value it had.
   */
  get(key: string): Promise<string | null>;
  /** Optional: several keys in one read (start-up and the periodic refresh). Same rules as `get`. */
  getMany?(keys: string[]): Promise<Record<string, string | null>>;
  /** Optional: the platform pushes changes; `onChange` drops the cache. Returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
}

/** Which job concurrency limit: a model task on one endpoint, or a compute-only task. */
export type JobLimitTarget = {kind: 'model'; endpointId: string} | {kind: 'compute'};

/** One tenant's view of the configuration: its own keys first, then the process-level values. */
export interface TenantConfig {
  /**
   * The tenant's value of `key` (read as `tenant.<tenantId>.<key>`), or null when it has none.
   * During an outage it gives the value last read; it throws only when it never read one.
   */
  get(key: string): Promise<string | null>;
  /**
   * The concurrency limit for a job (docs/design/server.md, 7). Model tasks:
   * `tenant.<id>.jobs.limit.endpoint.<endpointId>`, then `tenant.<id>.jobs.limit.model`, then
   * `jobs.limit.model`. Compute tasks: `tenant.<id>.jobs.limit.compute`, then `jobs.limit.compute`.
   * The first valid one wins. Never throws.
   */
  jobLimit(target: JobLimitTarget): Promise<number>;
}

/**
 * Reads configuration for one tenant, explicitly: there is no per-request global, so two
 * requests of two tenants never see each other's values. Without a tenant, only the
 * process-level values apply.
 */
export interface ConfigReader {
  forTenant(tenantId: string | undefined): TenantConfig;
}

/**
 * The tenant of a caller whose context names none (the browser build, single-tenant stand-ins),
 * and of records saved before tenants existed.
 */
export const DEFAULT_TENANT = 'default';

/**
 * The three permission points (docs/design/server.md, 2.1). `read`: every member of the tenant
 * sees everything in it. `project_write`: edit (and delete) one project; its creator and its
 * labelers get it, others ask for it. `tenant_write`: the tenant's admins (settings, members,
 * models, data sources).
 */
export type PermissionPoint = 'read' | 'project_write' | 'tenant_write';

/**
 * The caller of work Sprint starts itself (the sweep, auto starts). It cannot come from outside:
 * the bff always sets its own caller. `AuthorizationPort` is not asked for it; only the tenant of
 * the project is checked.
 */
export const SYSTEM_CALLER = 'system';

export interface AuthorizationRequest {
  /** What is being done, as `service.method` (for example `workflow.deleteProject`). */
  action: string;
  /** The permission point the action needs, from the workflow's table: adapters need no map of their own. */
  permission: PermissionPoint;
  /**
   * Set for every action on one project. Asked before the workflow reads the project, so it may not
   * exist or may belong to another tenant: answer for `ctx.tenantId` only.
   */
  projectId?: string;
}

/**
 * Asks the external permission platform whether the caller holds a permission point in
 * `ctx.tenantId` (and, for `project_write`, on `projectId`). The workflow asks it before every
 * read and write, agent tools and jobs included, since those do not pass the gateway.
 */
export interface AuthorizationPort {
  allowed(ctx: RequestContext, request: AuthorizationRequest): Promise<boolean>;
}

/**
 * A request for a permission point, sent to the external permission platform (docs/design/server.md,
 * 2.2). Sprint approves nothing itself: approvers handle the request on that platform.
 */
export interface AccessRequest {
  tenantId: string;
  permission: PermissionPoint;
  /** The project, for `project_write`. */
  projectId?: string;
  /** Why the caller needs it, in their own words. */
  reason?: string;
}

/**
 * Sends access requests to the external permission platform (the "insufficient access" dialog's
 * Request access). Throw when the platform cannot be reached; the page says the request failed.
 */
export interface AccessRequestPort {
  /** `trackUrl`: where the caller can follow the request on the platform, when it has such a page. */
  request(ctx: RequestContext, request: AccessRequest): Promise<{trackUrl?: string}>;
}

/** A member's role in a tenant: `admin` holds `tenant_write`. */
export type TenantRole = 'admin' | 'member';

export interface TenantMember {
  userId: string;
  role: TenantRole;
}

/** A tenant a user is in, and as what (#94). */
export interface UserTenant {
  tenantId: string;
  role: TenantRole;
}

/**
 * Writes and lists permissions on the external permission platform (docs/design/server.md, 2.3),
 * for the members pages and for granting labelers. Requests and approvals happen on that platform,
 * not here. Every method is idempotent: calling it again gives the same result. Methods that
 * change something take the caller's context first, so the platform can record who did it.
 * Throw when the platform cannot be reached; the workflow retries.
 */
export interface PermissionAdminPort {
  listTenantMembers(tenantId: string): Promise<TenantMember[]>;
  /** The tenants a user is in (#94): the home page lists them, and the site checks the tenant it opens. */
  listUserTenants(userId: string): Promise<UserTenant[]>;
  addTenantMember(ctx: RequestContext, tenantId: string, userId: string, role: TenantRole): Promise<void>;
  removeTenantMember(ctx: RequestContext, tenantId: string, userId: string): Promise<void>;
  setTenantRole(ctx: RequestContext, tenantId: string, userId: string, role: TenantRole): Promise<void>;
  /** The users holding `project_write` on the project. */
  listProjectWriters(tenantId: string, projectId: string): Promise<string[]>;
  grantProjectWrite(ctx: RequestContext, tenantId: string, projectId: string, userId: string): Promise<void>;
  revokeProjectWrite(ctx: RequestContext, tenantId: string, projectId: string, userId: string): Promise<void>;
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
   * See docs/integration.md, "Media".
   */
  media?: MediaSource;
  /** Feature descriptions. Optional: without it the agents see feature names only. */
  featureInfo?: FeatureInfoSource;
  /** Document links in Ask AI. Optional: without it the helpers say they cannot open links. */
  documents?: DocumentSource;
  /**
   * Registered platform default endpoints with their QPM/TPM. Optional: the gateway fills anything
   * missing from its assumed defaults (`apps/llm-gateway/src/registry.ts`). Tenant models are not
   * listed here: the gateway reads them per tenant (`TenantModelSource`).
   */
  endpoints?: EndpointConfig[];
  /**
   * Where telemetry goes (metrics are pushed as Prometheus text; events in batches). Optional:
   * without it nothing leaves the page. See docs/design/telemetry.md.
   */
  telemetry?: TelemetrySink;
  /**
   * Overrides of the system's tunable numbers, merged over `DEFAULT_SYSTEM_CONFIG` at startup, so
   * a hosting adapter tunes them without code edits.
   */
  config?: DeepPartial<SystemConfig>;
  /**
   * The configuration platform (docs/design/server.md, 7). Its values go over `config`, which
   * goes over the defaults; tenant keys override the job limits. Optional: without it only
   * `config` applies (stand-in: `memoryConfig`).
   */
  configStore?: ConfigPort;
  /** Permission checks. Optional: without it every signed-in user may do everything. */
  authorization?: AuthorizationPort;
  /**
   * Writes permissions on the external permission platform (members pages, labelers). Optional:
   * without it they are kept in this process (`memoryPermissionAdmin`).
   */
  permissionAdmin?: PermissionAdminPort;
  /**
   * Sends access requests to the external permission platform. Optional: the stand-ins keep them
   * in this process (`memoryAccessRequests`, no tracking link); a deployment that leaves it out
   * refuses requests for access.
   */
  accessRequests?: AccessRequestPort;
  /**
   * Where background jobs are kept (`jobs-api.ts`). Optional: without it the job module keeps them
   * in the memory of its own process (`memoryJobStore`), which is right for the browser build.
   */
  jobStore?: JobStorePort;
  /**
   * Where the gateway's rate limits are counted (spec 5). Optional: without it each process counts
   * its own (`memoryLimiterStore`), right for the browser build and one gateway process.
   */
  limiterStore?: LimiterStorePort;
  /**
   * Short-lived shared state with expiry. Optional: without it the workflow keeps it in the
   * memory of its own process, which is right for the browser build and one server replica.
   */
  sharedState?: SharedStatePort;
  /**
   * Where named locks are kept, shared by every process that may run the same work (issue #46).
   * Optional: without it a composition root locks within one process (`browserLocks` in the
   * browser, `memoryLocks` in one server process), which is right for the browser build and one
   * server process. A deployment with more than one process (BFF replicas, a second worker unit)
   * must supply a shared one and pass `leaseLocks(it)` to labeling, the workflow and the
   * Optimiser. See docs/integration.md, "Building the server's own composition".
   */
  lockStore?: LockStorePort;
  /**
   * Where problem reports go (spec 1.1.0, 3.3). Optional: without it the helpers say reports
   * cannot be sent here. See docs/integration.md, "Problem reports".
   */
  tickets?: TicketPort;
  /**
   * Object storage for data written once and read whole or by byte range (docs/design/server.md
   * 6): frozen feature snapshots and the models' answers, packed in segment files. Optional:
   * without it they stay in `db`, which is right for the browser build (stand-in:
   * `memoryObjectStore`).
   */
  objectStore?: ObjectStorePort;
  /**
   * Sends notifications to people, for example as instant-message cards (docs/design/server.md,
   * 8). Best effort: a failed send is logged and counted, never fails the work that sent it.
   * Optional: without it nothing is sent (stand-in: `logNotifications`).
   */
  notifications?: NotificationPort;
  /** Shown in the header so nobody mistakes a stand-in for the real service. */
  standIns: string[];
}

/**
 * A problem report, filed by a helper after the user agreed (spec 1.1.0, 3). Everything in it is
 * what the user said, where they were and what the site saw; content only when they agreed.
 */
export interface TicketSubmission {
  /** One line: what went wrong, in the user's words. */
  summary: string;
  expected: string;
  actual: string;
  /** Steps to reach the problem, from the user's account and the action trail. */
  steps: string[];
  reporter: {id: string; name: string};
  locale: Locale;
  /** Which helper filed it. */
  filedBy: string;
  createdAt: string;
  where: {
    appVersion: string;
    projectId: string | null;
    projectName: string | null;
    page: PageId | 'other';
    /** The page's ids: version (`v`), model (`m`). */
    params: Record<string, string>;
    approvedSteps: NodeId[];
    /** The project's settings in short: pass rule mode and labeling model. */
    settings: {passRule: string; model: string} | null;
  };
  /** The recent Ask AI action lines (what the user and the helpers did), oldest first. */
  actions: {at: string; text: string}[];
  /** Null when the client sent none (for example an older client). */
  diagnostics: ClientDiagnostics | null;
  /** Only when the user agreed: the prompt the problem is about. */
  content: {versionLabel: string; prompt: string} | null;
}

/** Files problem reports in the company's tracker (or hands them to a dev agent). */
export interface TicketPort {
  /** Files the ticket and returns the id the user can quote. Throw when it cannot be filed. */
  submit(ticket: TicketSubmission): Promise<{ticketId: string}>;
}

/**
 * What a notification is about (docs/design/server.md, 8). Scoring and Optimiser notifications go
 * to the person who started the work when it ends; `label_set_created` and `labeler_added` are
 * for the label sets (#59 step 8).
 */
export type NotificationKind = 'scoring_finished' | 'scoring_failed' | 'optimiser_finished' | 'optimiser_failed' | 'label_set_created' | 'labeler_added';

/**
 * One notification, to one or more people. Ids and site words (the project's name, a version
 * number, a model's name) only: never prompt text, examples or labels.
 */
export interface Notification {
  /** Who gets it: user ids, as in `CallerUser.id`. Never empty. */
  userIds: string[];
  kind: NotificationKind;
  /** The project it is about, or null for none. */
  projectId: string | null;
  /** The message in English, plain text: for a tool that cannot translate `msg`. */
  text: string;
  /**
   * The page it points to, as a path and query inside the site (`/prompt/?p=pr_1`). The adapter
   * puts the site's address in front.
   */
  link: string;
  /** A short title for a card, in English. */
  title?: string;
  /** `text` as a translatable message, so a card can be shown in each person's language. */
  msg?: Msg;
}

/** Sends notifications (an instant-message tool, email). The callers treat every send as best effort. */
export interface NotificationPort {
  /** Sends one notification to everyone in `userIds`. Throw when it could not be sent. */
  send(notification: Notification): Promise<void>;
}

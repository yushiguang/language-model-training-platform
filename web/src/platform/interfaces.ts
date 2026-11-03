/**
 * Everything the app needs from outside its own code. The web app talks to these interfaces
 * only; `src/platform/standins/` holds a working stand-in for each, and the internal
 * integration replaces them in `src/platform/config.ts`. See docs/handover/integration.md.
 *
 * Keep this file free of internal product names.
 */

// ---------------------------------------------------------------------------------------------
// Storage: a Postgres runtime. The app's SQL lives in src/data/ and db/schema.sql.

export interface SqlRuntime {
  /** Runs one statement with $1, $2 … parameters and returns the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs a script of several statements with no parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Labeling models: the two preset endpoints on the model platform.

export type ContentPart = {type: 'text'; text: string} | {type: 'image'; url: string};

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface EndpointInfo {
  id: 'A' | 'B';
  name: string;
  description: string;
  badge: string;
  cost: 'Higher' | 'Lower';
  speed: 'Slower' | 'Faster';
  supportsTemperature: boolean;
  /** USD per million tokens, for estimates. */
  priceIn: number;
  priceOut: number;
}

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
  inputTokens: number;
  outputTokens: number;
}

export interface LabelingModels {
  endpoints(): EndpointInfo[];
  /** One online call (eval runs, optimiser runs). Throw on failure; the caller retries. */
  chat(req: ChatRequest): Promise<ChatResult>;
}

export interface BatchRequest {
  id: string;
  messages: ModelMessage[];
}

export interface BatchStatus {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  error?: string;
}

export type BatchResult = {id: string; ok: true; result: ChatResult} | {id: string; ok: false; error: string};

/** Long runs (the training set) are submit, then poll: the page can close in between. */
export interface BatchJobs {
  submit(input: {endpoint: 'A' | 'B'; requests: BatchRequest[]; maxOutputTokens: number; temperature: number | null}): Promise<{jobId: string}>;
  status(jobId: string): Promise<BatchStatus>;
  results(jobId: string): Promise<BatchResult[]>;
  cancel(jobId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Agent model: the managed LLM the agents and the optimiser's reflection step use.

export interface AgentModel {
  /** Returns the model's text. With json: true the model is asked for one JSON object. */
  chat(messages: ModelMessage[], opts?: {json?: boolean; signal?: AbortSignal}): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// Identity: who is using the page (identification only, not access control).

export interface Identity {
  currentUser(): Promise<{id: string; name: string}>;
}

// ---------------------------------------------------------------------------------------------
// Files: prompt images, uploaded label files and exports.

export interface FileStore {
  upload(file: Blob, name: string): Promise<{url: string}>;
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

export interface Platform {
  sql: SqlRuntime;
  models: LabelingModels;
  batch: BatchJobs;
  agent: AgentModel;
  identity: Identity;
  files: FileStore;
  examples: ExampleSource;
  /** Shown in the header so nobody mistakes a stand-in for the real service. */
  standIns: string[];
}

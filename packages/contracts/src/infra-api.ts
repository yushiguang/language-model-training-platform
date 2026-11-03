import type {EndpointInfo} from './types.ts';

export type {EndpointInfo};

/**
 * Contract 3: Infrastructure Runtime API (`@tsp/contracts/infra-api`).
 *
 * Defines everything the BFF and Agent services need from external infrastructure
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
// Storage: a document-collection runtime. Records are plain JSON objects stored in named collections.

export interface StoredDoc<T = Record<string, unknown>> {
  docId: string;
  data: T;
}

export interface DocOrder {
  field: string;
  dir: 'asc' | 'desc';
}

export interface DocCollection<T extends object = Record<string, unknown>> {
  /** Inserts a new document and returns its server-assigned document ID. */
  add(data: T): Promise<{docId: string}>;
  /** Replaces an existing document at docId. */
  set(docId: string, data: T): Promise<void>;
  /** Returns all documents matching equality filters in `where`, optionally ordered. */
  find(where?: Record<string, unknown>, order?: DocOrder): Promise<StoredDoc<T>[]>;
}

export interface DocRuntime {
  collection<T extends object = Record<string, unknown>>(name: string): DocCollection<T>;
}

// ---------------------------------------------------------------------------------------------
// Labeling models: the two preset endpoints on the model platform.

export type ContentPart = {type: 'text'; text: string} | {type: 'image'; url: string};

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
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
  /** One online call (eval runs, optimiser runs, training set runs). Throw on failure; the caller retries. */
  chat(req: ChatRequest): Promise<ChatResult>;
}

// ---------------------------------------------------------------------------------------------
// Agent model: the managed LLM the agents and the optimiser's reflection step use.

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

export interface AgentModel {
  /** Returns the catalog of LLM models supported by the runtime. */
  models(): LlmModelInfo[];
  /** Returns the model's text. With json: true the model is asked for one JSON object. */
  chat(messages: ModelMessage[], opts?: AgentChatOptions): Promise<string>;
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
  db: DocRuntime;
  models: LabelingModels;
  agent: AgentModel;
  identity: Identity;
  files: FileStore;
  examples: ExampleSource;
  /** Shown in the header so nobody mistakes a stand-in for the real service. */
  standIns: string[];
}

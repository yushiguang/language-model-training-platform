import type {AgentModel, ModelCapabilities, ModelMessage, ModelTier, ReasoningEffort, ResponseFormat} from './platform-api.ts';
import type {EndpointId, EndpointInfo, TenantModel} from './types.ts';

/**
 * Contract: llm-gateway (`apps/llm-gateway`).
 *
 * Every model call goes through the gateway. It owns the endpoint registry (with each endpoint's
 * QPM/TPM), the rate limits, and the retries for a single call. It keeps no state except limiter
 * counters and a short cache of each tenant's models. Chat and labeling use separate endpoints.
 *
 * A tenant may call its own models (`TenantModel`, read through `TenantModelSource`) and the
 * platform's defaults (the registry). Limits are counted per tenant + endpoint
 * (docs/design/server.md, 9).
 */

/** Where the gateway reads a tenant's models; the composition root backs it with the catalog. */
export interface TenantModelSource {
  /** The tenant's models; empty when it has none. Throw when they cannot be read. */
  list(tenantId: string): Promise<TenantModel[]>;
}

export type EndpointPurpose = 'chat' | 'labeling';

export interface EndpointConfig {
  /** Registry id of a platform default, or the tenant model's id. */
  id: string;
  /** Set on a tenant model: the tenant it belongs to. */
  tenantId?: string;
  /** Set on a tenant model: the Endpoint the admin entered, handed to the model service per call. */
  endpoint?: string;
  purpose: EndpointPurpose;
  /** Model served by the endpoint, for example `gpt-5.4`. */
  model: string;
  tier: ModelTier;
  /** Labeling endpoints only: the labeling endpoint id it serves (`EndpointInfo.id`). */
  slot?: EndpointId;
  /** Requests per minute allowed on this endpoint. */
  qpm: number;
  /** Tokens per minute allowed on this endpoint (input + output, reasoning tokens included). */
  tpm: number;
  /** Our own cap on calls in flight, to keep reply times steady. Not a platform limit. */
  maxConcurrency: number;
  /** USD per million tokens, for estimates. */
  priceIn: number;
  priceOut: number;
  supportsTemperature: boolean;
  /** Chat endpoints: the model's capabilities, from its registry entry. */
  capabilities?: ModelCapabilities;
  active: boolean;
  /** True while QPM/TPM are made-up defaults rather than registered values. */
  assumed: boolean;
}

export interface CallUsage {
  inputTokens: number;
  /** Reasoning tokens not included. */
  outputTokens: number;
  /** Tokens the model spent reasoning (billed at the output price); 0 when none. */
  reasoningTokens?: number;
  costUsd: number;
}

export interface LabelCallRequest {
  /** The tenant the call is for: its models may be called, and its limits are used. */
  tenantId: string;
  /** The model: one of the tenant's models (`TenantModel.id`) or a platform default (`EndpointInfo.id`). */
  slot: EndpointId;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  /** Opaque trace id (the example's external id). Never sent to the model. */
  traceId?: string;
  /** How hard a reasoning model thinks; left out, the model's default. */
  reasoningEffort?: ReasoningEffort;
  /** What shape the answer must take; left out, plain text. */
  responseFormat?: ResponseFormat;
  /** The most one try may take, in ms; a try that takes longer is retried as timed out. */
  timeoutMs?: number;
  /**
   * Lets the caller stop the call with `cancel(requestId)`. Several calls may share one id (a
   * labeling run): a cancel stops them all. No signal crosses the contract (spec 4.1).
   */
  requestId?: string;
}

export interface LabelCallResult extends CallUsage {
  text: string;
  endpointId: string;
  /** How many tries the call took (1 = first try). */
  attempts: number;
}

export interface LlmGatewayContract {
  /** The registry, optionally filtered by purpose. */
  endpoints(purpose?: EndpointPurpose): EndpointConfig[];
  /** Product view of the platform's default labeling models (Model A / Model B). */
  labelingEndpoints(): EndpointInfo[];
  /**
   * The labeling models a tenant may use: its own (default first), then the platform's defaults.
   * Rejects when the tenant's models cannot be read.
   */
  labelingEndpointsFor(tenantId: string): Promise<EndpointInfo[]>;
  /** Drops this process's cache of the tenant's models (after they changed), so the next call reads them. */
  forgetTenant(tenantId: string): void;
  /** One labeling call: waits for a QPM/TPM slot, retries busy or broken replies, returns usage. */
  label(req: LabelCallRequest): Promise<LabelCallResult>;
  /** Stops the labeling calls running (or about to start) under this id; they reject as stopped. */
  cancel(requestId: string): Promise<void>;
  /**
   * An `AgentModel` whose calls go through the chat endpoints and their limiters. Calls count
   * under `AgentChatOptions.tenantId`; a `model` naming one of that tenant's models calls it.
   */
  agentModel(): AgentModel;
}

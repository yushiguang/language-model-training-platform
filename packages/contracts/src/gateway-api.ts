import type {AgentModel, ModelMessage} from './platform-api.ts';
import type {EndpointId, EndpointInfo} from './types.ts';

/**
 * Contract: llm-gateway (`apps/llm-gateway`).
 *
 * Every model call goes through the gateway. It owns the endpoint registry (with each endpoint's
 * QPM/TPM), one rate limiter per endpoint, and the retries for a single call. It keeps no state
 * except limiter counters. Chat and labeling use separate endpoints.
 */

export type EndpointPurpose = 'chat' | 'labeling';
export type ModelTier = 'fast' | 'balanced' | 'reasoning';

export interface EndpointConfig {
  /** Registry id of the endpoint (one registration per endpoint across all tenants). */
  id: string;
  purpose: EndpointPurpose;
  /** Model served by the endpoint, for example `gpt-5.4`. */
  model: string;
  tier: ModelTier;
  /** Labeling endpoints only: the product slot it serves ("Model A" or "Model B"). */
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
  active: boolean;
  /** True while QPM/TPM are made-up defaults rather than registered values. */
  assumed: boolean;
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LabelCallRequest {
  slot: EndpointId;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  /** Opaque trace id (the example's external id). Never sent to the model. */
  traceId?: string;
  signal?: AbortSignal;
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
  /** Product view of the labeling slots (Model A / Model B) for pages and estimates. */
  labelingEndpoints(): EndpointInfo[];
  /** One labeling call: waits for a QPM/TPM slot, retries busy or broken replies, returns usage. */
  label(req: LabelCallRequest): Promise<LabelCallResult>;
  /** An `AgentModel` whose calls go through the chat endpoints and their limiters. */
  agentModel(): AgentModel;
}

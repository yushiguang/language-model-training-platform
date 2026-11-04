import {
  errorKindOf,
  LlmCallError,
  type AgentChatOptions,
  type AgentCompletionResult,
  type AgentModel,
  type EndpointConfig,
  type EndpointInfo,
  type LabelCallRequest,
  type LabelCallResult,
  type LlmGatewayContract,
  type LlmStreamChunk,
  type ModelMessage,
  type Platform,
} from '@tsp/contracts';
import {estimateTokens} from '@tsp/domain';
import {EndpointLimiter} from './limiter.ts';
import {buildRegistry} from './registry.ts';

export interface GatewayOptions {
  /** Waits before retry 1, 2, 3 and 4 of a busy or broken call. */
  retryDelaysMs?: number[];
  /** Rate window length; one minute unless a test shortens it. */
  windowMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Output budget assumed for chat calls that do not set one (reasoning counts toward TPM). */
  defaultChatOutputTokens?: number;
}

export const DEFAULT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Stopped', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Stopped', 'AbortError'))), {once: true});
  });

const textOfMessages = (messages: ModelMessage[]) =>
  messages.flatMap(m => (typeof m.content === 'string' ? [{type: 'text' as const, text: m.content}] : m.content.map(p => (p.type === 'text' ? {type: 'text' as const, text: p.text} : {type: 'image' as const}))));

const costOf = (ep: EndpointConfig, inputTokens: number, outputTokens: number) => (inputTokens * ep.priceIn + outputTokens * ep.priceOut) / 1e6;

/**
 * The llm-gateway: every model call in the platform goes through here.
 * Stateless apart from one limiter per endpoint.
 */
export function createGateway(platform: Pick<Platform, 'models' | 'agent' | 'endpoints'>, opts: GatewayOptions = {}): LlmGatewayContract {
  const registry = buildRegistry(platform);
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const limiters = new Map<string, EndpointLimiter>();
  const limiterFor = (ep: EndpointConfig) => {
    let l = limiters.get(ep.id);
    if (!l) {
      l = new EndpointLimiter({qpm: ep.qpm, tpm: ep.tpm, maxConcurrency: ep.maxConcurrency, windowMs: opts.windowMs});
      limiters.set(ep.id, l);
    }
    return l;
  };

  /** Runs one call under the endpoint's limiter, retrying busy or broken replies. */
  async function call<T>(ep: EndpointConfig, estimate: number, signal: AbortSignal | undefined, fn: () => Promise<{value: T; tokens?: number}>): Promise<{value: T; attempts: number}> {
    if (!ep.active) throw new LlmCallError('rejected', `Endpoint ${ep.id} (${ep.model}) is not active.`);
    const limiter = limiterFor(ep);
    let last: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const permit = await limiter.acquire(estimate, signal);
      try {
        const {value, tokens} = await fn();
        permit.release(tokens);
        return {value, attempts: attempt + 1};
      } catch (e) {
        permit.release();
        const kind = errorKindOf(e);
        if (kind === 'aborted') throw e;
        if (kind === 'rejected') throw e instanceof LlmCallError ? e : new LlmCallError('rejected', (e as Error).message ?? String(e));
        last = e;
        if (attempt === delays.length) break;
        const retryAfter = e instanceof LlmCallError ? e.retryAfterMs : undefined;
        if (kind === 'rate_limited') limiter.onRateLimited(retryAfter ?? delays[attempt]);
        await sleep(Math.max(delays[attempt], retryAfter ?? 0), signal);
      }
    }
    const msg = (last as Error)?.message ?? String(last);
    throw new LlmCallError(errorKindOf(last), `${ep.model} didn't answer after ${delays.length + 1} tries. Last error: ${msg}`);
  }

  const chatEndpointFor = (model?: string): EndpointConfig => {
    const chat = registry.filter(e => e.purpose === 'chat');
    const wanted = chat.find(e => e.model === (model ?? 'gpt-5.4'));
    if (wanted?.active) return wanted;
    // An inactive or unknown model falls back to the reasoning endpoint, then to any active one.
    const fallback = chat.find(e => e.active && e.tier === 'reasoning') ?? chat.find(e => e.active);
    if (!fallback) throw new LlmCallError('rejected', 'No active chat endpoint is registered.');
    return fallback;
  };

  async function complete(messages: ModelMessage[], o: AgentChatOptions = {}): Promise<AgentCompletionResult> {
    const ep = chatEndpointFor(o.model);
    const estimate = estimateTokens(textOfMessages(messages)) + (o.maxOutputTokens ?? opts.defaultChatOutputTokens ?? 2000);
    const {value} = await call(ep, estimate, o.signal, async () => {
      const r = await platform.agent.complete(messages, {...o, model: ep.model as AgentChatOptions['model']});
      return {value: r, tokens: r.usage ? r.usage.inputTokens + r.usage.outputTokens : undefined};
    });
    return value;
  }

  const agent: AgentModel = {
    models: () => platform.agent.models(),
    chat: async (messages, o) => (await complete(messages, o)).text,
    complete,
    async *chatStream(messages: ModelMessage[], o: AgentChatOptions = {}): AsyncGenerator<LlmStreamChunk> {
      // A stream holds one slot for its whole length; it is not retried once it has started.
      const ep = chatEndpointFor(o.model);
      const estimate = estimateTokens(textOfMessages(messages)) + (o.maxOutputTokens ?? opts.defaultChatOutputTokens ?? 2000);
      const permit = await limiterFor(ep).acquire(estimate, o.signal);
      try {
        yield* platform.agent.chatStream(messages, {...o, model: ep.model as AgentChatOptions['model']});
      } finally {
        permit.release();
      }
    },
  };

  return {
    endpoints: purpose => registry.filter(e => !purpose || e.purpose === purpose),

    labelingEndpoints(): EndpointInfo[] {
      const infos = platform.models.endpoints();
      return infos.map(info => {
        const ep = registry.find(e => e.purpose === 'labeling' && e.slot === info.id);
        return ep ? {...info, priceIn: ep.priceIn, priceOut: ep.priceOut, supportsTemperature: ep.supportsTemperature} : info;
      });
    },

    async label(req: LabelCallRequest): Promise<LabelCallResult> {
      const ep = registry.find(e => e.purpose === 'labeling' && e.slot === req.slot);
      if (!ep) throw new LlmCallError('rejected', `No labeling endpoint is registered for Model ${req.slot}.`);
      const estimate = estimateTokens(textOfMessages(req.messages)) + req.maxOutputTokens;
      const {value, attempts} = await call(ep, estimate, req.signal, async () => {
        const r = await platform.models.chat({
          endpoint: req.slot,
          messages: req.messages,
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature,
          traceId: req.traceId,
          signal: req.signal,
        });
        return {value: r, tokens: r.inputTokens + r.outputTokens};
      });
      return {
        text: value.text,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        costUsd: costOf(ep, value.inputTokens, value.outputTokens),
        endpointId: ep.id,
        attempts,
      };
    },

    agentModel: () => agent,
  };
}

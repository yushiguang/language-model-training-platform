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
  NO_TELEMETRY,
  type TelemetryPort,
} from '@tsp/contracts';
import {estimateTokens, systemConfig} from '@tsp/domain';
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
  telemetry?: TelemetryPort;
}


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
  const tm = opts.telemetry ?? NO_TELEMETRY;
  // Endpoint ids and models are label values; only the registry's own may appear.
  tm.allowLabelValues('endpoint', registry.map(e => e.id));
  tm.allowLabelValues('model', registry.map(e => e.model));
  for (const ep of registry)
    for (const [kind, v] of [['qpm', ep.qpm], ['tpm', ep.tpm], ['concurrency', ep.maxConcurrency]] as const) tm.gauge('tsp_llm_endpoint_limit', v, {endpoint: ep.id, kind, assumed: ep.assumed});
  const delays = opts.retryDelaysMs ?? systemConfig().gateway.retryDelaysMs;
  const sleep = opts.sleep ?? abortableSleep;
  const limiters = new Map<string, EndpointLimiter>();
  const limiterFor = (ep: EndpointConfig) => {
    let l = limiters.get(ep.id);
    if (!l) {
      l = new EndpointLimiter({qpm: ep.qpm, tpm: ep.tpm, maxConcurrency: ep.maxConcurrency, windowMs: opts.windowMs ?? systemConfig().gateway.windowMs});
      limiters.set(ep.id, l);
    }
    return l;
  };

  const sample = (ep: EndpointConfig, l: EndpointLimiter) => {
    const st = l.stats();
    tm.gauge('tsp_llm_limiter_queue_length', st.waiting, {endpoint: ep.id});
    tm.gauge('tsp_llm_in_flight', st.inFlight, {endpoint: ep.id});
    tm.gauge('tsp_llm_concurrency_limit', st.concurrency, {endpoint: ep.id});
    tm.gauge('tsp_llm_qpm_used_ratio', ep.qpm ? st.requestsInWindow / ep.qpm : 0, {endpoint: ep.id});
    tm.gauge('tsp_llm_tpm_used_ratio', ep.tpm ? st.tokensInWindow / ep.tpm : 0, {endpoint: ep.id});
  };

  /** Runs one call under the endpoint's limiter, retrying busy or broken replies. */
  async function call<T>(ep: EndpointConfig, estimate: number, signal: AbortSignal | undefined, fn: () => Promise<{value: T; tokens?: number}>): Promise<{value: T; attempts: number}> {
    const purpose = ep.purpose;
    const started = Date.now();
    const done = (outcome: string) => {
      tm.counter('tsp_llm_calls_total', {endpoint: ep.id, purpose, outcome});
      tm.histogram('tsp_llm_call_duration_seconds', (Date.now() - started) / 1000, {endpoint: ep.id, purpose});
    };
    if (!ep.active) {
      done('rejected');
      throw new LlmCallError('rejected', `Endpoint ${ep.id} (${ep.model}) is not active.`);
    }
    tm.histogram('tsp_llm_request_tokens', estimate, {endpoint: ep.id, purpose});
    const limiter = limiterFor(ep);
    let last: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const asked = Date.now();
      let permit;
      try {
        permit = await limiter.acquire(estimate, signal);
      } catch (e) {
        done('aborted');
        throw e;
      }
      tm.histogram('tsp_llm_limiter_wait_seconds', (Date.now() - asked) / 1000, {endpoint: ep.id});
      sample(ep, limiter);
      const sent = Date.now();
      try {
        const {value, tokens} = await fn();
        permit.release(tokens);
        tm.counter('tsp_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose, outcome: 'ok'});
        tm.histogram('tsp_llm_request_duration_seconds', (Date.now() - sent) / 1000, {endpoint: ep.id, model: ep.model, purpose});
        sample(ep, limiter);
        done('ok');
        return {value, attempts: attempt + 1};
      } catch (e) {
        const kind = errorKindOf(e);
        // Slow down before giving the slot back: releasing first would let a queued call go out
        // during the hold. Also on the last attempt, so the next caller waits too.
        const retryAfter = e instanceof LlmCallError ? e.retryAfterMs : undefined;
        if (kind === 'rate_limited') limiter.onRateLimited(retryAfter ?? delays[Math.min(attempt, delays.length - 1)] ?? 1000);
        permit.release();
        sample(ep, limiter);
        tm.counter('tsp_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose, outcome: kind});
        tm.histogram('tsp_llm_request_duration_seconds', (Date.now() - sent) / 1000, {endpoint: ep.id, model: ep.model, purpose});
        if (kind === 'aborted') {
          done('aborted');
          throw e;
        }
        if (kind === 'filtered') {
          done('filtered');
          throw e;
        }
        if (kind === 'rejected') {
          done('rejected');
          throw e instanceof LlmCallError ? e : new LlmCallError('rejected', (e as Error).message ?? String(e));
        }
        last = e;
        if (attempt === delays.length) break;
        tm.counter('tsp_llm_retries_total', {endpoint: ep.id, purpose, reason: kind});
        await sleep(Math.max(delays[attempt], retryAfter ?? 0), signal);
      }
    }
    done('gave_up');
    const msg = (last as Error)?.message ?? String(last);
    throw new LlmCallError(errorKindOf(last), `${ep.model} didn't answer after ${delays.length + 1} tries. Last error: ${msg}`);
  }

  const usage = (ep: EndpointConfig, input: number, output: number, reasoning = 0) => {
    const l = {endpoint: ep.id, model: ep.model, purpose: ep.purpose};
    tm.counter('tsp_llm_tokens_total', {...l, kind: 'input'}, input);
    tm.counter('tsp_llm_tokens_total', {...l, kind: 'output'}, output);
    if (reasoning) tm.counter('tsp_llm_tokens_total', {...l, kind: 'reasoning'}, reasoning);
    tm.counter('tsp_llm_cost_usd_total', l, costOf(ep, input, output));
  };

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
      if (r.usage) usage(ep, r.usage.inputTokens, r.usage.outputTokens);
      return {value: r, tokens: r.usage ? r.usage.inputTokens + r.usage.outputTokens : undefined};
    });
    return value;
  }

  const agent: AgentModel = {
    models: () => platform.agent.models(),
    chat: async (messages, o) => (await complete(messages, o)).text,
    complete,
    async *chatStream(messages: ModelMessage[], o: AgentChatOptions = {}): AsyncGenerator<LlmStreamChunk> {
      // A stream holds one slot for its whole length. A busy or broken reply before the first
      // chunk is retried like any call (a 429 slows the endpoint down); once text has come
      // back it is not, so nothing is shown twice. The slot's tokens are corrected to what the
      // stream returned (about 4 characters a token; streams carry no usage).
      const ep = chatEndpointFor(o.model);
      const limiter = limiterFor(ep);
      const estimate = estimateTokens(textOfMessages(messages)) + (o.maxOutputTokens ?? opts.defaultChatOutputTokens ?? 2000);
      const input = estimateTokens(textOfMessages(messages));
      for (let attempt = 0; ; attempt++) {
        const permit = await limiter.acquire(estimate, o.signal);
        let chars = 0;
        let started = false;
        try {
          for await (const chunk of platform.agent.chatStream(messages, {...o, model: ep.model as AgentChatOptions['model']})) {
            started = true;
            if (chunk.type === 'delta') chars += chunk.text.length;
            if (chunk.type === 'thinking') chars += chunk.thinking.length;
            yield chunk;
          }
          permit.release(input + Math.ceil(chars / systemConfig().gateway.charsPerTokenEstimate));
          tm.counter('tsp_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose: ep.purpose, outcome: 'ok'});
          return;
        } catch (e) {
          const kind = errorKindOf(e);
          const retryAfter = e instanceof LlmCallError ? e.retryAfterMs : undefined;
          if (kind === 'rate_limited') limiter.onRateLimited(retryAfter ?? delays[Math.min(attempt, delays.length - 1)] ?? 1000);
          permit.release(started ? input + Math.ceil(chars / systemConfig().gateway.charsPerTokenEstimate) : undefined);
          tm.counter('tsp_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose: ep.purpose, outcome: kind});
          if (started || kind === 'aborted' || kind === 'rejected' || kind === 'filtered' || attempt >= delays.length) throw e;
          tm.counter('tsp_llm_retries_total', {endpoint: ep.id, purpose: ep.purpose, reason: kind});
          await sleep(Math.max(delays[attempt], retryAfter ?? 0), o.signal);
        }
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
        usage(ep, r.inputTokens, r.outputTokens);
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

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
  type LimiterStorePort,
  type LlmStreamChunk,
  type ModelMessage,
  type Platform,
  NO_TELEMETRY,
  type TelemetryPort,
} from '@yushiguang/sprint-contracts';
import {estimateTokens, systemConfig} from '@yushiguang/sprint-domain';
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
  /**
   * Where the limits are counted: shared by every replica in a server deployment
   * (`Platform.limiterStore`), or `memoryLimiterStore()` from `@yushiguang/sprint-platform` for one process.
   * Left out here, the platform's is used.
   */
  limiterStore?: LimiterStorePort;
  /** How often a waiting call asks the store again (default 250 ms; tests shorten it). */
  limiterPollMs?: number;
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

/** Reasoning tokens are billed at the output price. */
const costOf = (ep: EndpointConfig, inputTokens: number, outputTokens: number, reasoningTokens = 0) => (inputTokens * ep.priceIn + (outputTokens + reasoningTokens) * ep.priceOut) / 1e6;

/**
 * One try with its own signal: aborted with the caller's, or after `timeoutMs`. A try that runs
 * out of time rejects as `timeout` (retried like a busy reply), even when the model service
 * ignores the signal.
 */
async function withTimeout<T>(ep: EndpointConfig, timeoutMs: number | undefined, outer: AbortSignal | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!timeoutMs) return fn(outer);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) onAbort();
  outer?.addEventListener('abort', onAbort, {once: true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmCallError('timeout', `${ep.model} took longer than ${timeoutMs} ms.`));
      ctrl.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timedOut]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/**
 * The llm-gateway: every model call in the platform goes through here.
 * Stateless apart from one limiter per endpoint.
 */
export function createGateway(platform: Pick<Platform, 'models' | 'agent' | 'endpoints' | 'limiterStore'>, opts: GatewayOptions = {}): LlmGatewayContract {
  const registry = buildRegistry(platform);
  const store = opts.limiterStore ?? platform.limiterStore;
  if (!store) throw new Error('The gateway needs a limiter store (Platform.limiterStore, or memoryLimiterStore() for one process).');
  const tm = opts.telemetry ?? NO_TELEMETRY;
  // Endpoint ids and models are label values; only the registry's own may appear.
  tm.allowLabelValues('endpoint', registry.map(e => e.id));
  tm.allowLabelValues('model', registry.map(e => e.model));
  // Labeling endpoint ids are the `slot` label of product events (spec 5: no fixed list).
  tm.allowLabelValues('slot', platform.models.endpoints().map(e => e.id));
  for (const ep of registry)
    for (const [kind, v] of [['qpm', ep.qpm], ['tpm', ep.tpm], ['concurrency', ep.maxConcurrency]] as const) tm.gauge('sprint_llm_endpoint_limit', v, {endpoint: ep.id, kind, assumed: ep.assumed});
  const delays = opts.retryDelaysMs ?? systemConfig().gateway.retryDelaysMs;
  const sleep = opts.sleep ?? abortableSleep;
  const limiters = new Map<string, EndpointLimiter>();
  /**
   * Labeling calls by request id (spec 4.1: a caller stops calls by id, never with a signal). The
   * signal stays in this process. A cancel that arrives before its calls is kept for a while, so
   * a call that starts after it is stopped too.
   */
  const running = new Map<string, Set<AbortController>>();
  const cancelled = new Map<string, number>();
  const CANCEL_KEPT_MS = 60_000;
  const isCancelled = (id: string) => {
    const at = cancelled.get(id);
    if (at != null && Date.now() - at > CANCEL_KEPT_MS) cancelled.delete(id);
    return cancelled.has(id);
  };
  async function stoppable<T>(requestId: string | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (!requestId) return fn();
    if (isCancelled(requestId)) throw new DOMException('Stopped', 'AbortError');
    const ctrl = new AbortController();
    const set = running.get(requestId) ?? new Set();
    set.add(ctrl);
    running.set(requestId, set);
    try {
      return await fn(ctrl.signal);
    } finally {
      set.delete(ctrl);
      if (!set.size) running.delete(requestId);
    }
  }
  const limiterFor = (ep: EndpointConfig) => {
    let l = limiters.get(ep.id);
    if (!l) {
      l = new EndpointLimiter({store, key: ep.id, qpm: ep.qpm, tpm: ep.tpm, maxConcurrency: ep.maxConcurrency, windowMs: opts.windowMs ?? systemConfig().gateway.windowMs, pollMs: opts.limiterPollMs});
      limiters.set(ep.id, l);
    }
    return l;
  };

  /** The endpoint's gauges, across every process sharing the store (read in the background). */
  const sample = (ep: EndpointConfig, l: EndpointLimiter) =>
    void l.stats().then(
      st => {
        tm.gauge('sprint_llm_limiter_queue_length', st.waiting, {endpoint: ep.id});
        tm.gauge('sprint_llm_in_flight', st.inFlight, {endpoint: ep.id});
        tm.gauge('sprint_llm_concurrency_limit', st.concurrency, {endpoint: ep.id});
        tm.gauge('sprint_llm_qpm_used_ratio', ep.qpm ? st.requestsInWindow / ep.qpm : 0, {endpoint: ep.id});
        tm.gauge('sprint_llm_tpm_used_ratio', ep.tpm ? st.tokensInWindow / ep.tpm : 0, {endpoint: ep.id});
      },
      () => undefined,
    );

  /** Runs one call under the endpoint's limiter, retrying busy or broken replies. */
  async function call<T>(ep: EndpointConfig, estimate: number, signal: AbortSignal | undefined, fn: (signal?: AbortSignal) => Promise<{value: T; tokens?: number}>, timeoutMs?: number): Promise<{value: T; attempts: number}> {
    const purpose = ep.purpose;
    const started = Date.now();
    const done = (outcome: string) => {
      tm.counter('sprint_llm_calls_total', {endpoint: ep.id, purpose, outcome});
      tm.histogram('sprint_llm_call_duration_seconds', (Date.now() - started) / 1000, {endpoint: ep.id, purpose});
    };
    if (!ep.active) {
      done('rejected');
      throw new LlmCallError('rejected', `Endpoint ${ep.id} (${ep.model}) is not active.`);
    }
    tm.histogram('sprint_llm_request_tokens', estimate, {endpoint: ep.id, purpose});
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
      tm.histogram('sprint_llm_limiter_wait_seconds', (Date.now() - asked) / 1000, {endpoint: ep.id});
      sample(ep, limiter);
      const sent = Date.now();
      try {
        const {value, tokens} = await withTimeout(ep, timeoutMs, signal, fn);
        permit.release(tokens);
        tm.counter('sprint_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose, outcome: 'ok'});
        tm.histogram('sprint_llm_request_duration_seconds', (Date.now() - sent) / 1000, {endpoint: ep.id, model: ep.model, purpose});
        sample(ep, limiter);
        done('ok');
        return {value, attempts: attempt + 1};
      } catch (e) {
        const kind = errorKindOf(e);
        // Slow down before giving the slot back: releasing first would let a queued call go out
        // during the hold. Also on the last attempt, so the next caller waits too.
        const retryAfter = e instanceof LlmCallError ? e.retryAfterMs : undefined;
        if (kind === 'rate_limited') await limiter.onRateLimited(retryAfter ?? delays[Math.min(attempt, delays.length - 1)] ?? 1000).catch(() => undefined);
        permit.release();
        sample(ep, limiter);
        tm.counter('sprint_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose, outcome: kind});
        tm.histogram('sprint_llm_request_duration_seconds', (Date.now() - sent) / 1000, {endpoint: ep.id, model: ep.model, purpose});
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
        tm.counter('sprint_llm_retries_total', {endpoint: ep.id, purpose, reason: kind});
        await sleep(Math.max(delays[attempt], retryAfter ?? 0), signal);
      }
    }
    done('gave_up');
    const msg = (last as Error)?.message ?? String(last);
    throw new LlmCallError(errorKindOf(last), `${ep.model} didn't answer after ${delays.length + 1} tries. Last error: ${msg}`);
  }

  const usage = (ep: EndpointConfig, input: number, output: number, reasoning = 0) => {
    const l = {endpoint: ep.id, model: ep.model, purpose: ep.purpose};
    tm.counter('sprint_llm_tokens_total', {...l, kind: 'input'}, input);
    tm.counter('sprint_llm_tokens_total', {...l, kind: 'output'}, output);
    if (reasoning) tm.counter('sprint_llm_tokens_total', {...l, kind: 'reasoning'}, reasoning);
    tm.counter('sprint_llm_cost_usd_total', l, costOf(ep, input, output, reasoning));
  };

  /**
   * The options as the chat endpoint's model can take them: a reasoning effort it does not list is
   * dropped; native tools on a model without them are refused.
   */
  const fitOptions = (ep: EndpointConfig, o: AgentChatOptions): AgentChatOptions => {
    const caps = ep.capabilities;
    if (o.tools?.length && caps && !caps.tools) throw new LlmCallError('rejected', `${ep.model} cannot call tools natively.`);
    const {reasoningEffort, ...rest} = o;
    const effort = reasoningEffort && (!caps || caps.reasoningEffort.includes(reasoningEffort)) ? {reasoningEffort} : {};
    return {...rest, ...effort, model: ep.model};
  };

  const chatEndpointFor = (model?: string): EndpointConfig => {
    const chat = registry.filter(e => e.purpose === 'chat');
    const wanted = model ? chat.find(e => e.model === model) : undefined;
    if (wanted?.active) return wanted;
    // No model, or an inactive or unknown one: an active reasoning endpoint, then any active one.
    const fallback = chat.find(e => e.active && e.tier === 'reasoning') ?? chat.find(e => e.active);
    if (!fallback) throw new LlmCallError('rejected', 'No active chat endpoint is registered.');
    return fallback;
  };

  async function complete(messages: ModelMessage[], o: AgentChatOptions = {}): Promise<AgentCompletionResult> {
    const ep = chatEndpointFor(o.model);
    const fitted = fitOptions(ep, o);
    const estimate = estimateTokens(textOfMessages(messages)) + (o.maxOutputTokens ?? opts.defaultChatOutputTokens ?? 2000);
    const {value} = await call(
      ep,
      estimate,
      o.signal,
      async signal => {
        const r = await platform.agent.complete(messages, {...fitted, signal});
        const u = r.usage;
        if (u) usage(ep, u.inputTokens, u.outputTokens, u.reasoningTokens ?? 0);
        return {value: r, tokens: u ? u.inputTokens + u.outputTokens + (u.reasoningTokens ?? 0) : undefined};
      },
      o.timeoutMs,
    );
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
      // Native tools are for `complete`; a stream carries text and thinking only.
      const fitted = fitOptions(ep, {...o, tools: undefined});
      const limiter = limiterFor(ep);
      const estimate = estimateTokens(textOfMessages(messages)) + (o.maxOutputTokens ?? opts.defaultChatOutputTokens ?? 2000);
      const input = estimateTokens(textOfMessages(messages));
      for (let attempt = 0; ; attempt++) {
        const permit = await limiter.acquire(estimate, o.signal);
        let chars = 0;
        let started = false;
        try {
          for await (const chunk of platform.agent.chatStream(messages, fitted)) {
            started = true;
            if (chunk.type === 'delta') chars += chunk.text.length;
            if (chunk.type === 'thinking') chars += chunk.thinking.length;
            yield chunk;
          }
          permit.release(input + Math.ceil(chars / systemConfig().gateway.charsPerTokenEstimate));
          tm.counter('sprint_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose: ep.purpose, outcome: 'ok'});
          return;
        } catch (e) {
          const kind = errorKindOf(e);
          const retryAfter = e instanceof LlmCallError ? e.retryAfterMs : undefined;
          if (kind === 'rate_limited') await limiter.onRateLimited(retryAfter ?? delays[Math.min(attempt, delays.length - 1)] ?? 1000).catch(() => undefined);
          permit.release(started ? input + Math.ceil(chars / systemConfig().gateway.charsPerTokenEstimate) : undefined);
          tm.counter('sprint_llm_requests_total', {endpoint: ep.id, model: ep.model, purpose: ep.purpose, outcome: kind});
          if (started || kind === 'aborted' || kind === 'rejected' || kind === 'filtered' || attempt >= delays.length) throw e;
          tm.counter('sprint_llm_retries_total', {endpoint: ep.id, purpose: ep.purpose, reason: kind});
          await sleep(Math.max(delays[attempt], retryAfter ?? 0), o.signal);
        } finally {
          // The consumer can close this generator at the yield above (it throws on an error
          // chunk, or stops reading): then neither release above runs, and the permit's lease
          // would be renewed indefinitely. Release is idempotent, so this is a no-op otherwise.
          permit.release(started ? input + Math.ceil(chars / systemConfig().gateway.charsPerTokenEstimate) : undefined);
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
      const {value, attempts} = await stoppable(req.requestId, outer =>
        call(
          ep,
          estimate,
          outer,
          async signal => {
            const r = await platform.models.chat({
              endpoint: req.slot,
              messages: req.messages,
              maxOutputTokens: req.maxOutputTokens,
              temperature: req.temperature,
              traceId: req.traceId,
              ...(req.reasoningEffort ? {reasoningEffort: req.reasoningEffort} : {}),
              ...(req.responseFormat ? {responseFormat: req.responseFormat} : {}),
              ...(req.timeoutMs ? {timeoutMs: req.timeoutMs} : {}),
              signal,
            });
            usage(ep, r.inputTokens, r.outputTokens, r.reasoningTokens ?? 0);
            return {value: r, tokens: r.inputTokens + r.outputTokens + (r.reasoningTokens ?? 0)};
          },
          req.timeoutMs,
        ),
      );
      const reasoningTokens = value.reasoningTokens ?? 0;
      return {
        text: value.text,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        reasoningTokens,
        costUsd: costOf(ep, value.inputTokens, value.outputTokens, reasoningTokens),
        endpointId: ep.id,
        attempts,
      };
    },

    async cancel(requestId) {
      cancelled.set(requestId, Date.now());
      if (cancelled.size > 1000) cancelled.delete(cancelled.keys().next().value!);
      for (const ctrl of running.get(requestId) ?? []) ctrl.abort();
    },

    agentModel: () => agent,
  };
}

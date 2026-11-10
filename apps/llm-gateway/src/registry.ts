import type {EndpointConfig, ModelTier, Platform} from '@tsp/contracts';

/**
 * Assumed limits per model, used until an endpoint is registered with its real QPM/TPM.
 * Values are deliberately conservative; the limiter also backs off on its own after a 429.
 * `maxConcurrency` is our own cap on calls in flight, not a platform limit.
 */
export const ASSUMED_LIMITS: Record<string, {tier: ModelTier; qpm: number; tpm: number; maxConcurrency: number}> = {
  'gpt-5.4': {tier: 'fast', qpm: 240, tpm: 800_000, maxConcurrency: 24},
  'gpt-5.6-luna': {tier: 'balanced', qpm: 120, tpm: 500_000, maxConcurrency: 16},
  'gpt-5.6-terra': {tier: 'reasoning', qpm: 60, tpm: 300_000, maxConcurrency: 8},
  'gpt-5.5': {tier: 'balanced', qpm: 0, tpm: 0, maxConcurrency: 0},
};

/** Fallback for a model we have no entry for: the most conservative tier. */
const UNKNOWN_MODEL = {tier: 'reasoning' as ModelTier, qpm: 60, tpm: 300_000, maxConcurrency: 8};

const limitsFor = (model: string) => ASSUMED_LIMITS[model] ?? UNKNOWN_MODEL;

/**
 * Builds the endpoint registry: registered endpoints from the platform first, then one assumed
 * entry per labeling slot and per chat model that is not registered yet.
 */
export function buildRegistry(platform: Pick<Platform, 'models' | 'agent' | 'endpoints'>): EndpointConfig[] {
  const registered = platform.endpoints ?? [];
  const out: EndpointConfig[] = [...registered];

  for (const info of platform.models.endpoints()) {
    if (registered.some(e => e.purpose === 'labeling' && e.slot === info.id)) continue;
    const l = limitsFor(info.name);
    out.push({
      id: `labeling-${info.id}`,
      purpose: 'labeling',
      model: info.name,
      tier: l.tier,
      slot: info.id,
      qpm: l.qpm,
      tpm: l.tpm,
      maxConcurrency: l.maxConcurrency,
      priceIn: info.priceIn,
      priceOut: info.priceOut,
      supportsTemperature: info.supportsTemperature,
      active: l.qpm > 0,
      assumed: true,
    });
  }

  for (const m of platform.agent.models()) {
    if (registered.some(e => e.purpose === 'chat' && e.model === m.id)) continue;
    const l = limitsFor(m.id);
    out.push({
      id: `chat-${m.id}`,
      purpose: 'chat',
      model: m.id,
      tier: m.tier,
      qpm: l.qpm,
      tpm: l.tpm,
      maxConcurrency: l.maxConcurrency,
      priceIn: m.priceIn,
      priceOut: m.priceOut,
      supportsTemperature: m.supportsTemperature,
      active: m.available && l.qpm > 0,
      assumed: true,
    });
  }
  return out;
}

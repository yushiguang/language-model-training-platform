import type {EndpointConfig, Platform} from '@tsp/contracts';
import {systemConfig} from '@tsp/domain';

/**
 * Assumed limits per model, used until an endpoint is registered with its real QPM/TPM
 * (`SystemConfig.gateway.assumedLimits`). Values are deliberately conservative; the limiter also
 * backs off on its own after a 429. A model with no entry gets the most conservative tier.
 */
const limitsFor = (model: string) => systemConfig().gateway.assumedLimits[model] ?? systemConfig().gateway.unknownModelLimits;

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

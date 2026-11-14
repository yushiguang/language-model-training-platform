import type {DeepPartial, SystemConfig} from '@tsp/contracts';

/** The defaults of every tunable number (spec 1.0.0, section 7.4). */
export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  evaluation: {defaultMacroF1: 0.8, customStartValueF1: 0.6, customStartPrecision: 0.7, customStartRecall: 0.7, invalidRateCap: 0.01},
  dataset: {minEvalHard: 4, minEvalRecommended: 20, rareValueMinCount: 4, rareValuePerHalfMin: 2, dominantValueShareWarn: 0.7, dominantWarnMinLabeled: 30},
  optimiser: {
    defaultMaxRounds: 10,
    maxRoundsCap: 50,
    stepRetries: 3,
    wastedRoundsLimit: 3,
    consecutiveTiesLimit: 2,
    mergeEveryKept: 2,
    dryRunMaxExamples: 20,
    lowestFieldWeight: 2,
    briefWrongExamples: 8,
    briefMergeWins: 4,
    briefMaxImages: 2,
    briefFeatureMaxChars: 300,
  },
  labeling: {defaultParallel: 4, maxFailedShare: 0.05, maxFailedInARow: 20, stopCheckMs: 2000, reasonMaxChars: 300, commentMaxChars: 500},
  gateway: {
    assumedLimits: {
      'gpt-5.4': {tier: 'fast', qpm: 240, tpm: 800_000, maxConcurrency: 24},
      'gpt-5.6-luna': {tier: 'balanced', qpm: 120, tpm: 500_000, maxConcurrency: 16},
      'gpt-5.6-terra': {tier: 'reasoning', qpm: 60, tpm: 300_000, maxConcurrency: 8},
      'gpt-5.5': {tier: 'balanced', qpm: 0, tpm: 0, maxConcurrency: 0},
    },
    unknownModelLimits: {tier: 'reasoning', qpm: 60, tpm: 300_000, maxConcurrency: 8},
    windowMs: 60_000,
    retryDelaysMs: [2000, 4000, 8000, 16000],
    imageTokensEstimate: 800,
    charsPerTokenEstimate: 4,
    evalOutputTokensEstimate: 150,
  },
  agent: {maxToolCalls: 4, maxToolResultChars: 12_000, recentHistoryCount: 8, maxDocChars: 20_000, maxAttachmentChars: 8_000, tryTemplateMaxExamples: 5},
  ui: {activePollMs: 5000, sweepMs: 60_000, changeDebounceMs: 120, minActionPendingMs: 220},
  project: {nameMaxChars: 80},
  reports: {diagnosticsKeep: 10, actionLines: 15, messageMaxChars: 300},
};

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `base` with every value given in `over` replaced; arrays are replaced whole, objects merged by key. */
export function mergeConfig<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over as T;
  const out: Record<string, unknown> = {...base};
  for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = mergeConfig(out[k], v as never);
  return out as T;
}

let current: SystemConfig = DEFAULT_SYSTEM_CONFIG;

/** The configuration in force. Read it at the time of use, never at import time. */
export const systemConfig = (): SystemConfig => current;

/**
 * Sets the configuration: the defaults with `overrides` on top. The composition root calls it once
 * at startup with `Platform.config`; tests call it with nothing to go back to the defaults.
 */
export function configureSystem(overrides?: DeepPartial<SystemConfig>): SystemConfig {
  current = mergeConfig(DEFAULT_SYSTEM_CONFIG, overrides);
  return current;
}

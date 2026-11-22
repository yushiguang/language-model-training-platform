import type {ConfigReader, DeepPartial, JobLimitTarget, SystemConfig} from '@yushiguang/sprint-contracts';

/** The defaults of every tunable number (spec 1.0.0, section 7.4). */
export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  evaluation: {defaultMacroF1: 0.8, customStartValueF1: 0.6, customStartPrecision: 0.7, customStartRecall: 0.7, invalidRateCap: 0.01},
  dataset: {minEvalHard: 4, minEvalRecommended: 20, rareValueMinCount: 4, rareValuePerHalfMin: 2, dominantValueShareWarn: 0.7, dominantWarnMinLabeled: 30, featureBatch: 50, overflowFieldBytes: 100_000},
  optimiser: {
    defaultMaxRounds: 10,
    maxRoundsCap: 50,
    stepRetries: 3,
    wastedRoundsLimit: 3,
    mergeEveryKept: 2,
    dryRunMaxExamples: 20,
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
  jobs: {limit: {model: 1, compute: 10}},
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

/**
 * Keys of the configuration platform (docs/design/server.md, 7): one per leaf of `SystemConfig`,
 * its path with dots (`labeling.maxFailedShare`). A leaf is a number, a string, or JSON (an array,
 * or a map whose keys are not fixed, such as `gateway.assumedLimits`).
 */
const JSON_LEAVES = new Set(['gateway.assumedLimits']);

function leaves(node: unknown, prefix: string, out: Array<[string, unknown]>): Array<[string, unknown]> {
  if (isPlain(node) && !JSON_LEAVES.has(prefix)) for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  else out.push([prefix, node]);
  return out;
}

/** Every process-level key, in a fixed order. */
export const systemConfigKeys = (): string[] => leaves(DEFAULT_SYSTEM_CONFIG, '', []).map(([k]) => k);

const TIERS = new Set(['fast', 'balanced', 'reasoning']);
const isLimitNumber = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isModelLimits = (x: unknown) => isPlain(x) && TIERS.has(x.tier as string) && isLimitNumber(x.qpm) && isLimitNumber(x.tpm) && isLimitNumber(x.maxConcurrency);

/**
 * Keys whose values need more than their type: the job limits are whole numbers of at least 1,
 * a model tier is one of three, and every entry of the assumed limits is a whole `ModelLimits`,
 * since the gateway reads them without checking again.
 */
const STRICT: Record<string, (raw: string) => unknown> = {
  'jobs.limit.model': raw => parseJobLimit(raw) ?? undefined,
  'jobs.limit.compute': raw => parseJobLimit(raw) ?? undefined,
  'gateway.unknownModelLimits.tier': raw => (TIERS.has(raw.trim()) ? raw.trim() : undefined),
  'gateway.assumedLimits': raw => {
    const v = parseLike({}, raw);
    return isPlain(v) && Object.values(v).every(isModelLimits) ? v : undefined;
  },
};

/** `raw` parsed like `sample` (the default), or undefined when it is not a valid value of that type. */
function parseLike(sample: unknown, raw: string): unknown {
  if (typeof sample === 'number') {
    const n = raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof sample === 'string') return raw.trim() === '' ? undefined : raw.trim();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (Array.isArray(sample)) return Array.isArray(v) && v.every(x => sample.length === 0 || typeof x === typeof sample[0]) ? v : undefined;
  return isPlain(v) ? v : undefined;
}

/**
 * The overrides that `values` (key to raw string, from the configuration platform) give. Unset
 * keys (null) are left out; a value that does not parse as its type is left out too and named in
 * `invalid`, so one bad entry never breaks the rest.
 */
export function parseSystemConfig(values: Record<string, string | null | undefined>): {overrides: DeepPartial<SystemConfig>; invalid: string[]} {
  const overrides: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [key, sample] of leaves(DEFAULT_SYSTEM_CONFIG, '', [])) {
    const raw = values[key];
    if (raw === null || raw === undefined) continue;
    const v = STRICT[key] ? STRICT[key](raw) : parseLike(sample, raw);
    if (v === undefined) {
      invalid.push(key);
      continue;
    }
    const path = key.split('.');
    let at = overrides;
    for (const p of path.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[path[path.length - 1]] = v;
  }
  return {overrides: overrides as DeepPartial<SystemConfig>, invalid};
}

/** A tenant's key for a logical key: `tenant.<tenantId>.<key>`. */
export const tenantKey = (tenantId: string, key: string): string => `tenant.${tenantId}.${key}`;

/**
 * The keys a job limit is looked up under, first match wins (docs/design/server.md, 7); the
 * process-level value (`systemConfig().jobs.limit`) comes after them. Without a tenant, none.
 */
export function jobLimitKeys(tenantId: string | undefined, target: JobLimitTarget): string[] {
  if (!tenantId) return [];
  return target.kind === 'model'
    ? [tenantKey(tenantId, `jobs.limit.endpoint.${target.endpointId}`), tenantKey(tenantId, 'jobs.limit.model')]
    : [tenantKey(tenantId, 'jobs.limit.compute')];
}

/** A job limit as written in the configuration: a whole number of at least 1, or null. */
export function parseJobLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

/** The process-level job limit, once no tenant key matched. */
export const processJobLimit = (target: JobLimitTarget): number => systemConfig().jobs.limit[target.kind];

/**
 * A `ConfigReader` with no configuration platform: tenants have no keys of their own, so every
 * tenant gets the process-level values. What the job module and the workflow use when nothing is
 * injected (tests, and the browser build before the composition root wires one).
 */
export const processConfigReader = (): ConfigReader => ({
  forTenant: () => ({get: async () => null, jobLimit: async target => processJobLimit(target)}),
});

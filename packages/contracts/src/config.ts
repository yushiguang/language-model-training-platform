/**
 * Every tunable number of the system in one typed struct (spec 1.0.0, section 7.4). The defaults
 * live in `@tsp/domain` (`DEFAULT_SYSTEM_CONFIG`); a hosting adapter overrides any of them through
 * `Platform.config`, merged at startup. Plain JSON, so it maps 1:1 to an IDL struct.
 */
export interface ModelLimits {
  tier: 'fast' | 'balanced' | 'reasoning';
  qpm: number;
  tpm: number;
  /** Our own cap on calls in flight, not a platform limit. */
  maxConcurrency: number;
}

export interface SystemConfig {
  evaluation: {
    /** Default pass rule: Macro-F1 of every field must reach this. */
    defaultMacroF1: number;
    customStartValueF1: number;
    customStartPrecision: number;
    customStartRecall: number;
    /** Share of answers that may be left out (invalid) before the score is refused. */
    invalidRateCap: number;
  };
  dataset: {
    /** Fewest eval examples a project can work with (1.0.0 gate). */
    minEvalHard: number;
    /** Below this many scored examples a score is a rough reading. */
    minEvalRecommended: number;
    rareValueMinCount: number;
    rareValuePerHalfMin: number;
    dominantValueShareWarn: number;
    dominantWarnMinLabeled: number;
  };
  optimiser: {
    defaultMaxRounds: number;
    maxRoundsCap: number;
    /** Tries of one step before the run fails. */
    stepRetries: number;
    wastedRoundsLimit: number;
    consecutiveTiesLimit: number;
    /** A merge is tried after this many kept versions. */
    mergeEveryKept: number;
    dryRunMaxExamples: number;
    lowestFieldWeight: number;
    briefWrongExamples: number;
    briefMergeWins: number;
    briefMaxImages: number;
    briefFeatureMaxChars: number;
  };
  labeling: {
    defaultParallel: number;
    maxFailedShare: number;
    maxFailedInARow: number;
    stopCheckMs: number;
    reasonMaxChars: number;
    commentMaxChars: number;
  };
  gateway: {
    /** Limits assumed per model until an endpoint is registered with its real ones. */
    assumedLimits: Record<string, ModelLimits>;
    /** Limits for a model with no entry: the most conservative tier. */
    unknownModelLimits: ModelLimits;
    windowMs: number;
    retryDelaysMs: number[];
    imageTokensEstimate: number;
    charsPerTokenEstimate: number;
    evalOutputTokensEstimate: number;
  };
  agent: {
    maxToolCalls: number;
    maxToolResultChars: number;
    recentHistoryCount: number;
    maxDocChars: number;
    maxAttachmentChars: number;
    tryTemplateMaxExamples: number;
  };
  ui: {
    activePollMs: number;
    sweepMs: number;
    changeDebounceMs: number;
    minActionPendingMs: number;
  };
}

export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? {[K in keyof T]?: DeepPartial<T[K]>} : T;

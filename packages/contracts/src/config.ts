/**
 * Every tunable number of the system in one typed struct (spec 1.0.0, section 7.4). The defaults
 * live in `@yushiguang/sprint-domain` (`DEFAULT_SYSTEM_CONFIG`); a hosting adapter overrides any of them through
 * `Platform.config` and the configuration platform (`ConfigPort`, one string key per leaf, such as
 * `labeling.maxFailedShare`). Plain JSON, so it maps 1:1 to an IDL struct.
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
    /** Items per batch when items are checked and their features fetched (#32). */
    featureBatch: number;
    /**
     * A feature field larger than this (bytes of JSON) goes to object storage, the document keeping
     * its URI (#32). Applied by a server document store adapter; set from the size report
     * (`scripts/feature-size-report.mjs`).
     */
    overflowFieldBytes: number;
  };
  optimiser: {
    defaultMaxRounds: number;
    maxRoundsCap: number;
    /** Tries of one step before the run fails. */
    stepRetries: number;
    wastedRoundsLimit: number;
    /** A merge is tried after this many kept versions. */
    mergeEveryKept: number;
    dryRunMaxExamples: number;
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
    /**
     * How long the gateway keeps a tenant's models before reading them again (docs/design/server.md,
     * 9). A model id it has not seen is read at once, so a new model works immediately.
     */
    tenantModelsTtlMs: number;
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
  project: {
    /** A project name is cut at this many characters (spec 1.1.0, 1.2). */
    nameMaxChars: number;
  };
  jobs: {
    /**
     * How many jobs of one concurrency key run at once (docs/design/server.md, 5.1 and 7): model
     * tasks per tenant and endpoint, compute-only tasks per tenant. A tenant may override both
     * through the configuration platform (`TenantConfig.jobLimit`).
     */
    limit: {model: number; compute: number};
  };
  reports: {
    /** How many pages, failed calls and script errors the browser keeps for a problem report. */
    diagnosticsKeep: number;
    /** How many recent Ask AI action lines a ticket carries. */
    actionLines: number;
    /** Script error and failed-call messages are cut at this many characters. */
    messageMaxChars: number;
  };
  tenant: {
    /** Minimum admins a tenant starts with and keeps (raise when the permission platform needs multiple owners). */
    minAdmins: number;
  };
}

export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? {[K in keyof T]?: DeepPartial<T[K]>} : T;

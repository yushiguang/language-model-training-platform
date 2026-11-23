/**
 * Domain types. Every entity except Project is immutable once written: a change makes a new
 * record that points at what it was built from (see docs/architecture.md, "Data model").
 */

export type ExampleType = 'video' | 'photo_text';
/** How many values an answer may hold (2026-11-16 resilience spec, 1): one, or min..max. */
export type LabelKind = 'single' | 'multi';
export type FeatureGroup = ExampleType | 'metadata';
export type Split = 'eval' | 'test' | 'train';
/**
 * A labeling endpoint's id, as the registry names it (deployment readiness spec, 5). Opaque: the
 * stand-ins register `A` and `B`; a hosting platform registers its own.
 */
export type EndpointId = string;
export type Actor = 'user' | 'prompt_agent' | 'optimiser' | 'system';

export interface LabelValue {
  name: string;
  /**
   * Everything that says when this value applies or does not (2026-11-16): criteria, thresholds,
   * sub-cases, exclusions and exemptions. Multi-line: lists and paragraphs.
   */
  definition: string;
  /**
   * Multi-select only: this value stands alone, so an answer holding it holds nothing else (for
   * example a catch-all "None"). Ignored on a single-select label.
   */
  exclusive?: boolean;
}

/**
 * The project's one label (2026-11-16, single-label projects): its key in the model's JSON answer
 * and its values (at least 2). A single-select label takes exactly one value per answer; a
 * multi-select label takes `min` to `max` values from the same list (resilience spec, 1). Unrelated
 * dimensions are separate projects. There is no separate policy text: each value's definition and
 * the rule groups carry the rules.
 */
export interface Schema {
  /** The JSON key for this project's label, e.g. "category" or "topics". */
  name: string;
  kind: LabelKind;
  /** Multi-select only: the fewest and most values an answer may hold (defaults 1 and all). */
  min?: number;
  max?: number;
  values: LabelValue[];
}

/**
 * What an answer may hold: the label's key, its kind and bounds, its value names in order and which
 * of them stand alone. No wording.
 * `schemaVersion` bumps only when this changes, so refining a definition never touches gold labels
 * or scores.
 */
export interface LabelSignature {
  name: string;
  kind: LabelKind;
  min?: number;
  max?: number;
  values: string[];
  /** Multi-select values that stand alone. Missing when there are none. */
  exclusive?: string[];
}

/**
 * A user-named group of rules (2026-11-16 refinements, 2.3), for example "Label priority" or
 * "Input handling". Replaces the one fixed general-rules box and the per-field notes.
 */
export interface RuleGroup {
  id: string;
  /** The group's title, as the user named it. */
  title: string;
  /** Free multi-line text: paragraphs, numbered or bulleted rules. */
  content: string;
}

/**
 * A prompt as the user edits it (1.0.0): parts, not free text. `compilePrompt` in `@yushiguang/sprint-domain`
 * turns it into the text the model reads, the same way every time. Stored on every version.
 */
export interface StructuredPrompt {
  /** One or two sentences: what is being classified and why. */
  taskSummary: string;
  features: FeatureSelection;
  /** The project's one label: its key, single or multi select, and its values with definitions. */
  label: Schema;
  /** The rules, in the user's own named groups, in order. Empty on a new prompt. */
  ruleGroups: RuleGroup[];
  images: PromptImage[];
}

/**
 * One answer: the chosen values of the project's label, in label order. One item on a single-select
 * label, `min` to `max` unique items on a multi-select one (resilience spec, 1). Answers stored as a
 * plain string earlier on 2026-11-16 are read through `asAnswer`.
 */
export type Answer = string[];

export interface Thresholds {
  mode: 'default' | 'custom';
  /** Always on: the main score. The label's macro-F1 must reach it. */
  macroF1: number;
  /** Per value. null = off. */
  valueF1: number | null;
  /** Per value (added 2026-11-06). Missing on older records = off. */
  precision?: number | null;
  recall?: number | null;
  /** Not shown in the MVP UI (2026-11-04); kept for older records. */
  invalidRate: number | null;
  accuracy: number | null;
  minEval: number;
}

/** Project Settings: the pass rule and the labeling model. Not a workflow step. */
export interface ProjectSettings {
  thresholds: Thresholds;
  model: ModelSettings;
}

export interface ModelSettings {
  endpoint: EndpointId;
  maxOutputTokens: number;
  /** null when the model does not support temperature. */
  temperature: number | null;
  /**
   * A second labeling of the same examples (2): the Optimiser's confirmation of a pass. It is part
   * of the answers' key, so the answers are fresh; never sent to the model.
   */
  pass?: number;
}

export interface SetupVersion {
  id: string;
  projectId: string;
  number: number;
  /** Bumps only when the schema changes; labels and reports are tied to it. */
  schemaVersion: number;
  task: string;
  schema: Schema | null;
  /** null = no evaluation. */
  thresholds: Thresholds | null;
  models: ModelSettings[];
  steps: {schema: boolean; evaluation: boolean; models: boolean};
  createdAt: string;
  createdBy: string;
}

/** The four steps of a Prompt Tuning project. */
export type NodeId = 'prompt_design' | 'dataset' | 'gold' | 'prompt';

/**
 * `prompt_tuning`: the 4-step project built in 1.0.0. `batch_labeling`: large-scale labeling with
 * a tuned prompt (contracts only in 1.0.0; no pages yet).
 */
export type ProjectKind = 'prompt_tuning' | 'batch_labeling';

export interface Project {
  id: string;
  /**
   * The tenant that owns the project (docs/design/server.md, 2): every read and write by
   * `projectId` checks it against the caller's `ctx.tenantId`. Records saved before it existed
   * are given `DEFAULT_TENANT` the first time a workflow instance reads projects.
   */
  tenantId: string;
  name: string;
  createdAt: string;
  /** The creator's display name, as the Projects list shows it. */
  createdBy: string;
  /** The creator's user id (spec 1.1.0, 1.1): for ownership checks once tenants exist. */
  createdById?: string;
  /** Missing on records made before 1.0.0: `prompt_tuning`. */
  kind?: ProjectKind;
  /** Batch labeling only: the Prompt Tuning project and version it labels with. */
  sourceProjectId?: string | null;
  sourcePromptVersionId?: string | null;
  /** The user has seen and saved Project Settings (asked once, before the first paid run). */
  settingsConfirmed?: boolean;
  /**
   * A helper or the Optimiser has read examples of this project (spec 1.0.0, 4.2). From then on no
   * example's half ever changes; before it, halves may be balanced again by gold label.
   */
  holdoutLocked?: boolean;
  /**
   * Delete project was accepted: no read returns the project any more, and a `project.delete` job
   * removes its records (deployment readiness spec, 3).
   */
  deleting?: boolean;
  setupVersionId: string | null;
  snapshotId: string | null;
  /** Nodes whose Next step was pressed. Code moves the workflow, never the agent. */
  approvedNodes: NodeId[];
}

/**
 * One feature of an example (spec 1.0.0, 7.1): plain text, or a list (image URLs, hashtags).
 * An explicit struct instead of a `string | string[]` union, so it maps to an IDL. Read it with
 * `featureText` / `featureItems` from `@yushiguang/sprint-domain`.
 */
export interface FeatureValue {
  text?: string;
  items?: string[];
}

export interface Example {
  id: string;
  snapshotId: string;
  /**
   * The sample number in its dataset (docs/design/server.md 4.2): from 1, in the order examples
   * were added, and never changed: removing an example leaves the others' numbers as they are,
   * and label sets are ranges of these numbers. An example whose save failed leaves its number
   * unused. Missing on examples saved before numbers; the workflow numbers them on first read
   * (see `DatasetSnapshot.numbered`).
   */
  number?: number;
  externalId: string;
  type: ExampleType;
  title: string;
  split: Split | null;
  /** Eval examples only: true = the optimiser may learn from it; false = held out for scoring. */
  optimiserHalf: boolean;
  /** Removed from the eval dataset (soft delete, spec 1.0.0, 4.4): its `DatasetRemoval` says why; restorable. */
  removed?: boolean;
  /** The data source and the file of it the example was taken from (#29); missing on older datasets. */
  sourceId?: string;
  sourceFileId?: string;
  /**
   * Where its frozen features sit in a packed segment file in object storage (docs/design/server.md
   * 6). Missing: they are a document of their own, read by `featureDocId` (examples saved before
   * object storage, and deployments without it).
   */
  featureRef?: FeatureRef;
}

/** A byte range of one object: a record packed in a segment file (one JSON line). */
export interface FeatureRef {
  /** The segment file's object key. */
  key: string;
  offset: number;
  length: number;
}

/** An example's features: placeholder key -> value. Image features hold URLs in `items`. */
export type Features = Record<string, FeatureValue>;

/** An example with its frozen features (#32), as labeling and the helpers read it. */
export type ExampleWithFeatures = Example & {features: Features};

/**
 * The frozen features of one example (#32): one document per example in the document store, apart
 * from the product records, read only by id (`featureDocId(snapshotId, externalId)`). Fetched once
 * when the example is taken, so scoring is reproducible and the feature service is not read again.
 * Kept as long as its dataset.
 */
export interface ExampleFeatures {
  id: string;
  snapshotId: string;
  externalId: string;
  type: ExampleType;
  features: Features;
  fetchedAt: string;
}

/** Why an item was left out when it was taken (#32): the platform's item checks. */
export type ItemProblem = 'missing' | 'minor_creator' | 'not_recommendable';

/** Items left out by the checks, per category (#32). */
export interface ItemCheckCounts {
  /** Not found, or no longer there. */
  missing: number;
  /** Its creator is under 18. */
  minorCreator: number;
  /** Not publicly recommendable. */
  notRecommendable: number;
  /** Passed checks/lookup with zero non-empty features (#48); omitted when 0. */
  noFeatures?: number;
}

/**
 * Why an example left the eval dataset (spec 1.0.0, 4.4). 'other': a person's own reason, said in
 * the removal's note (wireframe W-EvalDataset-Remove, #100).
 */
export type RemovalReason = 'broken' | 'out_of_scope' | 'other' | 'downsample' | 'excess_unlabeled';

/**
 * The trail of one removal from the eval dataset (spec 1.0.0, 4.4): what was removed, from which
 * half, its gold label at the time, and why. A score built after it shows how many gold-labeled
 * examples were removed, so a score raised by deleting hard examples is visible as such.
 */
export interface DatasetRemoval {
  id: string;
  projectId: string;
  exampleId: string;
  externalId: string;
  half: 'optimiser' | 'held_out';
  /** The gold label when it was removed; null when it had none. */
  gold: Answer | null;
  reason: RemovalReason;
  /** The person's note on why, if they wrote one (#100). */
  note?: string | null;
  removedBy: string;
  removedAt: string;
  /** Set when the example was put back. */
  restoredAt: string | null;
}

/**
 * A person's comment on an example (spec 1.0.0, 5.4), append-only, from Gold Labels or Mismatches.
 * Comments on optimiser-half examples reach the Optimiser and the Prompt helper; comments on the
 * held-out half never reach a helper.
 */
export interface LabelComment {
  id: string;
  projectId: string;
  exampleId: string;
  authorId: string;
  authorName: string;
  text: string;
  /** The version compared when it was written on Mismatches; null on the eval set. */
  promptVersionId: string | null;
  createdAt: string;
}

/**
 * A label set (docs/design/server.md 4.2): a contiguous range of a dataset's sample numbers,
 * `first` to `last` inclusive, labeled by the people in `labelerIds`. Sets never overlap, their
 * range never changes after creation, and they are not deleted. Removed examples in the range are
 * hidden from the set and counted nowhere; restored ones come back into it. One labeler per set
 * for now; the list leaves room for more.
 */
export interface LabelSet {
  id: string;
  projectId: string;
  snapshotId: string;
  /** 1, 2, 3... in the order sets were created in the project; the name pages show when `name` is empty. */
  number: number;
  /** The name people gave it; empty for none. */
  name: string;
  first: number;
  last: number;
  /** User ids of its labelers; each was granted project write when added. */
  labelerIds: string[];
  createdAt: string;
  /** User id of whoever created it. */
  createdBy: string;
}

export interface DatasetSnapshot {
  id: string;
  projectId: string;
  number: number;
  /**
   * Every example of this dataset has its `number` and an explicit `removed` (docs/design/server.md
   * 4.2), so pages can filter and page them in the store. Missing on datasets made before numbers:
   * the workflow numbers their examples on first read, then sets it.
   */
  numbered?: boolean;
  /** 'sources': taken from the tenant's data sources (#29). 'sample' and 'upload' are older datasets. */
  source: 'sources' | 'sample' | 'upload';
  sourceName: string;
  createdAt: string;
  /**
   * `notSaved`: valid examples whose save failed twice and were skipped (resilience spec, 3.2),
   * counted apart from `invalid` rows; `valid` counts only the saved ones. `checks`: items left out
   * by the item checks when they were taken, per category (#32); they count in `invalid` too.
   */
  counts: {rows: number; valid: number; invalid: number; video: number; photoText: number; notSaved?: number; checks?: ItemCheckCounts};
  split: {eval: number; test: number; train: number} | null;
  /**
   * The average size of each feature per kind of example, over the examples of that kind (#32):
   * characters of text, or the number of images of an image feature. Only for estimates, which
   * can no longer read every example's features.
   */
  featureSizes?: Partial<Record<ExampleType, Record<string, FeatureSize>>>;
  /**
   * Exact feature-missingness counts over the saved examples of this snapshot (#48). Missing on
   * older snapshots.
   */
  featureMissingness?: FeatureMissingness;
}

/** The average size of one feature over a dataset's examples (#32). */
export interface FeatureSize {
  chars: number;
  items: number;
}

/**
 * Exact integer feature-missingness counts for one example type (#48): how many saved examples
 * of that type exist, and for each feature key, how many of those examples have an empty value.
 */
export interface TypeFeatureMissingness {
  /** Exact integer count of saved examples of this type. */
  examples: number;
  /** Feature key -> exact integer count of examples of this type where that feature is empty. */
  missing: Record<string, number>;
}

/**
 * Snapshot-level feature missingness summary (#48). Holds raw integer counts only (never rates),
 * so callers compute rates on read without rounding drift.
 */
export interface FeatureMissingness {
  version: 1;
  /** Exact example and per-feature missing counts for each present example type. */
  byType: Partial<Record<ExampleType, TypeFeatureMissingness>>;
  /**
   * Items that passed checks/lookup but were excluded for having zero non-empty features, counted
   * per example type as exact integers.
   */
  zeroFeatureExcluded: Partial<Record<ExampleType, number>>;
}

/**
 * Gold Labels' Mismatches tab: eval examples where a version's saved answer differs from the gold
 * label, wrong in the most versions first. `versions`: the versions with answers on the whole eval
 * set (the picker), `versionId`: the one compared. `wrongEverywhere`: open examples wrong in every
 * one of them (2 or more). `reviewed`: decisions made on the tab so far.
 */
export interface MismatchList {
  versions: {id: string; label: string; score: number | null; best?: boolean}[];
  versionId: string | null;
  /** To review: the picked version's mismatches not yet reviewed for that version. */
  items: {exampleId: string; wrongIn: number; of: number}[];
  wrongEverywhere: number;
  /** Reviewed for the picked version (acceptance R4-5, 2026-11-11: a review belongs to a gold label and a version). */
  reviewed: number;
  /** The picked version's reviews, newest first; each can be reopened. */
  reviewedItems: MismatchReview[];
  /** Reviews still standing on any version: the AI Suggestion asks for a first review only while this is 0. */
  reviewedAll: number;
}

/** A decision made on the Mismatches tab, for one gold label and one version. */
export interface MismatchReview {
  exampleId: string;
  /** Kept the gold label, took the model's answer, or picked another answer. */
  outcome: 'kept' | 'model' | 'other';
  /** The labeler's "Why" (R4-4): sent to the Optimiser for optimiser-half examples only. */
  note: string | null;
  at: string;
  /** R6-3: earlier reviews of this example for this version, newest first (the newest review stands). */
  earlier?: Omit<MismatchReview, 'earlier'>[];
}

export interface GoldLabel {
  id: string;
  projectId: string;
  exampleId: string;
  schemaVersion: number;
  answer: Answer;
  source: 'labeled' | 'uploaded';
  /** Whether the user looked at the model's answer before answering. */
  revealed: boolean;
  createdAt: string;
  createdBy: string;
}

export interface FeatureSelection {
  video: string[];
  photo_text: string[];
  metadata: string[];
}

export interface PromptImage {
  name: string;
  url: string;
  size: number;
}

export interface PromptVersion {
  id: string;
  projectId: string;
  major: number;
  minor: number;
  /** The prompt's parts as the user edits them. `template` is always `compilePrompt` of it. */
  structured: StructuredPrompt;
  /** The compiled text the model reads (with {{placeholders}}). */
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  parentId: string | null;
  madeBy: Actor;
  change: string;
  schemaVersion: number;
  createdAt: string;
}

export interface Prediction {
  id: string;
  /** The project of the task that saved it (missing on older records); deleting a project uses it. */
  projectId?: string;
  promptVersionId: string;
  endpoint: EndpointId;
  settingsHash: string;
  exampleId: string;
  output: string;
  answer: Answer | null;
  invalidReason: string | null;
  /**
   * The model's own short reason for its answer (decided 2026-11-11): one sentence it writes in
   * "reason" before the values. Read by the Optimiser and Improve with AI; never a label and
   * never in the exported files. Missing on older records and when the model gave none.
   */
  reason?: string;
  /** The endpoint's safety filter stopped the answer (`answer` is null). */
  filtered?: boolean;
  costUsd: number;
  /** Input + output tokens of the call (reasoning included). Missing on older records. */
  tokens?: number;
  createdAt: string;
}

export type JobState = 'running' | 'paused' | 'done' | 'failed' | 'stopped';

/** Page view of one eval or optimiser labeling task (see `@yushiguang/sprint-contracts` labeling-api). */
export interface LabelingRun {
  id: string;
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  state: JobState;
  done: number;
  total: number;
  /** Valid answers saved (examples that got a label). */
  valid?: number;
  /** Answers saved that did not match the schema (filtered ones included). */
  invalid?: number;
  /** Examples the endpoint's safety filter stopped. */
  filtered?: number;
  /** Examples whose call failed after the gateway's retries. */
  failed?: number;
  costUsd: number;
  /** Tokens used by this run's answers (Training Set: "Total tokens"). */
  tokens?: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Created by code without a click. */
  auto?: boolean;
  /** 'optimiser': labeled by an Optimiser run (its dry run, or the eval set). */
  purpose?: 'eval' | 'optimiser' | 'test';
  /** What runs started by code spent on it (metrics and the audit; there is no cap). */
  autoCostUsd?: number;
  /** Page views only: set while its job waits for the model ("Queued · 2 ahead"). */
  queue?: JobQueuePlace;
}

/** Where a waiting job stands: how many jobs for the same model (or compute) go before it. */
export interface JobQueuePlace {
  ahead: number;
}

export interface ValueMetrics {
  value: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

/**
 * Where a model answer differs from the gold label. Single-select: `confused`, one value read as
 * another. Multi-select: `extra` (a value the gold label lacks, `gold` null) and `missed` (a gold
 * value the answer lacks, `predicted` null).
 */
export interface MixUp {
  kind: 'confused' | 'extra' | 'missed';
  gold: string | null;
  predicted: string | null;
  count: number;
  exampleIds: string[];
}

export interface Metrics {
  /**
   * Examples the score rests on: answers the site could read as labels. Invalid answers and answers
   * the safety filter stopped are left out (acceptance R4-6, 2026-11-11) and counted below.
   */
  n: number;
  /** Every example scored for, including those left out. Missing on reports made before 2026-11-11. */
  total?: number;
  /** Answers the safety filter stopped. Missing on reports made before 2026-11-11. */
  filtered?: number;
  /** The label's macro-F1: the main score. */
  macroF1: number;
  accuracy: number;
  /** Per value, in label order. */
  values: ValueMetrics[];
  lowestValue: {value: string; f1: number} | null;
  invalid: number;
  /** Invalid answers over every example scored for (`total`). */
  invalidRate: number;
  mixUps: MixUp[];
  costPer1000: number;
}

export interface EvalReport {
  id: string;
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  contextId: string;
  schemaVersion: number;
  /** The dataset snapshot this report was scored against (#48). Missing on older reports. */
  snapshotId?: string;
  settings: ModelSettings;
  metrics: Metrics;
  /** What the report was scored on, part by part (docs/design/server.md 4.3). Missing on reports made before #86. */
  basis?: ScoreBasis;
  archived: boolean;
  createdAt: string;
}

/**
 * What a score rests on (docs/design/server.md 4.3), each part as a hash. A report whose parts
 * differ from today's is out of date: it is never worked out again by itself, only by Rescore.
 */
export interface ScoreBasis {
  /** The samples scored on: eval samples inside label sets and not removed, with their half. */
  samples: string;
  /** Their gold labels. */
  gold: string;
  /** The thresholds the report is judged by. */
  thresholds: string;
}

export type ScoreBasisPart = keyof ScoreBasis;

/** Where scoring stands (docs/design/server.md 4.3): what Prompt Tuning shows above the versions. */
export interface ScoringState {
  /** Every label set is finished, so versions get scores. False: no new scores and no Rescore. */
  ready: boolean;
  /**
   * The label sets' sample number ranges, in order. null: the project has no label set yet, so the
   * rule from before label sets holds (scores on the samples with a gold label; ready once one
   * has), a transition until the label set pages ship.
   */
  ranges: {first: number; last: number}[] | null;
  labelSets: number;
  labelSetsDone: number;
  /** Samples inside label sets and not removed (all of them when `ranges` is null). */
  samples: number;
  /** Of them, those with a gold label for the current label. */
  labeled: number;
  /** Today's basis; reports scored on it are current. */
  basis: ScoreBasis;
  /**
   * Versions whose newest score rests on an older basis and that have no current one: Prompt
   * Tuning shows the Rescore banner. Empty while `ready` is false.
   */
  staleVersionIds: string[];
  /** What changed since those scores were made (empty for scores made before #86). */
  changed: ScoreBasisPart[];
  /** A Rescore is queued or running. */
  rescoring: boolean;
}

/**
 * The Optimiser's dry run: before a change is labeled on the whole eval set, it is labeled on a
 * few examples of the optimiser half, next to the version it came from. "Passed" = examples whose
 * answer matches the gold label.
 */
export interface DryRunResult {
  examples: number;
  /** Exact matches. */
  passed: number;
  parentPassed: number;
  /**
   * Sums of example scores (resilience spec, 6): exact matches on a single-select label, partial
   * credit on a multi-select one. What the dry run compares. Missing on rounds made before.
   */
  score?: number;
  parentScore?: number;
  parentId: string;
}

/** What an Optimiser run is doing now (the panel's "Now" line). */
export type OptimiserStep = 'parent' | 'reflect' | 'merge' | 'check' | 'dry_run' | 'full' | 'report' | 'confirm';

/**
 * The steps of a round that label examples (docs/design/server.md, 4.4): each is queued as a
 * labeling job of its own, and the run goes on in a new `optimiser.run` job once it ends.
 */
export type OptimiserLabelingStep = 'parent' | 'dry_run' | 'full' | 'confirm';

/** Where a run waits for its labeling: its round count and the labeling step. */
export interface OptimiserPosition {
  round: number;
  step: OptimiserLabelingStep;
}

/** One change the Optimiser tried: a row of the panel's history, newest first in the UI. */
export interface OptimiserRound {
  round: number;
  /** The version made for the change; null when nothing was labeled (failed the Checks, repeated). */
  versionId: string | null;
  parentId: string;
  /** A merge of two versions, or one change from the mistakes. */
  kind: 'change' | 'merge';
  change: string;
  outcome: 'running' | 'kept' | 'dropped' | 'checks' | 'repeat' | 'failed' | 'stopped';
  /** Kept versions: the score on the held-out half (macro-F1). */
  score: number | null;
  passed: boolean;
  dryRun: DryRunResult | null;
  /**
   * The examples the dry run labels, picked once and saved, so the run that goes on after the
   * dry run's labeling job compares the same ones. Missing on rounds made before.
   */
  dryRunIds?: string[];
  /**
   * The dry run tied with the parent: the same dry-run score. Since the resilience spec (6) a tie
   * goes on to the full labeling like a better change, and `gain` says whether it was progress.
   */
  tied?: boolean;
  /**
   * Kept versions (resilience spec, 6): whether it beat its parent's macro-F1 on the optimiser half
   * after the full labeling. Only a gain resets the run's count of wasted rounds. The held-out half
   * never steers the run. Missing on rounds made before.
   */
  gain?: boolean;
  /**
   * Why this parent (R5-7): on how many optimiser-half examples it is the best version. null: round
   * 1, which always starts from the version the user picked. Missing on rounds made before.
   */
  parentWins?: number | null;
  /**
   * What the change aimed at (#39): the parent's weakest value on the optimiser half when the change
   * was written. Missing on rounds made before.
   */
  aimedAt?: {value: string; f1: number} | null;
  /**
   * A pass is confirmed by labeling the held-out half a second time (decided 2026-11-10): the
   * second labeling's score, and whether it passes too. Only a confirmed pass ends the run.
   */
  confirm?: {score: number; passed: boolean} | null;
  /** Where a failed or stopped round was, so Retry resumes there. */
  step?: OptimiserStep;
}

export interface OptimisationRun {
  id: string;
  projectId: string;
  endpoint: EndpointId;
  /** The version the run started from ("Started from"). */
  startVersionId: string;
  /** The major number this run's versions use (v4.1, v4.2…). */
  major: number;
  maxRounds: number;
  /** Rounds started so far (a round = one change tried, merges included). */
  round: number;
  state: JobState;
  step: OptimiserStep | null;
  stepStartedAt: string | null;
  /** The version the current step works on, when there is one. */
  stepVersionId: string | null;
  history: OptimiserRound[];
  /** Labeling calls and cost, for telemetry only (never shown). */
  calls: number;
  candidates: number;
  costUsd: number;
  /** 'passes' | 'max_rounds' | 'no_new_ideas' | 'user'. */
  stopReason: string | null;
  /** Failed: one line naming the step and the error. */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Started by an agent's start tool, after the user asked in Ask AI; shown as an action line. */
  auto?: boolean;
  /** Page views only, never stored: set while its job waits for the model. */
  queue?: JobQueuePlace;
  /**
   * The user pressed Stop while a runner held the run (#79): the runner reads it before every
   * save and ends the run as stopped itself, under its lock. A runner never writes this field, so
   * the request is never lost to a runner's save.
   */
  stopRequested?: boolean;
}

export interface GateApproval {
  id: string;
  projectId: string;
  node: NodeId;
  status: string;
  createdAt: string;
  createdBy: string;
}

export type AgentPreset = 'front_desk' | 'prompt_agent' | 'evaluation_agent';

export interface ChatAttachment {
  name: string;
  size: number;
  url?: string;
  /** Extracted text snippet for text/CSV/JSONL attachments passed to the agent context. */
  content?: string;
}

/**
 * What a grey action line in Ask AI records (`role: 'event'`): a helper joined, a draft was put
 * on a page, the user approved or discarded it, paid work started (by a helper, or automatically
 * by the workflow), the user stopped work, or the page's own helper answers again.
 */
export type ChatEvent = 'join' | 'draft' | 'approved' | 'discarded' | 'start' | 'auto' | 'stop' | 'page' | 'report';

/** Where an action line leads: a step page and its query (the page adds the project). */
export interface ChatLink {
  path: string;
  params?: Record<string, string>;
}

/** A turn while it runs, for Ask AI (not saved): who works, what it is doing, the reply so far. */
export interface AgentLive {
  agent: AgentPreset;
  /** A plain line such as "Reading the v4 report…"; null once the reply streams. */
  working: string | null;
  /** The working line as a catalog key and params, so the page can show it in the user's language (1.1.0). */
  msg?: Msg | null;
  /** The reply streamed so far. */
  reply: string | null;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: 'user' | 'agent' | 'event';
  agent: AgentPreset | null;
  /** In English. A line the site wrote also carries `msg`, so it can be shown in any language. */
  text: string;
  /** Action lines: the line as a catalog key and params (spec 1.1.0, 2.3). */
  msg?: Msg;
  /** Action lines only: what happened, for the line's icon. */
  event?: ChatEvent;
  /** Action lines only: the page where it happened; the whole line links there. */
  link?: ChatLink;
  /** Quick replies the user can tap. */
  choices?: string[];
  /** Files attached to this message. */
  attachments?: ChatAttachment[];
  page: string;
  createdAt: string;
}

/**
 * A helper's draft of a structured prompt, waiting on the page for the user's Approve or Save.
 * `unmapped`: passages of a pasted prompt the helper could not place in any part ("Not carried
 * over"); an import never drops text silently.
 */
export interface StructuredPromptProposal {
  structured: StructuredPrompt;
  /** One line for the version's change note. */
  change?: string;
  /** Improve with AI: each change with its reason, shown on the marks in the editor. */
  changes?: {text: string; reason: string}[];
  /** The version the draft was written from; null or missing: the first prompt. */
  baseVersionId?: string | null;
  unmapped: string[];
}

export interface AgentProposal {
  id: string;
  projectId: string;
  agent: AgentPreset;
  kind: 'prompt';
  payload: StructuredPromptProposal;
  brief: string;
  state: 'open' | 'approved' | 'discarded';
  createdAt: string;
}

/** Handoff and cold start use the same request (tech doc, "Starting an agent"). */
export interface StartRequest {
  id: string;
  projectId: string;
  from: AgentPreset | 'system' | 'user';
  to: AgentPreset;
  intent: string;
  refs: Record<string, string | string[]>;
  userRequest: string;
  note: string;
  createdAt: string;
}

export interface EndpointInfo {
  id: EndpointId;
  name: string;
  description: string;
  badge: string;
  cost: 'Higher' | 'Lower';
  speed: 'Slower' | 'Faster';
  supportsTemperature: boolean;
  /** USD per million tokens, for estimates. */
  priceIn: number;
  priceOut: number;
}

export interface PageContext {
  /** Shown as "On this page: ...". */
  label: string;
  /** Which agent answers first on this page. */
  agent: AgentPreset;
  /** The intent the page's agent gets for a plain message. */
  intent: string;
  hint?: string;
  /**
   * What the page holds that isn't saved yet (an unsaved draft, a selected item). Saved data is
   * not passed here: the bff builds the page view from `where`.
   */
  context: Record<string, unknown>;
  /** Where the user is: set by the assistant panel from the URL, so pages can't forget it. */
  where?: PageLocation;
}

/** The pages an agent can see. */
export type PageId = 'projects' | 'sources' | 'source' | 'prompt_design' | 'dataset' | 'gold' | 'prompt' | 'prompt_edit';

export interface PageLocation {
  page: PageId;
  /** URL parameters other than the project, e.g. {v: version id, m: 'A'} on the Eval report. */
  params: Record<string, string>;
}

/**
 * A page as the agent sees it: built by the bff from the same saved data the page shows (plus
 * the page's unsaved edits). The page is the agent's workspace, like a repo for a coding agent.
 */
export interface PageView {
  page: PageId;
  title: string;
  /** One or two plain sentences: what is on the page right now. */
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Taking examples from data sources into the eval dataset (#29): a `dataset.sample` job, as the
 * Dataset page shows it.
 */
export interface SamplingTask {
  id: string;
  projectId: string;
  total: number;
  fetched: number;
  startedAt: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  error: string | null;
  /** All items are in; the examples are being saved (resilience spec, 3.1). Stop is gone by then. */
  saving?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Tenant models (docs/design/server.md, 9): the labeling models a tenant admin enters by hand.

/**
 * A model a tenant admin added: what to call and how much of it the tenant may use. Its `id` is
 * what projects store (`ModelSettings.endpoint`) and what job concurrency keys and rate limits are
 * kept under; `endpoint` is only handed to the model service at call time.
 */
export interface TenantModel {
  /** Generated by Sprint; never the text the admin typed. */
  id: string;
  tenantId: string;
  /** Display name. */
  name: string;
  /** The endpoint to call, as the admin entered it. Never a metric label or a log field. */
  endpoint: string;
  /** Requests per minute this tenant may send to it. */
  qpm: number;
  /** Tokens per minute (input + output, reasoning included) this tenant may use on it. */
  tpm: number;
  /** New projects of the tenant use its default model. At most one model of a tenant is default. */
  default: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/**
 * A tenant (#94): the space a team works in. Its projects, data sources and models belong to it;
 * who is in it, and as what, is kept on the external permission platform (`PermissionAdminPort`).
 * Tenants used before this record existed (`DEFAULT_TENANT`, an identity's organization) have no
 * record and keep working; their name comes from the identity.
 */
export interface Tenant {
  /** Generated by Sprint (`tn_…`): the id the permission platform and other services use. */
  id: string;
  /** Unique across Sprint, compared without case. */
  name: string;
  createdAt: string;
  /** The creator's display name and user id; the creator is the tenant's first admin. */
  createdBy: string;
  createdById: string;
}

// ---------------------------------------------------------------------------------------------
// Data sources (#29, #30): a tenant's item-id files, shared by its projects.

/**
 * A data source of a tenant: a name and the file uploaded to it (one file is one data source since
 * 2026-11-22; sources made before may hold several, which all count together, no versions). Its items have one fixed order (each file's items are shuffled once at import and
 * appended); datasets take continuous segments of that order, so two cuts never share an item.
 */
export interface DataSource {
  id: string;
  tenantId: string;
  name: string;
  /** The sample data that ships with the platform (`ExampleSource.builtIn`). */
  builtIn?: boolean;
  /** Items in the order, over every imported file. */
  items: number;
  files: number;
  /** Positions handed out to datasets: the next cut starts here (#30). Never goes back. */
  next: number;
  /**
   * The last positions reserved for a file, written in the same update as `items`: a run cut short
   * before the file recorded them copies them from here, so no positions are reserved twice or lost.
   */
  reserved?: {fileId: string; start: number; items: number; repeats: number} | null;
  createdAt: string;
  createdBy: string;
  createdById?: string;
  updatedAt: string;
  /**
   * Deleted by a tenant admin: gone from every list and read, and no dataset takes from it again.
   * The record stays, so examples already taken keep their source's name.
   */
  deletedAt?: string | null;
  deletedBy?: string;
}

/** One file of a data source. Items already in the source are repeats and left out. */
export interface SourceFile {
  id: string;
  sourceId: string;
  tenantId: string;
  name: string;
  /** Rows read; `bad`: rows with no usable item id; `repeats`: ids already in the file or source. */
  rows: number;
  bad: number;
  repeats: number;
  /** Items this file added to the source's order. */
  items: number;
  /** The seed its items were shuffled with (#30). */
  seed: string;
  /** Its first position in the source's order, set when its import reserves the positions. */
  start?: number;
  state: 'importing' | 'done' | 'failed';
  /**
   * Items written so far, of `items`. A failed file keeps the items it wrote (they can be taken);
   * the rest of its positions are skipped, and uploading the file again adds them.
   */
  done: number;
  error?: string | null;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * A piece of a source's order: positions `start` to `start + ids.length - 1`, all from one file.
 * Staged pieces (`staged`) hold a file's ids until its import writes them into the order.
 */
export interface SourceChunk {
  id: string;
  sourceId: string;
  fileId: string;
  start: number;
  ids: string[];
  staged?: boolean;
}

/**
 * A segment of a source's order given to a project's dataset (#30): positions `start` up to
 * `end` (not included). `taken`: the items that went into the dataset (one already there is
 * skipped). A deleted project's segments are retired, never handed out again.
 */
export interface SourceCut {
  id: string;
  sourceId: string;
  projectId: string;
  start: number;
  end: number;
  taken: number;
  createdAt: string;
  createdBy: string;
  retired?: boolean;
}

/** A data source as the Data Source page lists it. */
export interface DataSourceSummary {
  id: string;
  name: string;
  builtIn: boolean;
  files: number;
  /** The uploaded file's name (the first file's, for a source made before one file was one source). */
  fileName: string;
  items: number;
  /** Items no dataset has taken yet. */
  notUsed: number;
  /**
   * `reading`: its file is still being read; `failed`: no file could be read (`error` says why);
   * `ready`: its items can be taken.
   */
  state: 'reading' | 'ready' | 'failed';
  /** Why the file could not be read, when `state` is `failed`. */
  error?: string | null;
  /** Projects whose datasets took items from it (deleted projects not counted). */
  usedBy: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** A file is being imported: items written so far, of its items. */
  importing: {done: number; total: number} | null;
}

/** One data source with its files (the source's page). */
export interface DataSourceDetail {
  source: DataSourceSummary;
  /** Newest first. */
  files: SourceFile[];
  /** Items taken by datasets, and by how many projects. */
  taken: number;
  projects: number;
  /** The projects using it (`projects` of them), by name: the page lists them and Delete names them. */
  usedByProjects: {id: string; name: string}[];
}

/** Where a project's eval dataset came from: per data source, how many examples and when last added. */
export interface DatasetSourceLine {
  sourceId: string;
  name: string;
  /** The built-in sample data: its name is translated. */
  builtIn?: boolean;
  examples: number;
  addedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Views shared by the bff and the web app.

/** The facts the gate checks read (see `@yushiguang/sprint-domain` gates). */
export interface WorkflowFacts {
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  /** Valid examples in the eval dataset. */
  examples: number;
  goldEvalDone: number;
  /** Gold-labeled examples per half: scoring needs 2 in each. */
  goldHalves: {optimiser: number; heldOut: number};
  /** Every label set is finished (`ScoringState.ready`): the Gold step is done and scores are made. */
  scoringReady: boolean;
  versions: number;
  /** Versions with a report that passes the current thresholds, per model. */
  passing: {promptVersionId: string; endpoint: EndpointId}[];
  /** Project Settings were seen and saved: no paid run starts by itself before that. */
  settingsConfirmed: boolean;
  approved: NodeId[];
}

/** Everything a page needs about one project, read in one go. */
export interface ProjectState {
  project: Project;
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  examples: Example[];
  gold: Record<string, GoldLabel>;
  staleGold: Record<string, GoldLabel>;
  versions: PromptVersion[];
  /** `rough`: fewer gold-labeled eval examples than `thresholds.minEval`, so no pass verdict (spec 1.0.0, 4.2). */
  reports: (EvalReport & {passed: boolean; rough: boolean; archivedNow: boolean})[];
  /** Eval and optimiser labeling (started by code). */
  runs: LabelingRun[];
  optimisation: OptimisationRun[];
  facts: WorkflowFacts;
  /** Today's scoring basis as one id (`ScoringState.basis` hashed with the schema version). */
  contextId: string;
  scoring: ScoringState;
  /** Some versions' scores are out of date (`scoring.staleVersionIds` is not empty). */
  scoresUpdating: boolean;
  /** Available preset endpoints from the model runtime. */
  endpoints: EndpointInfo[];
  /** Active or recently finished sampling task, if any. */
  samplingTask: SamplingTask | null;
  /** The data sources the eval dataset was taken from (#29). */
  datasetSources: DatasetSourceLine[];
  /** Removals that still stand (not restored), newest first; the removed examples are not in `examples`. */
  removals: DatasetRemoval[];
  /** People's comments by example id, oldest first. */
  comments: Record<string, LabelComment[]>;
  /**
   * Automatic spend that left no labeling task: the prompt agent's try_prompt runs started
   * within the caps (from `auto_spend` audit records).
   */
  otherAutoSpendUsd?: number;
  /**
   * The project's revision when this state was read (review G9): read before anything else, so a
   * write during the read gives a newer one. See `ProjectStatus.revision`.
   */
  revision?: string;
}

/**
 * The light read of a project (review G9): what changes while work runs, without the dataset,
 * gold labels, versions or reports. A client on a server polls it and reads the whole
 * `ProjectState` again only when `revision` is not the one it holds.
 */
export interface ProjectStatus {
  projectId: string;
  /**
   * Changes with every saved change to the project (dataset, gold labels, versions, reports, runs,
   * chat). An opaque value: compare it for equality only.
   */
  revision: string;
  /** Sampling or upload in progress, as on the Dataset page. */
  samplingTask: SamplingTask | null;
  /** Eval and optimiser labeling, with their counts. */
  runs: LabelingRun[];
  /** Optimiser runs, without their rounds. */
  optimisation: Omit<OptimisationRun, 'history'>[];
}


/** A language the site is shown in (spec 1.1.0, 2). English is the source language. */
export type Locale = 'en' | 'zh';

/**
 * A text the services make, as a catalog key and its params: the English text with `{name}`
 * placeholders. Clients translate it. A param may itself be a `Msg` (translated in turn); a string
 * param named `who`, `page`, `step`, `helper` or `term` is a word of the site and is translated too.
 */
export interface Msg {
  key: string;
  params?: Record<string, string | number | Msg>;
}

/**
 * What the browser saw just before a problem (spec 1.1.0, 3.2). Collected by the web client in a
 * rolling record and sent with each Ask AI message; the bff keeps it for that turn only. No text
 * the user typed, no features, no labels.
 */
export interface ClientDiagnostics {
  /** Path and query of the page (ids only). */
  url: string;
  userAgent: string;
  /** Width x height in CSS pixels. */
  viewport: string;
  screen: string;
  timeZone: string;
  /** The browser's language setting. */
  language: string;
  at: string;
  /** The last pages visited, oldest first. */
  pages: {at: string; path: string}[];
  /** The last backend calls that failed: method, the client's call id and the error message. */
  failedCalls: {at: string; method: string; callId: string; message: string}[];
  /** The last script errors and unhandled rejections (message cut short). */
  errors: {at: string; message: string; source?: string}[];
}

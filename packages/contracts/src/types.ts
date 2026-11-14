/**
 * Domain types. Every entity except Project is immutable once written: a change makes a new
 * record that points at what it was built from (see docs/architecture.md, "Data model").
 */

export type ExampleType = 'video' | 'photo_text';
export type FeatureGroup = ExampleType | 'metadata';
export type FieldKind = 'single' | 'multi';
export type Split = 'eval' | 'test' | 'train';
export type EndpointId = 'A' | 'B';
export type Actor = 'user' | 'prompt_agent' | 'optimiser' | 'system';

export interface LabelValue {
  name: string;
  definition: string;
}

export interface LabelField {
  name: string;
  kind: FieldKind;
  /** Multi-select only: how many values an answer may hold. */
  min?: number;
  max?: number;
  values: LabelValue[];
}

/**
 * The label fields. There is no separate policy text (removed 2026-11-09): each value's one-line
 * definition and the prompt carry the rules.
 */
export interface Schema {
  fields: LabelField[];
}

/**
 * What an answer may hold (1.0.0): the field names, their kind and bounds, and the value names in
 * order. No wording. `schemaVersion` bumps only when this changes, so refining a definition never
 * touches gold labels or scores.
 */
export interface LabelSignatureField {
  name: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  values: string[];
}

export interface LabelSignature {
  fields: LabelSignatureField[];
}

/** One field of a structured prompt: the signature's field with the wording the model reads. */
export interface StructuredFieldPrompt extends LabelField {
  /** Optional tie-break note for the field as a whole. */
  note?: string;
}

/**
 * A prompt as the user edits it (1.0.0): parts, not free text. `compilePrompt` in `@tsp/domain`
 * turns it into the text the model reads, the same way every time. Stored on every version.
 */
export interface StructuredPrompt {
  /** One or two sentences: what is being classified and why. */
  taskSummary: string;
  features: FeatureSelection;
  fields: StructuredFieldPrompt[];
  /** Rules across fields, and what to do when the evidence is thin. */
  generalRules: string;
  images: PromptImage[];
}

/** One answer: field name -> chosen values (one value for single-select fields). */
export type Answer = Record<string, string[]>;

export interface Thresholds {
  mode: 'default' | 'custom';
  /** Always on: the main score. Lowest macro-F1 across fields must reach it. */
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
  name: string;
  createdAt: string;
  createdBy: string;
  /** Missing on records made before 1.0.0: `prompt_tuning`. */
  kind?: ProjectKind;
  /** Batch labeling only: the Prompt Tuning project and version it labels with. */
  sourceProjectId?: string | null;
  sourcePromptVersionId?: string | null;
  /** The user has seen and saved Project Settings (asked once, before the first paid run). */
  settingsConfirmed?: boolean;
  setupVersionId: string | null;
  snapshotId: string | null;
  /** Nodes whose Next step was pressed. Code moves the workflow, never the agent. */
  approvedNodes: NodeId[];
}

export interface Example {
  id: string;
  snapshotId: string;
  externalId: string;
  type: ExampleType;
  title: string;
  /** Placeholder key -> value. Image features hold URLs. */
  features: Record<string, string | string[]>;
  split: Split | null;
  /** Eval examples only: true = the optimiser may learn from it; false = held out for scoring. */
  optimiserHalf: boolean;
}

export interface DatasetSnapshot {
  id: string;
  projectId: string;
  number: number;
  source: 'sample' | 'upload';
  sourceName: string;
  createdAt: string;
  counts: {rows: number; valid: number; invalid: number; video: number; photoText: number};
  split: {eval: number; test: number; train: number} | null;
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

/** Page view of one eval or optimiser labeling task (see `@tsp/contracts` labeling-api). */
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
}

export interface ValueMetrics {
  value: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface FieldMetrics {
  field: string;
  kind: FieldKind;
  macroF1: number;
  accuracy: number;
  values: ValueMetrics[];
}

export interface MixUp {
  field: string;
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
  fields: FieldMetrics[];
  lowestField: {field: string; macroF1: number};
  lowestValue: {field: string; value: string; f1: number} | null;
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
  settings: ModelSettings;
  metrics: Metrics;
  archived: boolean;
  createdAt: string;
}

/**
 * The Optimiser's dry run: before a change is labeled on the whole eval set, it is labeled on a
 * few examples of the optimiser half, next to the version it came from. "Passed" = examples where
 * every field matches the gold label.
 */
export interface DryRunResult {
  examples: number;
  passed: number;
  parentPassed: number;
  parentId: string;
  /** Per field: examples with that field right. */
  fields: {field: string; passed: number; parentPassed: number}[];
}

/** What an Optimiser run is doing now (the panel's "Now" line). */
export type OptimiserStep = 'parent' | 'reflect' | 'merge' | 'check' | 'dry_run' | 'full' | 'report' | 'confirm';

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
  /** Kept versions: the score on the held-out half (lowest field macro-F1). */
  score: number | null;
  passed: boolean;
  dryRun: DryRunResult | null;
  /**
   * The dry run tied with the parent (acceptance R5-6): as many fields right, but on different
   * examples. The change is labeled in full and kept in the pool, but does not count as progress.
   */
  tied?: boolean;
  /**
   * Why this parent (R5-7): on how many optimiser-half examples it is the best version. null: round
   * 1, which always starts from the version the user picked. Missing on rounds made before.
   */
  parentWins?: number | null;
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
export type ChatEvent = 'join' | 'draft' | 'approved' | 'discarded' | 'start' | 'auto' | 'stop' | 'page';

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
  /** The reply streamed so far. */
  reply: string | null;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: 'user' | 'agent' | 'event';
  agent: AgentPreset | null;
  text: string;
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
export type PageId = 'projects' | 'prompt_design' | 'dataset' | 'gold' | 'prompt' | 'prompt_edit';

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

export interface SamplingTask {
  id: string;
  projectId: string;
  /** 'upload': loading the features of an uploaded file's item IDs (Dataset, "Loading features"). Missing = 'sample'. */
  kind?: 'sample' | 'upload';
  /** Upload only: the file's name. */
  fileName?: string;
  total: number;
  fetched: number;
  startedAt: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  error: string | null;
}


// ---------------------------------------------------------------------------------------------
// Views shared by the bff and the web app.

/** The facts the gate checks read (see `@tsp/domain` gates). */
export interface WorkflowFacts {
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  /** Valid examples in the eval dataset. */
  examples: number;
  goldEvalDone: number;
  /** Gold-labeled examples per half: scoring needs 2 in each. */
  goldHalves: {optimiser: number; heldOut: number};
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
  contextId: string;
  /** A gold edit archived some reports and they are being rebuilt from saved answers (acceptance R5-4, R5-5). */
  scoresUpdating: boolean;
  /** Available preset endpoints from the model runtime. */
  endpoints: EndpointInfo[];
  /** Active or recently finished sampling task, if any. */
  samplingTask: SamplingTask | null;
  /**
   * Automatic spend that left no labeling task: the prompt agent's try_prompt runs started
   * within the caps (from `auto_spend` audit records).
   */
  otherAutoSpendUsd?: number;
}


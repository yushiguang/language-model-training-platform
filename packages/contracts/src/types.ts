/**
 * Domain types. Every entity except Project is immutable once written: a change makes a new
 * record that points at what it was built from (see docs/architecture.md, "Data model").
 */

export type ExampleType = 'video' | 'photo_text';
export type FeatureGroup = ExampleType | 'metadata';
export type FieldKind = 'single' | 'multi';
export type Split = 'eval' | 'test' | 'train';
export type EndpointId = 'A' | 'B';
export type Actor = 'user' | 'prompt_agent' | 'optimiser' | 'schema_agent' | 'system';

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

export interface Schema {
  policy: string;
  fields: LabelField[];
}

/** One answer: field name -> chosen values (one value for single-select fields). */
export type Answer = Record<string, string[]>;

export interface Thresholds {
  mode: 'default' | 'custom';
  /** Always on: the main score. Lowest macro-F1 across fields must reach it. */
  macroF1: number;
  valueF1: number | null;
  invalidRate: number | null;
  accuracy: number | null;
  minEval: number;
}

export interface ModelSettings {
  endpoint: EndpointId;
  maxOutputTokens: number;
  /** null when the model does not support temperature. */
  temperature: number | null;
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

export type NodeId = 'setup' | 'dataset' | 'gold' | 'prompt' | 'training';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
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
  costUsd: number;
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
  costUsd: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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
  n: number;
  fields: FieldMetrics[];
  lowestField: {field: string; macroF1: number};
  lowestValue: {field: string; value: string; f1: number} | null;
  invalid: number;
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

export interface OptimisationRun {
  id: string;
  projectId: string;
  endpoint: EndpointId;
  startVersionId: string;
  state: JobState;
  budgetCalls: number;
  calls: number;
  candidates: number;
  costUsd: number;
  stopReason: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TrainingSet {
  id: string;
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  snapshotId: string;
  evaluated: boolean;
  reportId: string | null;
  /** The labeling task that produces this training set's predictions. */
  taskId: string;
  /** Setup version whose schema the answers are checked against. */
  setupVersionId: string;
  state: JobState;
  /** Train plus test examples: the final run labels both. */
  total: number;
  /** How many of `total` are train and test examples (missing on records made before the test set was added: all train). */
  trainTotal?: number;
  testTotal?: number;
  done: number;
  labeled: number;
  invalid: number;
  /** Examples whose model call failed after all retries ("Retry failed" re-runs them). */
  failed: number;
  costUsd: number;
  estimateUsd: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One row of the output: a train or test example with the model's label (and, for test, the gold label if any). */
export interface TrainingRow {
  trainingSetId: string;
  exampleId: string;
  split: 'train' | 'test';
  answer: Answer | null;
  invalidReason: string | null;
  /** Test rows only: the gold label for the current schema, when someone gave one. */
  gold: Answer | null;
}

export interface GateApproval {
  id: string;
  projectId: string;
  node: NodeId;
  status: string;
  createdAt: string;
  createdBy: string;
}

export type AgentPreset = 'front_desk' | 'schema_agent' | 'prompt_agent' | 'evaluation_agent';

export interface ChatAttachment {
  name: string;
  size: number;
  url?: string;
  /** Extracted text snippet for text/CSV/JSONL attachments passed to the agent context. */
  content?: string;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: 'user' | 'agent' | 'event';
  agent: AgentPreset | null;
  text: string;
  /** Quick replies the user can tap. */
  choices?: string[];
  /** Files attached to this message. */
  attachments?: ChatAttachment[];
  page: string;
  createdAt: string;
}

export interface AgentProposal {
  id: string;
  projectId: string;
  agent: AgentPreset;
  kind: 'schema' | 'prompt';
  payload: unknown;
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

export interface Recommendation {
  id: string;
  projectId: string;
  kind: 'make_training_set' | 'keep_improving' | 'label_gold' | 'rework_from_version' | 'wait';
  title: string;
  reasons: string[];
  promptVersionId: string | null;
  endpoint: EndpointId | null;
  evidence: {label: string; href: string}[];
  response: 'accepted' | 'dismissed' | null;
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
export type PageId = 'projects' | 'setup' | 'dataset' | 'gold' | 'prompt' | 'prompt_edit' | 'compare' | 'report' | 'training';

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
  goldEvalDone: number;
  goldTestDone: number;
  versions: number;
  /** Versions with a report that passes the current thresholds, per model. */
  passing: {promptVersionId: string; endpoint: EndpointId}[];
  trainingSet: TrainingSet | null;
  approved: NodeId[];
}

/** Everything a page needs about one project, read in one go. */
export interface ProjectState {
  project: Project;
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  examples: Example[];
  gold: Map<string, GoldLabel>;
  staleGold: Map<string, GoldLabel>;
  versions: PromptVersion[];
  reports: (EvalReport & {passed: boolean; archivedNow: boolean})[];
  /** Eval and optimiser labeling (started by code). */
  runs: LabelingRun[];
  /** "Get model answers" runs on the test set (started by the user), newest first. */
  testRuns: LabelingRun[];
  optimisation: OptimisationRun[];
  trainingSets: TrainingSet[];
  facts: WorkflowFacts;
  contextId: string;
  /** Available preset endpoints from the model runtime. */
  endpoints: EndpointInfo[];
  /** Active or recently finished sampling task, if any. */
  samplingTask: SamplingTask | null;
}


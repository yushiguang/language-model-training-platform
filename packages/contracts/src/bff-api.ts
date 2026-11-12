import type {
  Actor,
  AgentLive,
  AgentPreset,
  AgentProposal,
  Answer,
  ChatAttachment,
  ChatMessage,
  DatasetSnapshot,
  EndpointId,
  EndpointInfo,
  FeatureSelection,
  GoldLabel,
  ModelSettings,
  NodeId,
  PageContext,
  Prediction,
  Project,
  MismatchList,
  ProjectState,
  PromptImage,
  PromptVersion,
  Schema,
  SetupVersion,
  TrainingRow,
  TrainingSet,
} from './types.ts';
import type {LabelingTask} from './labeling-api.ts';
import type {ExampleMedia, FeatureInfo} from './platform-api.ts';

/**
 * Contract 1: Frontend Web App <-> BFF Service (`@tsp/contracts/bff-api`).
 *
 * IDL-ready (spec 1.0.0, section 7.1): every method is asynchronous, and every argument and result
 * is plain JSON (no `Map`, `Set`, `File` or function). A call passes ids and the user's input,
 * never a record the client holds: the bff reads the records itself. A method takes plain values
 * when it has a few, and one request struct when it starts paid work or takes many.
 *
 * In the standalone build the web client calls `apps/bff` in-process (`apps/web/src/backend-api`);
 * a microservice deployment swaps in an HTTP client with the same methods. Live updates are not
 * part of this contract: they come from an `EventStreamPort`.
 */

export type SetupPatch = Partial<Pick<SetupVersion, 'task' | 'schema' | 'thresholds' | 'models' | 'steps'>>;

/** A new version as the services pass it around (never sent by the client; see `CreateVersionRequest`). */
export interface NewVersion {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  /** The version this one was edited from; null for the first version. */
  parent: PromptVersion | null;
  madeBy: Actor;
  change: string;
  kind: 'minor' | 'major';
  /** An Optimiser change: a minor in the run's own major. */
  inMajor?: number;
  schema: Schema;
  schemaVersion: number;
}

export interface RuntimeInfo {
  user: {id: string; name: string};
  standIns: string[];
  endpoints: EndpointInfo[];
  hasBundledGold: boolean;
}

/** Paid or mutating starts take an optional key: the same key never starts the same work twice. */
export interface Idempotent {
  idempotencyKey?: string;
}

export interface TickRequest {
  projectId: string;
}

export interface CreateVersionRequest extends Idempotent {
  projectId: string;
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  /** The version this one was edited from; null for the first version. */
  parentId: string | null;
  /** Who wrote the text: the user, or the Prompt helper whose draft the user saved. */
  madeBy: Extract<Actor, 'user' | 'prompt_agent'>;
  change: string;
  kind: 'minor' | 'major';
}

export interface ScoreVersionRequest extends Idempotent {
  projectId: string;
  promptVersionId: string;
  /** Only this model; left out: every chosen model. */
  endpoint?: EndpointId;
}

export interface StartOptimiserRequest extends Idempotent {
  projectId: string;
  maxRounds: number;
  /** The version selected in the list; left out: the best scored version. */
  startVersionId?: string;
}

export interface CloseProposalRequest {
  projectId: string;
  proposalId: string;
  decision: 'approved' | 'discarded';
}

export interface GoldLine {
  externalId: string;
  answer: Record<string, string[]>;
}

export interface UploadGoldRequest {
  projectId: string;
  lines: GoldLine[];
}

export interface GoldUploadResult {
  saved: number;
  skipped: number;
}

export interface DatasetUploadResult {
  snapshot?: DatasetSnapshot;
  error?: string;
}

export interface ReviewGoldRequest {
  projectId: string;
  exampleId: string;
  promptVersionId: string;
  outcome: 'kept' | 'changed';
  answer?: Answer;
  note?: string;
}

export interface LabelTestSetRequest extends Idempotent {
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  estimateUsd: number;
}

export interface StartTrainingSetRequest extends Idempotent {
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  estimateUsd: number;
  /** Also label the test examples that have no gold label and no answer from this version. */
  labelTest?: boolean;
  /** Resume this training set instead of starting a new one. */
  resumeTrainingSetId?: string;
}

export interface SendMessageRequest {
  projectId: string;
  text: string;
  page: PageContext;
  attachments?: ChatAttachment[];
}

export interface BffContract {
  getRuntimeInfo(): Promise<RuntimeInfo>;

  // Projects & workflow gates
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  loadProjectState(projectId: string): Promise<ProjectState | null>;
  approveNode(projectId: string, node: NodeId): Promise<void>;
  /** One check of what should be running in a project (keyed starts, safe to call often). */
  tick(req: TickRequest): Promise<void>;

  // Setup
  saveSetup(projectId: string, patch: SetupPatch): Promise<SetupVersion>;

  // Dataset & Gold labels
  getSamplePoolSize(): Promise<number>;
  /** The media of one example, or null (no media source, or none for this example). */
  exampleMedia(exampleId: string): Promise<ExampleMedia | null>;
  startSampleDataset(projectId: string, count: number): Promise<DatasetSnapshot | null>;
  stopSampleDataset(projectId: string): Promise<void>;
  uploadDatasetText(projectId: string, name: string, text: string): Promise<DatasetUploadResult>;
  applySplit(projectId: string, snapshotId: string, evalSize: number, testSize: number): Promise<void>;
  saveGold(projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source?: GoldLabel['source']): Promise<GoldLabel>;
  uploadGold(req: UploadGoldRequest): Promise<GoldUploadResult>;
  importBundledGold(projectId: string): Promise<GoldUploadResult>;
  /** Dataset's Check labels: the Labels helper reads a sample and may propose schema changes. */
  checkLabels(projectId: string, page: PageContext): Promise<AgentProposal | null>;
  /** Examples where versions disagree with the gold label, for one version (left out: the best). */
  mismatches(projectId: string, promptVersionId?: string | null): Promise<MismatchList>;
  reviewGold(req: ReviewGoldRequest): Promise<void>;
  /** Rebuild scores: works every archived score out again from the saved answers. Returns how many. */
  rebuildReports(projectId: string): Promise<number>;

  // Prompts, evaluation & optimiser
  /** Version numbers are assigned by the catalog, never by the browser. */
  createVersion(req: CreateVersionRequest): Promise<PromptVersion>;
  /** A click on Score, Resume or Rerun: always starts (the user's start). */
  scoreVersion(req: ScoreVersionRequest): Promise<void>;
  stopRun(runId: string): Promise<void>;
  /** Auto Optimise: the user starts a run of up to `maxRounds` changes on the project's model. */
  startOptimiser(req: StartOptimiserRequest): Promise<void>;
  stopOptimiser(runId: string): Promise<void>;
  /** Retry on a Failed (or paused) run: resumes from the step that failed. */
  retryOptimiser(runId: string): Promise<void>;
  /** Improve with AI: the Prompt helper drafts changes to a version and puts them in the editor (no labeling). */
  improveWithAi(projectId: string, promptVersionId: string): Promise<void>;
  /** Feature descriptions by key, for hover text (empty without a source). */
  featureInfo(keys: string[]): Promise<Record<string, FeatureInfo>>;
  /** A version's saved answers on one model, by example id. */
  predictionsFor(promptVersionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Record<string, Prediction>>;

  // Test set answers (Gold Labels) and the final run (train + test). Leaves with the 0.x Training Set step.
  labelTestSet(req: LabelTestSetRequest): Promise<LabelingTask>;
  startTrainingSet(req: StartTrainingSetRequest): Promise<TrainingSet>;
  stopTrainingSet(trainingSetId: string): Promise<void>;
  trainingRows(trainingSetId: string): Promise<TrainingRow[]>;

  // Assistant & proposals
  chatHistory(projectId: string): Promise<ChatMessage[]>;
  /** The turn running now, if any: who works, what it is doing, the reply so far. */
  getAgentLive(projectId: string): Promise<AgentLive | null>;
  /** Which helper answers the next message on this page: one that joined on it stays until the page changes. */
  getAnsweringAgent(projectId: string, page: PageContext): Promise<AgentPreset>;
  sendUserMessage(req: SendMessageRequest): Promise<AgentProposal | null>;
  openProposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]>;
  /** Open and approved proposals, oldest first (Ask AI cards). */
  proposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]>;
  closeProposal(req: CloseProposalRequest): Promise<void>;
}

/** What a client can listen to. `changes`: some record changed; `agent_live`: a running turn moved on. */
export type EventTopic = 'changes' | 'agent_live';

/**
 * Live updates, kept apart from the request/response contract: in-process it is the services' own
 * event bus, over HTTP it is Server-Sent Events or polling. An event carries no data; the listener
 * reads what it needs through the contract.
 */
export interface EventStreamPort {
  subscribe(topic: EventTopic, listener: () => void): () => void;
}

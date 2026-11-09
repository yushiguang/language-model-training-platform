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
  EvalReport,
  Example,
  FeatureSelection,
  GoldLabel,
  ModelSettings,
  NodeId,
  PageContext,
  Prediction,
  Project,
  ProjectState,
  PromptImage,
  PromptVersion,
  Schema,
  SetupVersion,
  TrainingRow,
  TrainingSet,
} from './types.ts';
import type {LabelingTask} from './labeling-api.ts';
import type {ExampleMedia} from './platform-api.ts';

/**
 * Contract 1: Frontend Web App <-> BFF Service (`@tsp/contracts/bff-api`).
 *
 * Every method is asynchronous and uses JSON-serialisable parameters and return types
 * (with browser `File` objects converted at the client boundary).
 * In the MVP, the client in `apps/web` delegates to `apps/bff` in-process; in production
 * microservice deployments, it swaps to `fetch()` calls against the remote Go BFF service.
 */

export type SetupPatch = Partial<Pick<SetupVersion, 'task' | 'schema' | 'thresholds' | 'models' | 'steps'>>;

export interface NewVersion {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  /** The version this one was edited from; null for the first version. */
  parent: PromptVersion | null;
  madeBy: Actor;
  change: string;
  kind: 'minor' | 'major';
  schema: Schema;
  schemaVersion: number;
}

export interface RuntimeInfo {
  user: {id: string; name: string};
  standIns: string[];
  endpoints: EndpointInfo[];
  hasBundledGold: boolean;
}

export interface BffContract {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  subscribeChanges(listener: () => void): () => void;

  // Projects & workflow gates
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  loadProjectState(projectId: string): Promise<ProjectState | null>;
  approveNode(projectId: string, node: NodeId): Promise<void>;
  skipGold(projectId: string): Promise<void>;

  // Setup
  saveSetup(projectId: string, patch: SetupPatch): Promise<SetupVersion>;

  // Dataset & Gold labels
  getSamplePoolSize(): Promise<number>;
  /** The media of one example, or null (no media source, or none for this example). */
  exampleMedia(exampleId: string): Promise<ExampleMedia | null>;
  startSampleDataset(projectId: string, count: number): Promise<DatasetSnapshot | null>;
  stopSampleDataset(projectId: string): void;
  uploadDatasetText(projectId: string, name: string, text: string): Promise<{snapshot?: DatasetSnapshot; error?: string}>;
  applySplit(projectId: string, snapshotId: string, evalSize: number, testSize: number): Promise<void>;
  saveGold(projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source?: GoldLabel['source']): Promise<GoldLabel>;
  uploadGold(projectId: string, schema: Schema, schemaVersion: number, examples: Example[], lines: {externalId: string; answer: Record<string, string[]>}[]): Promise<{saved: number; skipped: number}>;
  importBundledGold(projectId: string, schema: Schema, schemaVersion: number, examples: Example[]): Promise<{saved: number; skipped: number}>;

  // Prompts, evaluation & optimiser
  /** Version numbers are assigned by the catalog, never by the browser. */
  createVersion(projectId: string, v: NewVersion): Promise<PromptVersion>;
  /** A click on Score, Resume or Rerun: always starts (the user's start). */
  scoreVersion(projectId: string, version: PromptVersion, only?: EndpointId): Promise<void>;
  tick(state: ProjectState): Promise<void>;
  stopRun(runId: string): void;
  startOptimiser(projectId: string, endpoint: EndpointId): void;
  stopOptimiser(runId: string): void;
  predictionsFor(versionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Map<string, Prediction>>;

  // Test set answers (Gold Labels) and the final run (train + test)
  labelTestSet(projectId: string, version: PromptVersion, endpoint: EndpointId, estimateUsd: number): Promise<LabelingTask>;
  /** `labelTest`: also label the test examples that have no gold label and no answer from this version (the user ticked it in the confirm). */
  startTrainingSet(projectId: string, version: PromptVersion, endpoint: EndpointId, report: EvalReport | null, estimateUsd: number, opts?: {labelTest?: boolean; existing?: TrainingSet}): Promise<TrainingSet>;
  stopTrainingSet(tsId: string): void;

  trainingRows(tsId: string): Promise<TrainingRow[]>;

  // Assistant & proposals
  chatHistory(projectId: string): Promise<ChatMessage[]>;
  isAgentBusy(projectId: string): boolean;
  /** The turn running now, if any: who works, what it is doing, the reply so far (HTTP: SSE). */
  agentLive(projectId: string): AgentLive | null;
  subscribeAgentLive(listener: () => void): () => void;
  /** Which helper answers the next message on this page: one that joined on it stays until the page changes. */
  answeringAgent(projectId: string, page: PageContext): AgentPreset;
  sendUserMessage(projectId: string, text: string, page: PageContext, attachments?: ChatAttachment[]): Promise<AgentProposal | null>;
  openProposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]>;
  /** Open and approved proposals, oldest first (Ask AI cards). */
  proposals(projectId: string, kind: AgentProposal['kind']): Promise<AgentProposal[]>;
  closeProposal(p: AgentProposal, state: 'approved' | 'discarded'): Promise<void>;
}

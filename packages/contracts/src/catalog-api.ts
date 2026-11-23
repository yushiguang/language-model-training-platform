import type {DocUpdatePatch} from './platform-api.ts';
import type {
  AgentProposal,
  ChatMessage,
  DataSource,
  DatasetRemoval,
  DatasetSnapshot,
  EvalReport,
  Example,
  ExampleFeatures,
  FeatureRef,
  Features,
  GateApproval,
  GoldLabel,
  LabelComment,
  OptimisationRun,
  Project,
  PromptVersion,
  SetupVersion,
  SourceChunk,
  SourceCut,
  SourceFile,
  StartRequest,
} from './types.ts';

/**
 * Contract: catalog (`apps/catalog`) — the platform's CRUD.
 *
 * Owns every product record and the rules that keep them honest: versions are never overwritten,
 * version numbers are assigned here (never by the browser), and writes are partial so two writers
 * do not undo each other. Field names in filters are the records' own (camelCase) names.
 */

export interface AuditEntry {
  id: string;
  projectId: string | null;
  actor: string;
  action: string;
  data: object;
  createdAt: string;
}

export interface CatalogRecords {
  projects: Project;
  setup_versions: SetupVersion;
  dataset_snapshots: DatasetSnapshot;
  /** The index of a dataset's examples: never their features (#32). */
  examples: Example;
  /** Frozen features, one document per example, read by id only (#32). */
  example_features: ExampleFeatures;
  gold_labels: GoldLabel;
  dataset_removals: DatasetRemoval;
  label_comments: LabelComment;
  prompt_versions: PromptVersion;
  eval_reports: EvalReport;
  optimisation_runs: OptimisationRun;
  gate_approvals: GateApproval;
  chat_messages: ChatMessage;
  agent_proposals: AgentProposal;
  start_requests: StartRequest;
  audit_log: AuditEntry;
  /** Tenant records (#29): data sources belong to a tenant, never to a project. */
  data_sources: DataSource;
  source_files: SourceFile;
  source_chunks: SourceChunk;
  /** A project's segments of a source (#30); kept, retired, when the project is deleted. */
  source_cuts: SourceCut;
}

export type CatalogKind = keyof CatalogRecords;

/** A new prompt version before the catalog numbers it. */
/**
 * A new prompt version before the catalog numbers it. `kind`: 'major' = the next major (v5);
 * 'minor' = the next minor under the parent's major (v4.3), or under `inMajor` when given (an
 * Optimiser run's first change makes v5.1 under the major it reserved).
 */
export type NewPromptVersion = Omit<PromptVersion, 'id' | 'major' | 'minor' | 'createdAt'> & {kind: 'minor' | 'major'; inMajor?: number};

/** A new setup version before the catalog numbers it. */
export type NewSetupVersion = Omit<SetupVersion, 'id' | 'number' | 'createdAt'>;

export interface CatalogContract {
  insert<K extends CatalogKind>(kind: K, rec: CatalogRecords[K]): Promise<CatalogRecords[K]>;
  insertMany<K extends CatalogKind>(kind: K, recs: CatalogRecords[K][]): Promise<void>;
  get<K extends CatalogKind>(kind: K, id: string): Promise<CatalogRecords[K] | null>;
  /** Equality filters on record fields; `order` is "field" or "field desc". */
  find<K extends CatalogKind>(kind: K, where?: Partial<Record<keyof CatalogRecords[K] & string, unknown>>, order?: string): Promise<CatalogRecords[K][]>;
  findByIds<K extends CatalogKind>(kind: K, ids: string[]): Promise<CatalogRecords[K][]>;
  /** Partial update: only the given fields change. Values may be `DocFieldValue` operators (increment, arrayUnion...). */
  patch<K extends CatalogKind>(kind: K, id: string, patch: DocUpdatePatch<CatalogRecords[K]>): Promise<void>;
  /** Patches many records of one kind in one request. */
  patchMany<K extends CatalogKind>(kind: K, patches: {id: string; patch: Partial<CatalogRecords[K]>}[]): Promise<void>;
  /** Saves a prompt version with the next number in its line (Save) or the next major (Save as). */
  createPromptVersion(v: NewPromptVersion): Promise<PromptVersion>;
  /** Saves a setup version with the next number for its project. */
  createSetupVersion(v: NewSetupVersion): Promise<SetupVersion>;
  audit(projectId: string | null, actor: string, action: string, data?: object): Promise<void>;
  /** Removes a project and every catalog record it owns (examples by its dataset snapshots). */
  deleteProject(projectId: string): Promise<void>;
  /** Removes a data source file's staged chunks once its import has written them into the order (#29). */
  deleteStagedChunks(fileId: string): Promise<void>;
  /**
   * The frozen features of examples (#32), by example id (plain JSON), read by document id. An
   * example whose features document is missing is left out. Examples saved before #32 kept
   * their features on the example record; those are returned as they are.
   */
  exampleFeatures(examples: Pick<Example, 'id' | 'snapshotId' | 'externalId' | 'featureRef'>[]): Promise<Record<string, Features>>;
}

/** One example's frozen features, as the feature store finds them: by snapshot and item id, or by `featureRef`. */
export type FeatureItem = Pick<Example, 'snapshotId' | 'externalId' | 'featureRef'>;

/**
 * Where frozen feature snapshots are kept (#32, #58; docs/design/server.md 6): written once a
 * batch at a time when examples are taken, read a batch at a time, removed with their dataset.
 * The object-storage implementation packs each batch into one segment file and returns where each
 * example's features sit; the document-store one keeps one document per example, read by
 * `featureDocId`. The catalog reads and deletes through it, and dataset writes call `putBatch`
 * before saving the examples' index records, so an example never exists without its features.
 */
export interface FeatureStorePort {
  /**
   * Saves one batch of one snapshot. Returns, by `externalId`, where each was put: a
   * `FeatureRef` to store on the example, or null when it is found by its document id. Throws
   * when the batch was not stored (nothing of it is then referenced).
   */
  putBatch(snapshotId: string, docs: ExampleFeatures[]): Promise<Record<string, FeatureRef | null>>;
  /**
   * The features of these items, by `featureDocId(snapshotId, externalId)`. Items whose features
   * are not found are left out. Ranges of one segment file are read together.
   */
  getBatch(items: FeatureItem[]): Promise<Record<string, Features>>;
  /**
   * Removes these items' features; missing ones are skipped. **Caller's precondition**: pass
   * every item of each segment file at once (a whole snapshot), never a part of one: the
   * object-storage implementation keeps no index of its own and deletes every segment file the
   * items point to, whole, so the features of other items packed in it would be lost.
   */
  deleteBatch(items: FeatureItem[]): Promise<void>;
}

import type {DocUpdatePatch} from './platform-api.ts';
import type {
  AgentProposal,
  ChatMessage,
  DataSource,
  DatasetRemoval,
  DatasetSnapshot,
  EvalReport,
  Example,
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
  examples: Example;
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
}

import type {
  Actor,
  AgentLive,
  AgentPreset,
  AgentProposal,
  Answer,
  ChatAttachment,
  ChatMessage,
  ClientDiagnostics,
  Locale,
  DataSourceDetail,
  DataSourceSummary,
  DatasetSnapshot,
  EndpointId,
  EndpointInfo,
  ExampleType,
  Features,
  GoldLabel,
  LabelComment,
  LabelSet,
  ModelSettings,
  NodeId,
  PageContext,
  Prediction,
  Project,
  MismatchList,
  ProjectState,
  ProjectStatus,
  PromptVersion,
  RemovalReason,
  Schema,
  SourceFile,
  ProjectSettings,
  SamplingTask,
  StructuredPrompt,
  TenantModel,
} from './types.ts';
import type {ExampleMedia, FeatureInfo, PermissionPoint, TenantRole} from './platform-api.ts';

/**
 * Contract 1: Frontend Web App <-> BFF Service (`@yushiguang/sprint-contracts/bff-api`).
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

/** A new version as the services pass it around (never sent by the client; see `CreateVersionRequest`). */
export interface NewVersion {
  structured: StructuredPrompt;
  /** The version this one was edited from; null for the first version. */
  parent: PromptVersion | null;
  madeBy: Actor;
  change: string;
  kind: 'minor' | 'major';
  /** An Optimiser change: a minor in the run's own major. */
  inMajor?: number;
}

export interface RuntimeInfo {
  user: {id: string; name: string};
  standIns: string[];
  endpoints: EndpointInfo[];
  hasBundledGold: boolean;
  /** True when the platform can end the session: the avatar menu shows Sign out. */
  canSignOut?: boolean;
  /**
   * The caller's current tenant: the top bar names it, and admin pages show only to its admins.
   * Missing when the caller is not in it (the site then goes to the home page).
   */
  tenant?: TenantInfo;
}

/** The caller's current tenant (docs/design/server.md, 2). */
export interface TenantInfo {
  id: string;
  name: string;
  /** `admin`: the caller holds `tenant_write` (tenant settings, members, models, data sources). */
  role: TenantRole;
}

/** A tenant the caller is in, as the home page lists it (#94). */
export interface TenantSummary extends TenantInfo {
  /** Its projects (those being deleted left out). */
  projects: number;
}

/**
 * A member of the page's tenant (#107): the one list of members the pages read (label set
 * labelers, tenant settings). `name` is the platform's display name, or the user id when it has none.
 */
export interface TenantMemberView {
  userId: string;
  name: string;
  role: TenantRole;
}

/**
 * A new tenant (#94). The name is trimmed with its runs of spaces made one; it must not be empty
 * and no other tenant may have it (compared without case).
 */
export interface CreateTenantRequest {
  name: string;
}

/** The new tenant, its creator its admin; or why nothing was created (shown under the name field). */
export interface CreateTenantResult {
  tenant?: TenantSummary;
  error?: string;
}

/** The page's tenant with what its Admin cards count (#103). `members`: null without a permission platform. */
export interface TenantDetail extends TenantSummary {
  dataSources: number;
  models: number;
  members: number | null;
}

/**
 * One project as the tenant page lists it (#103): the step it is at (the step bar's rule), its best
 * current score, how many of its tasks run now (labeling, Optimiser, taking examples), and when
 * anything in it last changed.
 */
export interface ProjectRow {
  id: string;
  name: string;
  createdBy: string;
  createdById?: string;
  createdAt: string;
  step: NodeId;
  /** The best current report's Macro-F1 and its verdict; `rough` when too few examples have gold labels for a verdict. */
  best: {macroF1: number; passed: boolean; rough: boolean} | null;
  running: number;
  updatedAt: string;
}

/** A page of the tenant's projects, newest first; `mine`: only those the caller created. */
export interface ProjectRowsRequest {
  mine?: boolean;
  offset?: number;
  /** At most 50; 10 when left out. */
  limit?: number;
}

export interface ProjectRows {
  rows: ProjectRow[];
  /** Every project matching, for the pager. */
  total: number;
}

/** Thresholds as the new-project dialog sets them, as fractions (0.85); null = off. */
export interface NewProjectThresholds {
  macroF1: number;
  precision: number | null;
  recall: number | null;
}

/** What the new-project dialog starts from (#103): the models it offers, the one picked first, the thresholds. */
export interface ProjectDefaults {
  /** The tenant's models, else the platform's: the same list Project Settings offers. */
  models: {id: EndpointId; name: string}[];
  /** The tenant's default model, else the first in `models`; null when there is none. */
  model: EndpointId | null;
  thresholds: NewProjectThresholds;
}

/**
 * A new project from the dialog (#103). The name is tidied like a rename and must not be empty
 * (names may repeat). The model and thresholds are saved as its Project Settings, which count as
 * confirmed; left out, the defaults are used and confirmed later, as before.
 */
export interface NewProjectRequest {
  name: string;
  model?: EndpointId;
  thresholds?: NewProjectThresholds;
}

/** The new project; or why nothing was created (shown under the field it is about). */
export interface NewProjectResult {
  project?: Project;
  error?: string;
}

/**
 * Ask for a permission point the caller lacks (the "insufficient access" dialog). The request goes
 * to the external permission platform; Sprint approves nothing itself (docs/design/server.md, 2.2).
 */
export interface RequestAccessRequest {
  permission: PermissionPoint;
  /** The project, for `project_write`. */
  projectId?: string;
  /** Why the caller needs it, in their own words. Optional. */
  reason?: string;
}

export interface RequestAccessResult {
  /** Where the caller can follow the request on the permission platform, when it has such a page. */
  trackUrl?: string;
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
  /** The prompt's parts; the bff compiles the text the model reads. */
  structured: StructuredPrompt;
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
  /**
   * The value or values: `"Value"`, `["V1", "V2"]`, or `{label: "Value" | ["V1", "V2"]}` (the key
   * may be any single key when that is unambiguous). Checked against the label by `readGoldAnswer`.
   */
  answer: string | string[] | Record<string, string | string[]>;
}

export interface UploadGoldRequest {
  projectId: string;
  lines: GoldLine[];
}

/**
 * What an upload of labels did. Labels never add examples: a row for an item not in the dataset
 * is counted and skipped. A row whose answer is not an answer to the label is refused and named.
 */
export interface GoldUploadResult {
  /** Labels saved: new ones and changed ones. */
  saved: number;
  /** Rows not saved: not in the dataset, refused, or unreadable. */
  skipped: number;
  /** Of `saved`, how many replaced a different earlier label. */
  replaced?: number;
  /** Rows whose answer was already the item's label (nothing saved). */
  unchanged?: number;
  /** Rows for items that are not in the project's dataset. */
  notInDataset?: number;
  /** Rows refused, with why (in English), in file order. */
  refused?: GoldUploadRefusal[];
  /** The file could not be read at all (nothing saved). */
  error?: string;
}

export interface GoldUploadRefusal {
  /** The row in the file, counted from 1 (a CSV header is row 1). */
  row: number;
  /** The item id on the row ('' when it had none). */
  externalId: string;
  reason: string;
}

/** A file uploaded to a data source (#29): the source and the file, or why the file was refused. */
export interface SourceUploadResult {
  source?: DataSourceSummary;
  file?: SourceFile;
  error?: string;
}

/** Create a data source of the caller's tenant from its first file (#29). */
export interface CreateDataSourceRequest {
  name: string;
  fileName: string;
  text: string;
}

/** A tenant model as tenant settings show it (docs/design/server.md, 9). */
export interface TenantModelView extends TenantModel {
  /** Projects of the tenant whose settings use it: it cannot be removed while this is above 0. */
  usedBy: number;
}

/** Add a model to the caller's tenant. It becomes the default when the tenant has none. */
export interface AddModelRequest {
  name: string;
  /** The endpoint to call, as the model service names it. */
  endpoint: string;
  qpm: number;
  tpm: number;
}

/** Change a model's fields; left-out fields stay. Projects using it call the new values. */
export interface UpdateModelRequest {
  modelId: string;
  name?: string;
  endpoint?: string;
  qpm?: number;
  tpm?: number;
}

export interface ModelRequest {
  modelId: string;
}

/** A saved model, or why nothing was saved (shown on the form). */
export interface ModelSaveResult {
  model?: TenantModelView;
  error?: string;
}

/** A new name for a data source (trimmed, not empty, not another source's of the tenant). */
export interface RenameDataSourceRequest {
  sourceId: string;
  name: string;
}

/** The name as saved, or why nothing was saved (shown under the name field). */
export interface RenameDataSourceResult {
  name?: string;
  error?: string;
}

export interface DeleteDataSourceRequest {
  sourceId: string;
}

/**
 * Add a file to a data source; its items join the ones there (#29).
 * @deprecated One file is one data source (2026-11-22): upload a new data source instead.
 */
export interface AddSourceFileRequest {
  sourceId: string;
  fileName: string;
  text: string;
}

/** How many examples to take from one data source (#29, #30). */
export interface SourcePick {
  sourceId: string;
  count: number;
}

/**
 * Takes examples from one or more data sources into the eval dataset (#29): creates the dataset
 * when the project has none, or adds to it (Add examples). Each pick takes the next unused
 * segment of its source (#30); an item already in the dataset is skipped and the next one taken.
 */
export interface TakeExamplesRequest {
  projectId: string;
  picks: SourcePick[];
}

/** Remove examples from the eval dataset (soft delete with a trail, spec 1.0.0, 4.4). */
export interface RemoveExamplesRequest {
  projectId: string;
  exampleIds: string[];
  reason: RemovalReason;
  /** Why, in the person's words (optional; kept with the removal, cut to the comment length). */
  note?: string;
}

/**
 * The Dataset page's tabs (wireframe W-EvalDataset, #100): 'live' every sample in the dataset,
 * 'no_label' those without a gold label, 'mismatch' those whose gold label the model's answer
 * (`SamplePage.model`) does not match, 'removed' the removed ones.
 */
export type SampleFilter = 'live' | 'no_label' | 'mismatch' | 'removed';

/**
 * One page of the dataset's samples (docs/design/server.md 4.2). `filter` defaults to 'live'.
 * `query`: a sample ID, or a sample number. `sourceId` and `gold` narrow to one data source or to
 * samples whose gold label has that value. `sort`: by number (default) or sample ID, '-' first for
 * descending. `limit` defaults to 50, at most 500.
 */
export interface ListSamplesRequest {
  projectId: string;
  filter?: SampleFilter;
  /** Only the samples of this label set. */
  labelSetId?: string;
  query?: string;
  sourceId?: string;
  gold?: string;
  sort?: 'number' | '-number' | 'externalId' | '-externalId';
  offset?: number;
  limit?: number;
}

/** One sample as the Dataset page lists it. */
export interface SampleRow {
  number: number;
  exampleId: string;
  /** The sample ID from the data source. */
  externalId: string;
  type: ExampleType;
  /** The data source it was taken from; null for older datasets. */
  source: {id: string; name: string} | null;
  /** Has a gold label for the current label. */
  labeled: boolean;
  /** The gold label for the current label, or null. */
  gold: Answer | null;
  /** The answer of `SamplePage.model` on this sample; null with no such version or when its answer was stopped by the safety filter. */
  model: Answer | null;
  /** Has a gold label that `model` does not match. */
  mismatch: boolean;
  /** Set on removed samples: the removal to pass to `restoreExamples`, why, and the person's note. */
  removal: {id: string; reason: RemovalReason; note: string | null; removedBy: string; removedAt: string} | null;
}

export interface SamplePage {
  items: SampleRow[];
  /** How many samples match the filter, query and column filters in all. */
  total: number;
  /**
   * The version whose answers the page shows and mismatches are counted against: the best-scored
   * version of the current label with an answer on every gold-labeled sample (as the Mismatches
   * review picks it); null before there is one.
   */
  model: {versionId: string; label: string} | null;
  /** The tab counts, for the dataset as a whole (or the label set), before the query and column filters. */
  counts: Record<SampleFilter, number>;
}

/**
 * A label set with its counts: samples in its range that are not removed, how many of them have a
 * gold label, and how many of those disagree with the model (the Mismatch tab's rule, see `SampleRow`).
 */
export type LabelSetView = LabelSet & {samples: number; labeled: number; mismatch: number};

export interface LabelSetList {
  /** By number. */
  sets: LabelSetView[];
  /** Samples not removed and in no label set yet: what the next sets take from. */
  unassigned: number;
  /** Over the whole dataset (samples not removed, in a set or not): gold-labeled, and of those the mismatches. */
  labeled: number;
  mismatch: number;
}

/**
 * Creates one label set from the next `count` samples not in a set (removed ones are skipped and
 * not counted). `labelerIds`: at most one for now, a member of the tenant; they get project write.
 */
export interface CreateLabelSetRequest {
  projectId: string;
  count: number;
  name?: string;
  labelerIds?: string[];
}

/**
 * Splits every sample not in a set into label sets: `sets` of them (sizes as even as can be), or
 * `perSet` samples each (the last may be smaller). Give one of the two. `labelers`: the labeler of
 * each new set in order (null or missing for none); each must be a member of the tenant and gets
 * project write, as in `CreateLabelSetRequest`.
 */
export interface CreateLabelSetsRequest {
  projectId: string;
  sets?: number;
  perSet?: number;
  labelers?: (string | null)[];
}

/**
 * What creating would make, without saving (#107): `count` for one set (`createLabelSet`), or
 * `sets` / `perSet` for several (`createLabelSets`). Give one of the three.
 */
export interface PreviewLabelSetsRequest {
  projectId: string;
  count?: number;
  sets?: number;
  perSet?: number;
}

/** One set a create would make: the number and range it would get, and its samples (removed ones are skipped). */
export interface LabelSetPreview {
  number: number;
  first: number;
  last: number;
  samples: number;
}

/** The sets a create would make, in order, or why it would be refused (the message the create would give). */
export type LabelSetsPreview = {sets: LabelSetPreview[]; unassigned: number; error?: string};

/** Changes a label set's name or labelers; its range never changes. A field left out stays as it is. */
export interface UpdateLabelSetRequest {
  projectId: string;
  labelSetId: string;
  name?: string;
  labelerIds?: string[];
}

/** For the confirm dialog before saving a prompt: how many gold labels this label would clear. */
export interface GoldClearedRequest {
  projectId: string;
  structured: StructuredPrompt;
}

export interface RestoreExamplesRequest {
  projectId: string;
  removalIds: string[];
}

/**
 * Batch pruning on Dataset (spec 1.0.0, 4.3): 'unlabeled' removes examples with no gold label
 * down to `keep` of them; 'downsample' removes examples whose gold label has `value` in `field`,
 * at random, down to `keep`. Halves stay balanced; no other example changes half.
 */
export interface PruneDatasetRequest {
  projectId: string;
  mode: 'unlabeled' | 'downsample';
  value?: string;
  keep: number;
}

export interface AddCommentRequest {
  projectId: string;
  exampleId: string;
  text: string;
  /** The version compared on Mismatches, if any. */
  promptVersionId?: string | null;
}

export interface ReviewGoldRequest {
  projectId: string;
  exampleId: string;
  promptVersionId: string;
  outcome: 'kept' | 'changed';
  answer?: Answer;
  note?: string;
}

export interface SaveSettingsRequest extends ProjectSettings {
  projectId: string;
}

/** A run (a labeling task or an Optimiser run) of a project: the project id lets every call check ownership (review G2). */
export interface RunRequest {
  projectId: string;
  runId: string;
}

/** What a start created: the labeling tasks (runs) it queued, one per model. */
export interface StartedRuns {
  runIds: string[];
}

export interface DeleteProjectRequest {
  projectId: string;
}

/** Spec 1.1.0, 1.2: a new name for a project (trimmed, not empty, cut at `project.nameMaxChars`). */
export interface RenameProjectRequest {
  projectId: string;
  name: string;
}

export interface SendMessageRequest {
  projectId: string;
  text: string;
  page: PageContext;
  attachments?: ChatAttachment[];
  /** The language the user reads the site in: the helpers answer in it (spec 1.1.0, 2.3). */
  locale?: Locale;
  /** What the browser saw just before (spec 1.1.0, 3.2), for a problem report; kept for the turn only. */
  client?: ClientDiagnostics;
}

export interface BffContract {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  /** Ends the session; refused when the platform has no sign-out. */
  signOut(): Promise<void>;
  /** Sends a request for a permission point to the external permission platform. Any signed-in caller may ask. */
  requestAccess(req: RequestAccessRequest): Promise<RequestAccessResult>;

  // Tenants (#94). Which tenant a call is about is the channel's to say (the page's tenant):
  // see `BffDeps.tenant`. Both methods only need a signed-in caller.
  /** The tenants the caller is in, by name. */
  listTenants(): Promise<TenantSummary[]>;
  /** Creates a tenant; the caller becomes its admin. */
  createTenant(req: CreateTenantRequest): Promise<CreateTenantResult>;
  /** The members of the page's tenant, by name (#107). Any member may read them. */
  listTenantMembers(): Promise<TenantMemberView[]>;

  // Projects & workflow gates
  listProjects(): Promise<Project[]>;
  /** A page of the tenant page's project rows (#103). */
  listProjectRows(req: ProjectRowsRequest): Promise<ProjectRows>;
  /** The page's tenant and its Admin cards' counts (#103). */
  getTenant(): Promise<TenantDetail>;
  /** What the new-project dialog offers and starts from (#103). */
  projectDefaults(): Promise<ProjectDefaults>;
  /** Creates a project with its model and thresholds (the new-project dialog, #103). */
  newProject(req: NewProjectRequest): Promise<NewProjectResult>;
  /** Creates a project with default settings (scripts and tests; pages use `newProject`). */
  createProject(name: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  loadProjectState(projectId: string): Promise<ProjectState | null>;
  /**
   * The light read (review G9): the project's revision and its running work, without examples or
   * reports. Null for a project that does not exist (or is being deleted).
   */
  projectStatus(projectId: string): Promise<ProjectStatus | null>;
  approveNode(projectId: string, node: NodeId): Promise<void>;
  /** One check of what should be running in a project (keyed starts, safe to call often). */
  tick(req: TickRequest): Promise<void>;

  /**
   * Deletes a project for good. Returns once accepted: the project is gone from every read at
   * once, and a `project.delete` job stops its sampling, labeling and Optimiser runs, then removes
   * every record it owns (dataset, gold labels, versions, answers, reports, runs, chat) in bulk.
   */
  deleteProject(req: DeleteProjectRequest): Promise<void>;
  /** Renames a project (from Project Settings); returns the name as saved. */
  renameProject(req: RenameProjectRequest): Promise<string>;

  // Project Settings (the pass rule and the labeling model). Saving also confirms them.
  saveSettings(req: SaveSettingsRequest): Promise<void>;

  // Data Source (#29): tenant scope, shared by the tenant's projects. One file is one data source.
  /** The caller's tenant's data sources, the built-in sample data included, newest first. */
  listDataSources(): Promise<DataSourceSummary[]>;
  /** One data source and its files; null when it is not the caller's tenant's. */
  getDataSource(sourceId: string): Promise<DataSourceDetail | null>;
  /** Creates a data source from its first file; the import runs as a `source.ingest` job. */
  createDataSource(req: CreateDataSourceRequest): Promise<SourceUploadResult>;
  /**
   * Adds a file to a data source; items already in it are counted as repeats and left out.
   * @deprecated One file is one data source (2026-11-22): pages upload a new data source instead.
   */
  addSourceFile(req: AddSourceFileRequest): Promise<SourceUploadResult>;
  /** Renames a data source (tenant admins). The built-in sample data keeps its name. */
  renameDataSource(req: RenameDataSourceRequest): Promise<RenameDataSourceResult>;
  /**
   * Deletes a data source (tenant admins): it leaves every list and no dataset takes from it
   * again; examples already in datasets stay. Cannot be undone. The built-in sample data stays.
   */
  deleteDataSource(req: DeleteDataSourceRequest): Promise<void>;

  // Tenant models (docs/design/server.md, 9): every member lists them; tenant admins change them.
  /** The caller's tenant's models, the default first. */
  listModels(): Promise<TenantModelView[]>;
  /** Adds a model; it becomes the default when the tenant has none (its first model). */
  addModel(req: AddModelRequest): Promise<ModelSaveResult>;
  /** Changes a model; calls use the new values within the gateway's cache time (30 s). */
  updateModel(req: UpdateModelRequest): Promise<ModelSaveResult>;
  /** Removes a model; refused (`error`) while a project uses it. Removing the default leaves none. */
  removeModel(req: ModelRequest): Promise<{error?: string}>;
  /** Makes a model the default that new projects use. */
  setDefaultModel(req: ModelRequest): Promise<ModelSaveResult>;

  // Dataset & Gold labels
  /** The media of one example, or null (no media source, or none for this example). */
  exampleMedia(projectId: string, exampleId: string): Promise<ExampleMedia | null>;
  /**
   * Examples' frozen features by example id (#32): Gold Labels reads the one shown. Project state
   * carries examples without their features. An example whose features document is missing is left out.
   */
  getExampleFeatures(projectId: string, exampleIds: string[]): Promise<Record<string, Features>>;
  /**
   * Takes examples from data sources: a new eval dataset, or more examples for the one there.
   * Returns once queued (a `dataset.sample` job): progress is read back as
   * `ProjectState.samplingTask`, and the examples appear when they are saved.
   */
  takeExamples(req: TakeExamplesRequest): Promise<SamplingTask>;
  stopSampleDataset(projectId: string): Promise<void>;
  saveGold(projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source?: GoldLabel['source']): Promise<GoldLabel>;
  uploadGold(req: UploadGoldRequest): Promise<GoldUploadResult>;
  /**
   * Upload labels from a file (#31): CSV with an item id and an answer column, or JSONL lines
   * (see `readLabelFile`). Rows are matched to the examples already in the dataset and checked
   * against the label; re-uploading replaces earlier labels and is audited.
   */
  uploadGoldText(projectId: string, name: string, text: string): Promise<GoldUploadResult>;
  importBundledGold(projectId: string): Promise<GoldUploadResult>;
  /** Examples where versions disagree with the gold label, for one version (left out: the best). */
  mismatches(projectId: string, promptVersionId?: string | null): Promise<MismatchList>;
  reviewGold(req: ReviewGoldRequest): Promise<void>;
  /** Removes examples (soft delete, each with a `DatasetRemoval`). */
  removeExamples(req: RemoveExamplesRequest): Promise<void>;
  /** One page of the dataset's samples, by number (no features). Empty without a dataset. */
  listSamples(req: ListSamplesRequest): Promise<SamplePage>;
  /** The project's label sets with their counts. */
  listLabelSets(projectId: string): Promise<LabelSetList>;
  /** The ranges a create would cut now, without saving (the create dialogs' preview). */
  previewLabelSets(req: PreviewLabelSetsRequest): Promise<LabelSetsPreview>;
  createLabelSet(req: CreateLabelSetRequest): Promise<LabelSet>;
  createLabelSets(req: CreateLabelSetsRequest): Promise<LabelSet[]>;
  updateLabelSet(req: UpdateLabelSetRequest): Promise<LabelSet>;
  /**
   * How many gold labels saving this prompt would clear: those whose answer is no longer an
   * answer to its label (a value removed or renamed, single choice where there were two). 0 when
   * the label signature does not change. Cleared labels stay as hidden hints.
   */
  goldLabelsCleared(req: GoldClearedRequest): Promise<number>;
  /** Puts removed examples back, in their old half. */
  restoreExamples(req: RestoreExamplesRequest): Promise<void>;
  /** Batch pruning; returns how many examples it removed. */
  pruneDataset(req: PruneDatasetRequest): Promise<number>;
  /** Adds a comment to an example (append-only). */
  addComment(req: AddCommentRequest): Promise<LabelComment>;
  /**
   * Rebuild scores: works every archived score out again from the saved answers, in the request.
   * Returns how many. @deprecated Use `rescore`; kept for the current Prompt versions page.
   */
  rebuildReports(projectId: string): Promise<number>;
  /**
   * Rescore (docs/design/server.md 4.3): queues one job that works the out-of-date scores out
   * again on today's basis from the saved answers; nothing is labeled. Refused while a label set
   * is unfinished. A second click while it is queued or running adds nothing.
   */
  rescore(projectId: string): Promise<void>;

  // Prompts, evaluation & optimiser
  /**
   * Saves a structured prompt as a new version. Version numbers are assigned by the catalog. A
   * change to the label signature (field or value names, kind, bounds) bumps the schema version.
   */
  createVersion(req: CreateVersionRequest): Promise<PromptVersion>;
  /**
   * A click on Score, Resume or Rerun: always starts (the user's start). Returns once the labeling
   * is queued (a `labeling.runTask` job per model, then `report.build`), with the tasks' ids;
   * progress and the report are read back through `loadProjectState`.
   */
  scoreVersion(req: ScoreVersionRequest): Promise<StartedRuns>;
  stopRun(req: RunRequest): Promise<void>;
  /**
   * Auto Optimise: the user starts a run of up to `maxRounds` changes on the project's model (or
   * goes on with the open one). Returns once queued (an `optimiser.run` job), with the run's id.
   */
  startOptimiser(req: StartOptimiserRequest): Promise<{runId: string}>;
  stopOptimiser(req: RunRequest): Promise<void>;
  /** Retry on a Failed (or paused) run: queues it again; it resumes from the step that failed. */
  retryOptimiser(req: RunRequest): Promise<{runId: string}>;
  /**
   * Improve with AI: a Prompt helper turn that drafts changes to a version and puts them in the
   * editor (no labeling). Returns once the turn is accepted, with its id, like a chat message; Ask
   * AI follows it.
   */
  improveWithAi(projectId: string, promptVersionId: string, locale?: Locale): Promise<{turnId: string}>;
  /** Feature descriptions by key, for hover text (empty without a source). */
  featureInfo(keys: string[]): Promise<Record<string, FeatureInfo>>;
  /** A version's saved answers on one model, by example id. */
  predictionsFor(projectId: string, promptVersionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Record<string, Prediction>>;

  // Assistant & proposals
  chatHistory(projectId: string): Promise<ChatMessage[]>;
  /** The turn running now, if any: who works, what it is doing, the reply so far. */
  getAgentLive(projectId: string): Promise<AgentLive | null>;
  /** Which helper answers the next message on this page: one that joined on it stays until the page changes. */
  getAnsweringAgent(projectId: string, page: PageContext): Promise<AgentPreset>;
  /**
   * Accepts an Ask AI message and returns once it is saved and its turn has started (deployment
   * readiness spec, 6). The turn runs on: its live line is read with `getAgentLive` (null again
   * when it ended), and its messages and any draft appear in `chatHistory` and `openProposals`.
   */
  sendUserMessage(req: SendMessageRequest): Promise<{turnId: string}>;
  openProposals(projectId: string): Promise<AgentProposal[]>;
  /** Open and approved proposals, oldest first (Ask AI cards). */
  proposals(projectId: string): Promise<AgentProposal[]>;
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

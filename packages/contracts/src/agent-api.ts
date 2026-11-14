import type {AgentModel, RawExample} from './platform-api.ts';
import type {
  AgentPreset,
  Answer,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  FieldMetrics,
  Locale,
  Msg,
  MixUp,
  PageContext,
  PageView,
  StructuredPrompt,
  StructuredPromptProposal,
} from './types.ts';

/**
 * Contract 2: BFF <-> Agent Runtime Service (`@tsp/contracts/agent-api`).
 *
 * The BFF service (`apps/bff`) owns persistence, state orchestration, and database records.
 * The Agent service (`apps/agents`) is a stateless, DB-free runtime that receives a serialisable
 * workspace snapshot + user message, runs multi-turn reasoning / handoffs / validation loops
 * against `AgentModel`, and returns the resulting chat messages and structured proposals.
 *
 * Because inputs and outputs are plain JSON, `apps/agents` can run in-process during the MVP
 * and later be deployed as a standalone microservice or translated to Go without changing callers.
 */

export interface AgentWorkspaceSnapshot {
  projectId: string;
  task: string;
  /** The structured prompt the user is looking at: the page's unsaved draft, else the newest version's. */
  prompt: StructuredPrompt | null;
  /** Recent conversation history in chronological order. */
  history: Pick<ChatMessage, 'role' | 'agent' | 'text' | 'page' | 'createdAt'>[];
  /** Example posts resolved from IDs mentioned in user attachments. */
  attachedExamples?: RawExample[];
  /** The page the user is on, as the agent sees it. Sent with every turn. */
  pageView: PageView | null;
}

/**
 * Read tools: an agent explores the project beyond the current page, the way a coding agent
 * reads files in a repo. They run as the signed-in user, change nothing and cost nothing.
 * Changes stay proposals (a structured prompt in the answer). Start-work tools come later.
 */
export type AgentToolName =
  | 'get_page_view'
  | 'list_versions'
  | 'get_version'
  | 'get_report'
  | 'get_examples'
  | 'get_gold_labels'
  | 'get_predictions'
  | 'check_prompt'
  /** Feature descriptions by key (what a feature holds, when it helps, its caveats). */
  | 'read_feature_info'
  /** A document the user linked in Ask AI, as text. */
  | 'read_doc'
  // 1.0.0 (spec 6.4): richer reads and diagnostics.
  /** Steps, settings, the eval dataset in numbers and the best version, in one call. */
  | 'get_project_summary'
  /** The eval dataset's label balance: values per half, rare and dominant values, pending and removed counts. */
  | 'get_dataset_stats'
  /** Examples whose text features or title contain words; the readable half and unlabeled examples only. */
  | 'search_examples'
  /** Two versions side by side: what changed in the prompt and the scores per field. */
  | 'compare_versions'
  /** Mismatches between a version and the gold labels, as counts only. */
  | 'get_mismatch_summary'
  // Start-work tools: paid. They run at once when automatic starts are allowed, else they ask
  // the user with a card in the chat and the turn ends.
  | 'try_prompt'
  | 'score_version'
  | 'start_optimiser'
  // 1.1.0 (spec 3): every helper can file a problem report; it sends only after the user says yes.
  /** Drafts a problem report, or sends the draft (`send: true`) once the user has agreed. */
  | 'report_problem';

export interface AgentToolCall {
  agent: AgentPreset;
  name: AgentToolName;
  args: Record<string, unknown>;
}

/** Runs read tools for the agent runtime. In-process now; a callback to the bff's API when split. */
export interface AgentToolHost {
  call(call: AgentToolCall): Promise<unknown>;
}


export interface AgentTurnInput {
  userText: string;
  page: PageContext;
  attachments?: ChatAttachment[];
  workspace: AgentWorkspaceSnapshot;
  /** The language the user reads the site in; helpers answer in it (spec 1.1.0, 2.3). Default English. */
  locale?: Locale;
}

export interface AgentEmittedMessage {
  role: 'agent' | 'event';
  agent: AgentPreset | null;
  text: string;
  /** Action lines: the line as a catalog key (spec 1.1.0, 2.3). */
  msg?: Msg;
  choices?: string[];
  event?: ChatEvent;
}

/**
 * Live progress of a turn, reported while it runs: a message as soon as it is final (the host
 * saves it then), what an agent is doing (`working`), and its reply as it streams (`reply`).
 */
export type AgentTurnEvent = {message: AgentEmittedMessage} | {agent: AgentPreset; working: string; msg?: Msg} | {agent: AgentPreset; reply: string};

/** The runtime's own way to report a turn's progress (inside `apps/agents`). */
export type AgentTurnProgress = (p: AgentTurnEvent) => void;

/**
 * Where the runtime publishes live progress (spec 1.0.0, 7.1.3): a port injected at
 * construction, not a callback passed with each call. `turnId` is the one the request carried.
 */
export interface AgentProgressPort {
  publish(projectId: string, turnId: string, event: AgentTurnEvent): void;
}

/** A structured prompt the Prompt helper proposes; the user approves or saves it on the page. */
export interface AgentProposalDraft {
  kind: 'prompt';
  agent: AgentPreset;
  brief: string;
  payload: StructuredPromptProposal;
}

export interface AgentTurnOutput {
  /** Audit trail of agent invocations executed during this turn (including handoffs). */
  invocations: {
    from: AgentPreset | 'system' | 'user';
    to: AgentPreset;
    intent: string;
    note: string;
  }[];
  /** Messages to append to the project's chat log in order. */
  messages: AgentEmittedMessage[];
  /** A structured prompt proposal, when the Prompt helper wrote or changed one. */
  proposal: AgentProposalDraft | null;
  /** Read tools the agents called during this turn, in order (also written to the audit log by the host). */
  toolCalls: {agent: AgentPreset; name: string; args: Record<string, unknown>; ok: boolean; ms: number}[];
  /** Model calls in this turn (tool loops included), and answers that weren't the asked JSON. For metrics. */
  modelCalls: {agent: AgentPreset; model: string}[];
  parseFailures: {agent: AgentPreset; intent: string}[];
}

/** One example a helper may read and cite (R3-9). Always from the optimiser half, never the held-out half. */
export interface ExampleBrief {
  externalId: string;
  /** Text features the prompt uses, each cut to about 300 characters. */
  features: Record<string, string>;
  /**
   * Up to 2 image URLs of the example (cover or frames; review finding 8), sent to the model as
   * images after the text, so a mistake whose cause is in the picture can be seen.
   */
  images?: string[];
  gold: Answer;
  /** The model's answer (in a merge: from the version that misses it); null when it gave no valid answer. */
  predicted: Answer | null;
  /** The labeling model's own short reason for `predicted`, when it gave one (decided 2026-11-11). */
  reason?: string;
  /** Why the site could not read the model's reply as an answer ("Not valid JSON", a value that is not in the labels…). */
  invalid?: string;
  /**
   * People's comments on the example, oldest first (spec 1.0.0, 5.4): their reasoning about what
   * the gold label means, not a hint from the model. Optimiser-half examples only: comments on the
   * held-out half never reach a helper.
   */
  comments?: string[];
  /** Merge only: the version that gets this example right ('template': the first, 'other': the second). */
  rightIn?: 'template' | 'other';
}

export interface OptimiserReflectInput {
  /** 'change': one change from the parent's mistakes. 'merge': combine `prompt` with `other`. */
  mode?: 'change' | 'merge';
  /** The parent's structured prompt. Field and value names are fixed: only wording and features change. */
  prompt: StructuredPrompt;
  triedChanges: string[];
  mixUps: MixUp[];
  lowestField: Pick<FieldMetrics, 'field' | 'macroF1'>;
  lowestValue: {field: string; value: string; f1: number} | null;
  /**
   * Change: up to 8 examples of the optimiser half the parent gets wrong, worst first. Merge: up to
   * 4 examples each version gets right that the other misses (`rightIn`).
   */
  examples?: ExampleBrief[];
  /** Merge only: the second version. */
  other?: {prompt: StructuredPrompt; change: string};
  signal?: AbortSignal;
}

export interface OptimiserReflectOutput {
  /** The changed prompt, with the parent's field and value names. */
  prompt: StructuredPrompt;
  change: string;
}

/** Improve with AI: the Prompt helper drafts several changes to a version, each with a reason. */
export interface DraftImprovementInput {
  version: string;
  prompt: StructuredPrompt;
  mixUps: MixUp[];
  lowestField: Pick<FieldMetrics, 'field' | 'macroF1'>;
  lowestValue: {field: string; value: string; f1: number} | null;
  /** Mistakes on the eval set, with the gold label and the model's answer. */
  mistakes: number;
  /** Up to 8 examples of the optimiser half the version gets wrong, worst first (never the held-out half). */
  examples?: ExampleBrief[];
}

export interface DraftImprovementOutput {
  prompt: StructuredPrompt;
  /** One entry per change: `text` quotes the words it adds (or removes); `reason` shows on hover over its mark in the editor and in Ask AI. */
  changes: {text: string; reason: string}[];
  /** A few lines for Ask AI. */
  reply: string;
}

/**
 * What the agent runtime is built with (spec 1.0.0, 7.1.3): the model, the tools of a project and
 * the progress port are injected once, so every call below is plain data in and out.
 */
export interface AgentRuntimeDeps {
  /** The model the helpers run on (the gateway's agent model). */
  llm: AgentModel;
  /** The read and start-work tools of one project, run as the signed-in user. */
  tools(projectId: string): AgentToolHost;
  /** Live progress of Ask AI turns; without it, turns report nothing while they run. */
  progress?: AgentProgressPort;
}

/** One Ask AI turn: the input plus the id its progress is published under. */
export interface AgentTurnRequest extends AgentTurnInput {
  turnId: string;
}

/** One Optimiser change (or merge), for a project; `requestId` lets the caller cancel it. */
export interface OptimiserReflectRequest extends Omit<OptimiserReflectInput, 'signal'> {
  projectId: string;
  requestId?: string;
}

/** Improve with AI, for a project. */
export interface DraftImprovementRequest extends DraftImprovementInput {
  projectId: string;
}

/** The agent runtime as the bff sees it (implemented by `apps/agents`, `createAgentRuntime`). */
export interface AgentRuntimeContract {
  /** One Ask AI turn; progress goes to the injected `AgentProgressPort` under `turnId`. */
  runTurn(req: AgentTurnRequest): Promise<AgentTurnOutput>;
  /** One Optimiser change (or merge); the project's tools let it read feature descriptions. */
  reflectPrompt(req: OptimiserReflectRequest): Promise<OptimiserReflectOutput>;
  /** Improve with AI: a draft with several marked changes, for the user to review and save. */
  draftImprovement(req: DraftImprovementRequest): Promise<DraftImprovementOutput>;
  /** Stops a request started with a `requestId` (the Optimiser's Stop); unknown ids are ignored. */
  cancel(requestId: string): Promise<void>;
}

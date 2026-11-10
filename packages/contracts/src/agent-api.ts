import type {AgentModel, RawExample} from './platform-api.ts';
import type {
  AgentPreset,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  FeatureSelection,
  FieldMetrics,
  MixUp,
  PageContext,
  PageView,
  Schema,
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
  /** Current active or proposed schema, if any. */
  schema: Schema | null;
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
 * Changes stay proposals (a schema or a template in the answer). Start-work tools come later.
 */
export type AgentToolName =
  | 'get_page_view'
  | 'list_versions'
  | 'get_version'
  | 'get_report'
  | 'get_examples'
  | 'get_gold_labels'
  | 'get_predictions'
  | 'check_template'
  /** Feature descriptions by key (what a feature holds, when it helps, its caveats). */
  | 'read_feature_info'
  // Start-work tools: paid. They run at once when automatic starts are allowed, else they ask
  // the user with a card in the chat and the turn ends.
  | 'try_template'
  | 'score_version'
  | 'start_optimiser';

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
}

export interface AgentEmittedMessage {
  role: 'agent' | 'event';
  agent: AgentPreset | null;
  text: string;
  choices?: string[];
  event?: ChatEvent;
}

/**
 * Live progress of a turn, reported while it runs: a message as soon as it is final (the host
 * saves it then), what an agent is doing (`working`), and its reply as it streams (`reply`).
 */
export type AgentTurnProgress = (p: {message: AgentEmittedMessage} | {agent: AgentPreset; working: string} | {agent: AgentPreset; reply: string}) => void;

export type AgentProposalDraft =
  | {
      kind: 'schema';
      agent: AgentPreset;
      brief: string;
      payload: Schema;
    }
  | {
      kind: 'prompt';
      agent: AgentPreset;
      brief: string;
      payload: {
        template: string;
        features?: FeatureSelection;
        change?: string;
      };
    };

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
  /** Optional schema or prompt proposal produced by the specialist agent. */
  proposal: AgentProposalDraft | null;
  /** Read tools the agents called during this turn, in order (also written to the audit log by the host). */
  toolCalls: {agent: AgentPreset; name: string; args: Record<string, unknown>; ok: boolean; ms: number}[];
  /** Model calls in this turn (tool loops included), and answers that weren't the asked JSON. For metrics. */
  modelCalls: {agent: AgentPreset; model: string}[];
  parseFailures: {agent: AgentPreset; intent: string}[];
}

export interface OptimiserReflectInput {
  /** 'change': one change from the parent's mistakes. 'merge': combine `template` with `other`. */
  mode?: 'change' | 'merge';
  template: string;
  features: FeatureSelection;
  schema: Schema;
  triedChanges: string[];
  mixUps: MixUp[];
  lowestField: Pick<FieldMetrics, 'field' | 'macroF1'>;
  lowestValue: {field: string; value: string; f1: number} | null;
  /** Merge only: the second version, and the examples each version gets right that the other misses. */
  other?: {template: string; features: FeatureSelection; change: string};
  signal?: AbortSignal;
}

export interface OptimiserReflectOutput {
  template: string;
  /** Ticked features after the change (unchanged when missing). */
  features?: FeatureSelection;
  change: string;
}

/** Improve with AI: the Prompt helper drafts several changes to a version, each with a reason. */
export interface DraftImprovementInput {
  version: string;
  template: string;
  features: FeatureSelection;
  schema: Schema;
  mixUps: MixUp[];
  lowestField: Pick<FieldMetrics, 'field' | 'macroF1'>;
  lowestValue: {field: string; value: string; f1: number} | null;
  /** Mistakes on the eval set, with the gold label and the model's answer. */
  mistakes: number;
}

export interface DraftImprovementOutput {
  template: string;
  features?: FeatureSelection;
  /** One entry per change: `text` quotes the words it adds (or removes); `reason` shows on hover over its mark in the editor and in Ask AI. */
  changes: {text: string; reason: string}[];
  /** A few lines for Ask AI. */
  reply: string;
}

/** The agent runtime as the bff sees it (implemented by `apps/agents`). */
export interface AgentRuntimeContract {
  runAgentTurn(input: AgentTurnInput, llm: AgentModel, tools?: AgentToolHost, progress?: AgentTurnProgress): Promise<AgentTurnOutput>;
  /** One Optimiser change (or merge). `tools` lets it read feature descriptions. */
  reflectPrompt(input: OptimiserReflectInput, llm: AgentModel, tools?: AgentToolHost): Promise<OptimiserReflectOutput>;
  /** Improve with AI: a draft with several marked changes, for the user to review and save. */
  draftImprovement(input: DraftImprovementInput, llm: AgentModel, tools?: AgentToolHost): Promise<DraftImprovementOutput>;
}

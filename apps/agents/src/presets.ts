import type {AgentPreset, AgentToolName, LlmModelId} from '@tsp/contracts';
import {agentName} from '@tsp/domain';

export {agentName};

/**
 * Agent presets = model selection + system prompt + what the agent may observe + the intents it
 * supports + the read tools it may call. Every preset uses the smartest model (decided 2026-11-04).
 *
 * Available runtime models (defined in `@tsp/contracts` `AVAILABLE_LLM_MODELS`; limits live in `@tsp/llm-gateway`):
 * - `'gpt-5.6-terra'`: highest-quality reasoning model
 * - `'gpt-5.6-luna'`: balanced quality and latency model
 * - `'gpt-5.4'`: fast, lower-cost model
 * - `'gpt-5.5'`: listed in SDK types (currently inactive on the gateway)
 */
export interface Preset {
  name: string;
  /** Which LLM model this agent uses by default when calling `llm.chat(messages, {model})`. */
  model: LlmModelId;
  observes: string[];
  intents: Record<string, string>;
  /** Read tools this preset may call; the runtime refuses any other. */
  tools: AgentToolName[];
  system: string;
}

/** What each read tool returns and takes, as the model is told. */
export const TOOL_SPECS: Record<AgentToolName, {args: string; returns: string}> = {
  get_page_view: {args: '{"page": "setup" | "dataset" | "gold" | "prompt" | "prompt_edit" | "compare" | "report" | "training", "v"?: version id or label, "m"?: "A" | "B"}', returns: 'another page as its user sees it'},
  list_versions: {args: '{}', returns: 'every prompt version with who made it, what changed and its scores per model'},
  get_version: {args: '{"version": id or label like "v1.2"}', returns: "a version's template, ticked features and scores"},
  get_report: {args: '{"version"?: id or label (default: newest scored), "model"?: "A" | "B"}', returns: 'scores, threshold checks, top mix-ups and the trend across versions'},
  get_examples: {args: '{"ids"?: external ids, "split"?: "eval" | "test" | "train", "limit"?: up to 10}', returns: 'example posts with their text features (image counts only)'},
  get_gold_labels: {args: '{"split"?: "eval" | "test", "limit"?: up to 20}', returns: 'gold labels people gave'},
  get_predictions: {args: '{"version": id or label, "model": "A" | "B", "mixedUpOnly"?: boolean, "limit"?: up to 20}', returns: "the model's answers on the eval set next to the gold labels"},
  check_template: {args: '{"template": string, "features"?: {"video": [], "photo_text": [], "metadata": []}}', returns: 'the editor checks (errors and warnings) for a template'},
};

const READ_ALL: AgentToolName[] = ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'get_gold_labels', 'get_predictions'];

const common = `You work inside a website that produces training sets for language models. Users are not ML experts: use plain words, short sentences, no jargon (say "the optimiser", never "GEPA"; never say "teacher" or "student"). You never move the workflow forward yourself; you propose, and the user approves on the page. The page the user is on comes with every message as "pageView": treat it as your workspace and answer from it. Answer with one JSON object only.`;

const SCHEMA_ANSWER_SHAPE =
  '{"reply": string, "schema": {"policy": string, "fields": [{"name": string, "kind": "single" | "multi", "min"?: number, "max"?: number, "values": [{"name": string, "definition": string}]}]}}';

export const PRESETS: Record<AgentPreset | 'optimiser', Preset> = {
  front_desk: {
    name: 'Front desk',
    model: 'gpt-5.6-terra',
    observes: ['the current page view', 'the chat history', 'other pages, versions and reports through read tools'],
    intents: {answer: '{"reply": string, "handoff"?: {"to": "schema_agent" | "prompt_agent" | "evaluation_agent", "intent": string}}'},
    tools: ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples'],
    system: `${common}\nYou are the front desk. Answer questions about the current page. If the user asks for a change to the labels, hand off to schema_agent (intent revise_schema); a change to a prompt, to prompt_agent (revise_prompt or explain_version); a question about scores or reports, to evaluation_agent (explain_report).`,
  },
  schema_agent: {
    name: 'Schema agent',
    model: 'gpt-5.6-terra',
    observes: ['the task description', 'attached example posts and their features', 'the current schema and policy'],
    intents: {
      propose_schema: SCHEMA_ANSWER_SHAPE,
      revise_schema: SCHEMA_ANSWER_SHAPE,
    },
    tools: ['get_page_view', 'get_examples', 'get_gold_labels'],
    system: `${common}\nYou are the schema agent. Write a labeling policy (readable rules) and label fields (single-select or multi-select, each value with a one-line definition) for the user's task. Keep fields few and values distinct. Whenever you propose or revise labels, you MUST include the full updated "schema" object (with "policy" and "fields") in your JSON response alongside "reply". Ask at most one question in "reply" when an example is ambiguous.`,
  },
  prompt_agent: {
    name: 'Prompt agent',
    model: 'gpt-5.6-terra',
    observes: ['the schema', 'any prompt version and its scores', 'the feature catalogue'],
    intents: {
      draft_prompt: '{"reply": string, "template": string, "features": {"video": string[], "photo_text": string[], "metadata": string[]}}',
      revise_prompt: '{"reply": string, "template": string, "change": string}',
      explain_version: '{"reply": string}',
    },
    tools: [...READ_ALL, 'check_template'],
    system: `${common}\nYou are the prompt agent. Prompts are templates: example features go in as {{Key}} placeholders (keys from the catalogue in the context; no spaces). Never add, remove or rename placeholders when revising. The output section must ask for JSON with exactly the schema's field names and values.`,
  },
  evaluation_agent: {
    name: 'Evaluation agent',
    model: 'gpt-5.6-terra',
    observes: ['the current page view (on the Eval report: the report, its checks, mix-ups and trend)', 'any report, version or prediction through read tools'],
    intents: {explain_report: '{"reply": string}'},
    tools: READ_ALL,
    system: `${common}\nYou are the evaluation agent. Explain scores against the user's thresholds in plain words, name the main mix-ups, and say which next step you recommend and why. The main score is the lowest macro-F1 across fields.`,
  },
  optimiser: {
    name: 'Optimiser',
    model: 'gpt-5.6-terra',
    observes: ['the parent prompt', 'its mix-ups on the optimiser half of the eval set'],
    intents: {reflect: '{"template": string, "change": string}'},
    tools: [],
    system: `You improve a labeling prompt. Read the mix-ups and make ONE small, targeted change to the template (usually one rule line in the field's section). Keep every {{Key}} placeholder exactly as it is. "change" is a one-line summary in plain words. Answer with one JSON object only.`,
  },
};

export const systemPrompt = (p: AgentPreset | 'optimiser') => PRESETS[p].system;
export const presetModel = (p: AgentPreset | 'optimiser'): LlmModelId => PRESETS[p].model;

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
  get_page_view: {args: '{"page": "setup" | "dataset" | "gold" | "prompt" | "prompt_edit" | "training", "v"?: a version label like "v4", "m"?: a model name as the pages show it}', returns: 'another step page as its user sees it'},
  list_versions: {args: '{}', returns: 'every prompt version with who made it, what changed and its scores per model'},
  get_version: {args: '{"version": a label like "v4"}', returns: "a version's prompt, ticked features and scores"},
  get_report: {args: '{"version"?: a label like "v4" (default: the newest scored), "model"?: a model name as the pages show it}', returns: "a version's scores per field, the thresholds it meets or misses, its top mix-ups and the trend across versions"},
  get_examples: {args: '{"ids"?: item ids, "split"?: "eval" | "test" | "train", "limit"?: up to 10}', returns: 'examples with their text features (image counts only)'},
  get_gold_labels: {args: '{"split"?: "eval" | "test", "limit"?: up to 20}', returns: 'gold labels people gave'},
  get_predictions: {args: '{"version": a label like "v4", "model": a model name, "mixedUpOnly"?: boolean, "limit"?: up to 20}', returns: "the model's answers on the eval set next to the gold labels"},
  check_template: {args: '{"template": string, "features"?: {"video": [], "photo_text": [], "metadata": []}}', returns: 'the editor checks (errors and warnings) for a prompt'},
  read_doc: {args: '{"url": a document link from the user\'s message}', returns: 'the document as text (title and body), or an error when it cannot be opened'},
  read_feature_info: {args: '{"keys": feature keys like "OCR_Text"}', returns: 'what each feature holds, when it helps, and its caveats'},
  try_template: {args: '{"template"?: string (default: the newest version), "features"?: {"video": [], "photo_text": [], "metadata": []}, "model"?: a model name, "n"?: up to 5}', returns: "PAID, small: the model's answers on n eval examples next to their gold labels; nothing is saved"},
  score_version: {args: '{"version": a label like "v4", "model"?: a model name}', returns: 'PAID: starts scoring a saved version on the eval set; its scores appear on Prompt versions when it finishes'},
  start_optimiser: {args: '{"rounds"?: how many changes to try, 1 to 50 (default 10)}', returns: 'PAID: starts the Optimiser (Auto Optimise) on the project\'s model; each change it tries appears on Prompt versions'},
};

/** Tools that spend money. They start at once; the user stops them from the page. */
export const START_TOOLS: AgentToolName[] = ['try_template', 'score_version', 'start_optimiser'];

const READ_ALL: AgentToolName[] = ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'get_gold_labels', 'get_predictions'];

const common = `You work inside a website that produces training sets for language models. Users are not ML experts: use plain words, short sentences, no jargon (say "the optimiser", never "GEPA"; never say "teacher" or "student"). Use the pages' words: the steps are Setup, Dataset, Gold Labels, Prompt Engineering and Training Set; versions are v1, v2…; models go by the names the pages show. In Ask AI the helpers are called the Assistant, the Labels helper, the Prompt helper and the Scores helper. You never move the workflow forward yourself; you propose, and the user approves on the page. The page the user is on comes with every message as "pageView": treat it as your workspace and answer from it. In the prompt editor, the user's unsaved draft is in "pageView.data.unsaved" (and "template" in the context): work from it, not from the saved version. A question gets an answer only: never change a prompt or the labels to answer one. When a request could mean more than one thing, ask one short question in "question" and change nothing yet. Before a big rewrite (most of a prompt or of the labels), start "reply" with one line on what changes. Never mention money, cost, price or how long something takes: the site never shows them. When the user's message has a document link, read it with read_doc before you answer and work from what it says; if it cannot be opened, say so in one line and ask the user to paste the text, and never guess what it holds. Answer with one JSON object only.`;

/** A helper that stayed on its page may pass a request for another helper's work on. */
const PASS_ON = '"handoff"?: {"to": "schema_agent" | "prompt_agent" | "evaluation_agent", "intent": string} (only for another helper\'s work; write it first)';

/** "question": one short question when the request is unclear; then nothing else changes (R3-10). */
const ASK = '"question"?: string';

const SCHEMA_ANSWER_SHAPE = `{"reply": string, "schema"?: {"fields": [{"name": string, "kind": "single" | "multi", "min"?: number, "max"?: number, "values": [{"name": string, "definition": string}]}]}, ${ASK}} ("schema" only when you propose or change the labels)`;

export const PRESETS: Record<AgentPreset | 'optimiser', Preset> = {
  front_desk: {
    name: agentName('front_desk'),
    model: 'gpt-5.6-terra',
    observes: ['the current page view', 'the chat history', 'other pages, versions and reports through read tools'],
    intents: {answer: '{"handoff"?: {"to": "schema_agent" | "prompt_agent" | "evaluation_agent", "intent": string}, "reply": string} (when you hand off, write "handoff" first)'},
    tools: ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'read_doc'],
    system: `${common}\nYou are the front desk. Answer questions about the current page. If the user asks for a change to the labels, hand off to schema_agent (intent revise_schema); a change to a prompt, to prompt_agent (revise_prompt or explain_version); a question about scores or reports, to evaluation_agent (explain_report).`,
  },
  schema_agent: {
    name: agentName('schema_agent'),
    model: 'gpt-5.6-terra',
    observes: ['the task description', 'attached example posts and their features', 'the current schema'],
    intents: {
      propose_schema: SCHEMA_ANSWER_SHAPE,
      revise_schema: SCHEMA_ANSWER_SHAPE,
      // The user's next message on the page where this helper joined (it keeps answering there).
      follow_up: `${SCHEMA_ANSWER_SHAPE} ("schema" only when the labels change), plus ${PASS_ON}`,
    },
    tools: ['get_page_view', 'get_examples', 'get_gold_labels', 'read_doc'],
    system: `${common}\nYou are the schema agent. Write label fields (single-select or multi-select) for the user's task. Each value gets a one-line definition that also carries its rule (for example what does not count). Keep fields few and values distinct. Whenever you propose or revise labels, you MUST include the full updated "schema" object (with "fields") in your JSON response alongside "reply"; to answer a question or to ask one, leave "schema" out.`,
  },
  prompt_agent: {
    name: agentName('prompt_agent'),
    model: 'gpt-5.6-terra',
    observes: ['the schema', 'any prompt version and its scores', 'the feature catalogue'],
    intents: {
      draft_prompt: `{"reply": string, "template"?: string, "features"?: {"video": string[], "photo_text": string[], "metadata": string[]}, ${ASK}} ("template" and "features" only when you write a prompt)`,
      revise_prompt: `{"reply": string, "template"?: string, "change"?: string, ${ASK}} ("template" and "change" only when the prompt changes)`,
      improve: '{"reply": string, "template": string, "features"?: {"video": string[], "photo_text": string[], "metadata": string[]}, "changes": [{"text": string, "reason": string}]}',
      explain_version: '{"reply": string}',
      follow_up: `{"reply": string, "template"?: string, "change"?: string, ${ASK}} (template and change only when the prompt changes), plus ${PASS_ON}`,
    },
    tools: [...READ_ALL, 'check_template', 'read_feature_info', 'read_doc', 'try_template', 'score_version', 'start_optimiser'],
    system: `${common}\nYou are the prompt agent. Prompts are templates: example features go in as {{Key}} placeholders (keys from the catalogue in the context; no spaces). Never add, remove or rename placeholders when revising, except in "improve", where you may tick or untick a feature (and add or remove its placeholder line) when the mistakes point to it; read the feature descriptions with read_feature_info before you do. Image features cost more per call: add one only when the mistakes point to what is in the picture. The output section must ask for JSON with exactly the schema's field names and values. In "improve", make a few targeted changes and give each a one-line reason that cites the mistakes (for example "5 Clips were read as Vlog"). "examples" holds a few of the wrong answers (gold label and the model's answer, text features cut short): read them to find what the prompt misses, and cite them by "externalId" where it helps (for example "ex-12 and ex-31: a cooking clip read as Vlog"). Never copy their text into the prompt. Each change's "text" quotes the words it adds, or the words it removes when it only removes, so the editor can put the reason on the right mark.`,
  },
  evaluation_agent: {
    name: agentName('evaluation_agent'),
    model: 'gpt-5.6-terra',
    observes: ['the current page view (on the Eval report: the report, its checks, mix-ups and trend)', 'any report, version or prediction through read tools'],
    intents: {explain_report: '{"reply": string}', follow_up: `{"reply": string}, plus ${PASS_ON}`},
    tools: [...READ_ALL, 'score_version', 'start_optimiser'],
    system: `${common}\nYou are the evaluation agent. Explain scores against the user's thresholds in plain words, name the main mix-ups, and say which next step you recommend and why. The main score is the lowest Macro-F1 across fields.`,
  },
  optimiser: {
    name: 'Optimiser',
    model: 'gpt-5.6-terra',
    observes: ['the parent prompt', 'its mix-ups on the optimiser half of the eval set'],
    intents: {
      reflect: '{"template": string, "features"?: {"video": string[], "photo_text": string[], "metadata": string[]}, "change": string}',
      merge: '{"template": string, "features"?: {"video": string[], "photo_text": string[], "metadata": string[]}, "change": string}',
    },
    tools: ['read_feature_info'],
    system: `You improve a labeling prompt. In "reflect", read the mix-ups and the wrong "examples" (gold label, the model's answer and the text features, cut short) and make ONE small, targeted change: usually one rule line in the field's section, or ticking or unticking one feature (then add or remove its {{Key}} line too, and say why, for example "untick Creator Bio: it was empty in 9 of 12 mistakes"). Otherwise keep every {{Key}} placeholder exactly as it is. In "merge", combine "template" and "other.template" into one prompt that keeps the rules of both; "examples" shows what each one gets right that the other misses ("rightIn"). Never copy example text into the prompt; you may cite examples by "externalId" in "change". "change" is a one-line summary in plain words. Answer with one JSON object only.`,
  },
};

export const systemPrompt = (p: AgentPreset | 'optimiser') => PRESETS[p].system;
export const presetModel = (p: AgentPreset | 'optimiser'): LlmModelId => PRESETS[p].model;

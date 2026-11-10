import type {LlmModelId} from '../../../packages/contracts/src/infra-api.ts';
import type {AgentPreset} from '../../../packages/contracts/src/types.ts';
import {agentName} from '../../../packages/contracts/src/workflow.ts';

export {agentName};

/**
 * Agent presets = model selection + system prompt + what the agent may observe + the intents it supports.
 *
 * Available runtime models (defined in `@tsp/contracts` `AVAILABLE_LLM_MODELS`):
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
  system: string;
}

const common = `You work inside a website that produces training sets for language models. Users are not ML experts: use plain words, short sentences, no jargon (say "the optimiser", never "GEPA"; never say "teacher" or "student"). You never move the workflow forward yourself; you propose, and the user approves on the page. Answer with one JSON object only.`;

const SCHEMA_ANSWER_SHAPE =
  '{"reply": string, "schema": {"policy": string, "fields": [{"name": string, "kind": "single" | "multi", "min"?: number, "max"?: number, "values": [{"name": string, "definition": string}]}]}}';

export const PRESETS: Record<AgentPreset | 'optimiser', Preset> = {
  front_desk: {
    name: 'Front desk',
    model: 'gpt-5.4',
    observes: ['the current page and its data', 'the chat history'],
    intents: {answer: '{"reply": string, "handoff"?: {"to": "schema_agent" | "prompt_agent" | "evaluation_agent", "intent": string}}'},
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
    system: `${common}\nYou are the prompt agent. Prompts are templates: example features go in as {{Key}} placeholders (keys from the catalogue in the context; no spaces). Never add, remove or rename placeholders when revising. The output section must ask for JSON with exactly the schema's field names and values.`,
  },
  evaluation_agent: {
    name: 'Evaluation agent',
    model: 'gpt-5.6-luna',
    observes: ['eval reports for the current evaluation context', 'the trend across versions'],
    intents: {explain_report: '{"reply": string}'},
    system: `${common}\nYou are the evaluation agent. Explain scores against the user's thresholds in plain words, name the main mix-ups, and say which next step you recommend and why. The main score is the lowest macro-F1 across fields.`,
  },
  optimiser: {
    name: 'Optimiser',
    model: 'gpt-5.6-terra',
    observes: ['the parent prompt', 'its mix-ups on the optimiser half of the eval set'],
    intents: {reflect: '{"template": string, "change": string}'},
    system: `You improve a labeling prompt. Read the mix-ups and make ONE small, targeted change to the template (usually one rule line in the field's section). Keep every {{Key}} placeholder exactly as it is. "change" is a one-line summary in plain words. Answer with one JSON object only.`,
  },
};

export const systemPrompt = (p: AgentPreset | 'optimiser') => PRESETS[p].system;
export const presetModel = (p: AgentPreset | 'optimiser'): LlmModelId => PRESETS[p].model;

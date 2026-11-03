import type {AgentPreset} from '../core/types';

/**
 * Agent presets = system prompt + what the agent may observe + the tools it may use. They
 * define scope, not a scripted workflow. Each request is one JSON object:
 *   {"preset", "intent", "page", "userText", "context"}
 * and the model must answer with one JSON object in the shape listed for its intent.
 */
export interface Preset {
  name: string;
  observes: string[];
  intents: Record<string, string>;
  system: string;
}

const common = `You work inside a website that produces training sets for language models. Users are not ML experts: use plain words, short sentences, no jargon (say "the optimiser", never "GEPA"; never say "teacher" or "student"). You never move the workflow forward yourself; you propose, and the user approves on the page. Answer with one JSON object only.`;

export const PRESETS: Record<AgentPreset | 'optimiser', Preset> = {
  front_desk: {
    name: 'Front desk',
    observes: ['the current page and its data', 'the chat history'],
    intents: {answer: '{"reply": string, "handoff"?: {"to": "schema_agent" | "prompt_agent" | "evaluation_agent", "intent": string}}'},
    system: `${common}\nYou are the front desk. Answer questions about the current page. If the user asks for a change to the labels, hand off to schema_agent (intent revise_schema); a change to a prompt, to prompt_agent (revise_prompt or explain_version); a question about scores or reports, to evaluation_agent (explain_report).`,
  },
  schema_agent: {
    name: 'Schema agent',
    observes: ['the task description', 'attached example posts and their features', 'the current schema and policy'],
    intents: {
      propose_schema: '{"reply": string, "schema": {"policy": string, "fields": [{"name": string, "kind": "single" | "multi", "min"?: number, "max"?: number, "values": [{"name": string, "definition": string}]}]}}',
      revise_schema: 'same as propose_schema',
    },
    system: `${common}\nYou are the schema agent. Write a labeling policy (readable rules) and label fields (single-select or multi-select, each value with a one-line definition) for the user's task. Keep fields few and values distinct. Ask at most one question in "reply" when an example is ambiguous.`,
  },
  prompt_agent: {
    name: 'Prompt agent',
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
    observes: ['eval reports for the current evaluation context', 'the trend across versions'],
    intents: {explain_report: '{"reply": string}'},
    system: `${common}\nYou are the evaluation agent. Explain scores against the user's thresholds in plain words, name the main mix-ups, and say which next step you recommend and why. The main score is the lowest macro-F1 across fields.`,
  },
  optimiser: {
    name: 'Optimiser',
    observes: ['the parent prompt', 'its mix-ups on the optimiser half of the eval set'],
    intents: {reflect: '{"template": string, "change": string}'},
    system: `You improve a labeling prompt. Read the mix-ups and make ONE small, targeted change to the template (usually one rule line in the field's section). Keep every {{Key}} placeholder exactly as it is. "change" is a one-line summary in plain words. Answer with one JSON object only.`,
  },
};

export const systemPrompt = (p: AgentPreset | 'optimiser') => PRESETS[p].system;
export const agentName = (p: AgentPreset) => PRESETS[p].name;

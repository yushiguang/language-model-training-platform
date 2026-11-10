import type {
  AgentEmittedMessage,
  AgentProposalDraft,
  AgentTurnInput,
  AgentTurnOutput,
  OptimiserReflectInput,
  OptimiserReflectOutput,
} from '../../../packages/contracts/src/agent-api.ts';
import {FEATURES} from '../../../packages/contracts/src/catalogue.ts';
import type {AgentModel} from '../../../packages/contracts/src/infra-api.ts';
import type {AgentPreset, FeatureSelection, Schema} from '../../../packages/contracts/src/types.ts';
import {agentName, presetModel, PRESETS, systemPrompt} from './presets.ts';

interface RawAgentReply {
  reply?: string;
  handoff?: {to: AgentPreset; intent: string};
  schema?: Schema;
  policy?: string;
  fields?: Schema['fields'];
  template?: string;
  features?: FeatureSelection;
  change?: string;
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return fallback;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}

function extractSchema(out: RawAgentReply): Schema | null {
  if (out.schema && Array.isArray(out.schema.fields)) return out.schema;
  if (typeof out.policy === 'string' && Array.isArray(out.fields)) {
    return {policy: out.policy, fields: out.fields};
  }
  return null;
}

function buildAgentContext(input: AgentTurnInput, targetAgent: AgentPreset): Record<string, unknown> {
  const {page, workspace, attachments} = input;
  const ctx: Record<string, unknown> = {
    ...page.context,
    pageHint: page.hint,
    task: page.context.task ?? workspace.task,
    schema: page.context.schema ?? workspace.schema,
    recentHistory: workspace.history.slice(-8),
  };

  if (targetAgent === 'prompt_agent') {
    ctx.featureCatalogue = {
      video: FEATURES.video.map(f => ({key: f.key, label: f.label})),
      photo_text: FEATURES.photo_text.map(f => ({key: f.key, label: f.label})),
      metadata: FEATURES.metadata.map(f => ({key: f.key, label: f.label})),
    };
  }

  if (attachments?.length) {
    ctx.attachments = attachments.map(a => ({name: a.name, url: a.url, content: a.content}));
  }
  if (workspace.attachedExamples?.length) {
    ctx.attachedExamples = workspace.attachedExamples;
  }

  return ctx;
}

async function invokePreset(
  llm: AgentModel,
  to: AgentPreset,
  intent: string,
  input: AgentTurnInput,
): Promise<RawAgentReply> {
  const context = buildAgentContext(input, to);
  const body = {
    preset: to,
    intent,
    page: input.page.label,
    userText: input.userText,
    context,
  };
  const shape = PRESETS[to].intents[intent] ?? '{"reply": string}';
  const raw = await llm.chat(
    [
      {role: 'system', content: `${systemPrompt(to)}\nAnswer shape for "${intent}": ${shape}`},
      {role: 'user', content: JSON.stringify(body)},
    ],
    {model: presetModel(to), json: true},
  );
  return parseJsonObject<RawAgentReply>(raw, {reply: raw});
}

/**
 * Executes one user turn in the Agent Runtime service (`@tsp/agents`).
 *
 * Stateless and free of database dependencies: receives `AgentTurnInput` from the BFF,
 * runs the page's active agent (plus an optional specialist handoff from `front_desk`),
 * and returns the emitted messages, invocation records, and any schema/prompt proposal.
 */
export async function runAgentTurn(input: AgentTurnInput, llm: AgentModel): Promise<AgentTurnOutput> {
  const invocations: AgentTurnOutput['invocations'] = [];
  const messages: AgentEmittedMessage[] = [];

  let agent: AgentPreset = input.page.agent;
  let intent: string = input.page.intent;

  invocations.push({from: 'user', to: agent, intent, note: ''});
  let out = await invokePreset(llm, agent, intent, input);

  if (out.handoff && agent === 'front_desk') {
    if (out.reply) {
      messages.push({role: 'agent', agent, text: out.reply});
    }
    agent = out.handoff.to;
    intent = out.handoff.intent;
    messages.push({role: 'event', agent: null, text: `${agentName(agent)} joined`});
    invocations.push({from: 'front_desk', to: agent, intent, note: 'Handed off by the front desk'});
    out = await invokePreset(llm, agent, intent, input);
  }

  if (out.reply) {
    messages.push({role: 'agent', agent, text: out.reply});
  }

  const resolvedSchema = extractSchema(out);
  let proposal: AgentProposalDraft | null = null;
  if (resolvedSchema) {
    proposal = {
      kind: 'schema',
      agent,
      brief: input.userText,
      payload: resolvedSchema,
    };
  } else if (out.template) {
    proposal = {
      kind: 'prompt',
      agent,
      brief: input.userText,
      payload: {
        template: out.template,
        features: out.features,
        change: out.change,
      },
    };
  }

  return {invocations, messages, proposal};
}

/**
 * Runs one reflection step for the GEPA-style prompt optimiser.
 */
export async function reflectPrompt(input: OptimiserReflectInput, llm: AgentModel): Promise<OptimiserReflectOutput> {
  const raw = await llm.chat(
    [
      {role: 'system', content: systemPrompt('optimiser')},
      {
        role: 'user',
        content: JSON.stringify({
          preset: 'optimiser',
          intent: 'reflect',
          context: {
            template: input.template,
            schema: input.schema,
            tried: input.triedChanges,
            mixUps: input.mixUps.slice(0, 6),
            lowestField: input.lowestField,
            lowestValue: input.lowestValue,
          },
        }),
      },
    ],
    {model: presetModel('optimiser'), json: true, signal: input.signal},
  );
  return parseJsonObject<OptimiserReflectOutput>(raw, {template: input.template, change: ''});
}

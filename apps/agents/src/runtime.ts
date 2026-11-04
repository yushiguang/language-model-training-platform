import type {
  AgentToolHost,
  AgentToolName,
  ModelMessage,
  AgentEmittedMessage,
  AgentProposalDraft,
  AgentTurnInput,
  AgentTurnOutput,
  OptimiserReflectInput,
  OptimiserReflectOutput,
  AgentModel,
  AgentPreset,
  FeatureSelection,
  Schema,
} from '@tsp/contracts';
import {FEATURES} from '@tsp/domain';
import {agentName, presetModel, PRESETS, START_TOOLS, systemPrompt, TOOL_SPECS} from './presets.ts';

/** Read-tool calls allowed in one turn, across the agents in it. */
export const MAX_TOOL_CALLS = 4;
/** A tool result longer than this is cut, so one call can't fill the context. */
const MAX_RESULT_CHARS = 12_000;

/** The front desk may only hand off to these specialists; anything else is ignored (no handoff). */
const HANDOFF_TARGETS: AgentPreset[] = ['schema_agent', 'prompt_agent', 'evaluation_agent'];

interface RawAgentReply {
  tool?: {name: AgentToolName; args?: Record<string, unknown>};
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
    pageView: workspace.pageView,
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

interface TurnTools {
  host?: AgentToolHost;
  used: AgentTurnOutput['toolCalls'];
  modelCalls: AgentTurnOutput['modelCalls'];
  parseFailures: AgentTurnOutput['parseFailures'];
}

function toolBlurb(to: AgentPreset, host?: AgentToolHost): string {
  const names = host ? PRESETS[to].tools : [];
  if (!names.length) return '';
  const list = names.map(n => `- ${n} ${TOOL_SPECS[n].args}: ${TOOL_SPECS[n].returns}`).join('\n');
  const paid = names.some(n => START_TOOLS.includes(n))
    ? ' Tools marked PAID spend money: use them only when the user asks for that work or clearly agrees. If a PAID tool answers {"asked_user": true}, the user sees an Approve button; say in one short line what you asked for and stop.'
    : ' Tools only read.';
  return `\nIf the page view doesn't have what you need, use a tool: answer {"tool": {"name": string, "args": object}} instead, and the result comes back as the next message.${paid} At most ${MAX_TOOL_CALLS} calls per turn. Your tools:\n${list}`;
}

/** One agent's part of a turn: calls the model, runs the read tools it asks for, until it answers. */
async function invokePreset(llm: AgentModel, to: AgentPreset, intent: string, input: AgentTurnInput, tools: TurnTools): Promise<RawAgentReply> {
  const context = buildAgentContext(input, to);
  const body = {
    preset: to,
    intent,
    page: input.page.label,
    userText: input.userText,
    context,
  };
  const shape = PRESETS[to].intents[intent] ?? '{"reply": string}';
  const messages: ModelMessage[] = [
    {role: 'system', content: `${systemPrompt(to)}\nAnswer shape for "${intent}": ${shape}${toolBlurb(to, tools.host)}`},
    {role: 'user', content: JSON.stringify(body)},
  ];
  // A refused or extra call still counts as a step, so a model that keeps asking can't loop.
  let asked = false;
  for (let step = 0; ; step++) {
    const raw = await llm.chat(messages, {model: presetModel(to), json: true});
    tools.modelCalls.push({agent: to, model: presetModel(to)});
    const notJson = {};
    const out = parseJsonObject<RawAgentReply>(raw, notJson as RawAgentReply);
    if (out === notJson) {
      tools.parseFailures.push({agent: to, intent});
      return {reply: raw};
    }
    if (!out.tool) return out;
    // After a paid start asked the user, the turn ends: no more tools.
    if (asked) return {reply: 'I asked for your approval in the card below.'};
    if (step >= MAX_TOOL_CALLS + 1) return {reply: "I couldn't find what I needed. Could you say a bit more about what you're asking?"};
    const name = out.tool.name;
    const args = out.tool.args && typeof out.tool.args === 'object' ? out.tool.args : {};
    let result: unknown;
    if (!tools.host || !PRESETS[to].tools.includes(name)) result = {error: `${name} is not one of your tools.`};
    else if (tools.used.length >= MAX_TOOL_CALLS) result = {error: 'No more tool calls in this turn. Answer now with what you have.'};
    else {
      const started = Date.now();
      try {
        result = await tools.host.call({agent: to, name, args});
        if (result && typeof result === 'object' && (result as {asked_user?: boolean}).asked_user) asked = true;
        tools.used.push({agent: to, name, args, ok: true, ms: Date.now() - started});
      } catch (e) {
        result = {error: (e as Error).message ?? String(e)};
        tools.used.push({agent: to, name, args, ok: false, ms: Date.now() - started});
      }
    }
    let text = JSON.stringify({tool_result: {name, result}});
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}… (cut)`;
    messages.push({role: 'assistant', content: raw}, {role: 'user', content: text});
  }
}

/**
 * Executes one user turn in the Agent Runtime service (`@tsp/agents`).
 *
 * Stateless and free of database dependencies: receives `AgentTurnInput` from the BFF,
 * runs the page's active agent (plus an optional specialist handoff from `front_desk`), lets
 * each agent call its read tools through `host`, and returns the emitted messages, invocation
 * records, tool calls, and any schema/prompt proposal.
 */
export async function runAgentTurn(input: AgentTurnInput, llm: AgentModel, host?: AgentToolHost): Promise<AgentTurnOutput> {
  const invocations: AgentTurnOutput['invocations'] = [];
  const messages: AgentEmittedMessage[] = [];
  const tools: TurnTools = {host, used: [], modelCalls: [], parseFailures: []};

  let agent: AgentPreset = input.page.agent;
  let intent: string = input.page.intent;

  invocations.push({from: 'user', to: agent, intent, note: ''});
  let out = await invokePreset(llm, agent, intent, input, tools);

  if (out.handoff && agent === 'front_desk' && HANDOFF_TARGETS.includes(out.handoff.to) && PRESETS[out.handoff.to].intents[out.handoff.intent]) {
    if (out.reply) {
      messages.push({role: 'agent', agent, text: out.reply});
    }
    agent = out.handoff.to;
    intent = out.handoff.intent;
    messages.push({role: 'event', agent: null, text: `${agentName(agent)} joined`});
    invocations.push({from: 'front_desk', to: agent, intent, note: 'Handed off by the front desk'});
    out = await invokePreset(llm, agent, intent, input, tools);
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

  return {invocations, messages, proposal, toolCalls: tools.used, modelCalls: tools.modelCalls, parseFailures: tools.parseFailures};
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

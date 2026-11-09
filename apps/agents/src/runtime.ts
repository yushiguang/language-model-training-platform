import type {
  AgentToolHost,
  AgentToolName,
  ModelMessage,
  AgentEmittedMessage,
  AgentProposalDraft,
  AgentTurnInput,
  AgentTurnOutput,
  AgentTurnProgress,
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

/** Handoffs go only to these specialists; anything else is ignored (no handoff). */
const HANDOFF_TARGETS: AgentPreset[] = ['schema_agent', 'prompt_agent', 'evaluation_agent'];

interface RawAgentReply {
  tool?: {name: AgentToolName; args?: Record<string, unknown>};
  reply?: string;
  handoff?: {to: AgentPreset; intent: string};
  schema?: Schema;
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
  if (Array.isArray(out.fields)) {
    return {fields: out.fields};
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
  progress?: AgentTurnProgress;
}

/** What the live line in Ask AI says while a tool runs (plain words, the page's terms). */
function workingLine(name: AgentToolName, args: Record<string, unknown>): string {
  const v = typeof args.version === 'string' && args.version ? args.version : null;
  switch (name) {
    case 'get_page_view':
      return 'Reading another page…';
    case 'list_versions':
      return 'Reading the prompt versions…';
    case 'get_version':
      return `Reading ${v ?? 'the version'}…`;
    case 'get_report':
      return `Reading the ${v ? `${v} ` : ''}report…`;
    case 'get_examples':
      return 'Reading examples…';
    case 'get_gold_labels':
      return 'Reading the gold labels…';
    case 'get_predictions':
      return `Reading the ${v ? `${v} ` : ''}answers…`;
    case 'check_template':
      return 'Checking the prompt…';
    case 'try_template':
      return 'Trying the prompt on a few examples…';
    case 'score_version':
      return `Starting scoring${v ? ` ${v}` : ''}…`;
    case 'start_optimiser':
      return 'Starting the optimiser…';
  }
}

/**
 * The `reply` string of a JSON answer that is still arriving, decoded as far as it goes (null
 * until the key appears). Lets Ask AI stream the reply while the rest of the JSON is written.
 */
export function partialReply(raw: string): string | null {
  const m = /"reply"\s*:\s*"/.exec(raw);
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({n: '\n', t: '\t', r: '', b: '', f: ''} as Record<string, string>)[n] ?? n;
    i++;
  }
  return out;
}

/** One model call; with progress, streamed so the reply shows as it is written. */
async function callModel(llm: AgentModel, to: AgentPreset, messages: ModelMessage[], progress?: AgentTurnProgress): Promise<string> {
  if (!progress) return llm.chat(messages, {model: presetModel(to), json: true});
  let raw = '';
  let shown = '';
  for await (const c of llm.chatStream(messages, {model: presetModel(to), json: true})) {
    if (c.type === 'error') throw new Error(c.message);
    if (c.type !== 'delta') continue;
    raw += c.text;
    // A handoff (written first) means another helper answers: this reply is not shown.
    if (/"handoff"\s*:/.test(raw)) continue;
    const reply = partialReply(raw);
    if (reply && reply !== shown) {
      shown = reply;
      progress({agent: to, reply});
    }
  }
  return raw;
}

function toolBlurb(to: AgentPreset, host?: AgentToolHost): string {
  const names = host ? PRESETS[to].tools : [];
  if (!names.length) return '';
  const list = names.map(n => `- ${n} ${TOOL_SPECS[n].args}: ${TOOL_SPECS[n].returns}`).join('\n');
  const paid = names.some(n => START_TOOLS.includes(n))
    ? ' Tools marked PAID spend money and start at once (the user can stop them from the page): use them only when the user asks for that work or clearly agrees.'
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
  for (let step = 0; ; step++) {
    const raw = await callModel(llm, to, messages, tools.progress);
    tools.modelCalls.push({agent: to, model: presetModel(to)});
    const notJson = {};
    const out = parseJsonObject<RawAgentReply>(raw, notJson as RawAgentReply);
    if (out === notJson) {
      tools.parseFailures.push({agent: to, intent});
      return {reply: raw};
    }
    if (!out.tool) return out;
    if (step >= MAX_TOOL_CALLS + 1) return {reply: "I couldn't find what I needed. Could you say a bit more about what you're asking?"};
    const name = out.tool.name;
    const args = out.tool.args && typeof out.tool.args === 'object' ? out.tool.args : {};
    let result: unknown;
    if (!tools.host || !PRESETS[to].tools.includes(name)) result = {error: `${name} is not one of your tools.`};
    else if (tools.used.length >= MAX_TOOL_CALLS) result = {error: 'No more tool calls in this turn. Answer now with what you have.'};
    else {
      const started = Date.now();
      tools.progress?.({agent: to, working: workingLine(name, args)});
      try {
        result = await tools.host.call({agent: to, name, args});
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
export async function runAgentTurn(input: AgentTurnInput, llm: AgentModel, host?: AgentToolHost, progress?: AgentTurnProgress): Promise<AgentTurnOutput> {
  const invocations: AgentTurnOutput['invocations'] = [];
  const messages: AgentEmittedMessage[] = [];
  const tools: TurnTools = {host, used: [], modelCalls: [], parseFailures: [], progress};
  // Each message is reported as soon as it is final, so the host can save it while the turn goes on.
  const emit = (m: AgentEmittedMessage) => {
    messages.push(m);
    progress?.({message: m});
  };

  let agent: AgentPreset = input.page.agent;
  let intent: string = input.page.intent;

  invocations.push({from: 'user', to: agent, intent, note: ''});
  progress?.({agent, working: 'Thinking…'});
  let out = await invokePreset(llm, agent, intent, input, tools);

  // The front desk hands off; so does a helper that stayed on its page (follow_up), when the
  // user asks for another helper's work.
  const from = agent;
  if (out.handoff && (agent === 'front_desk' || intent === 'follow_up') && out.handoff.to !== agent && HANDOFF_TARGETS.includes(out.handoff.to) && PRESETS[out.handoff.to].intents[out.handoff.intent]) {
    // The handoff line alone tells the user who answers; the "I'll bring in…" reply is not shown.
    agent = out.handoff.to;
    intent = out.handoff.intent;
    emit({role: 'event', agent: null, event: 'join', text: `${agentName(agent)} joined to answer`});
    invocations.push({from, to: agent, intent, note: from === 'front_desk' ? 'Handed off by the front desk' : 'Passed on by the helper that stayed'});
    progress?.({agent, working: 'Thinking…'});
    out = await invokePreset(llm, agent, intent, input, tools);
  }

  if (out.reply) {
    emit({role: 'agent', agent, text: out.reply});
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

import type {
  AgentToolRequest,
  AgentToolName,
  Msg,
  ModelMessage,
  ContentPart,
  ExampleBrief,
  AgentEmittedMessage,
  AgentProposalDraft,
  AgentTurnInput,
  AgentTurnOutput,
  AgentTurnProgress,
  OptimiserReflectInput,
  OptimiserReflectOutput,
  AgentModel,
  AgentSkillName,
  AgentPreset,
  StructuredPrompt,
} from '@yushiguang/sprint-contracts';
import {FEATURES, HANDOFF_TARGETS, msg, msgText, PRESET_SKILLS, readStructured, rewordOnly, structuredEquals, systemConfig} from '@yushiguang/sprint-domain';
import {agentName, languageLine, presetModel, PRESETS, START_TOOLS, systemPrompt, TOOL_SPECS} from './presets.ts';
import {SKILL_INTENTS, skillBlurb, SKILLS} from './skills.ts';



interface RawAgentReply {
  tool?: {name: AgentToolName; args?: Record<string, unknown>};
  reply?: string;
  handoff?: {to: AgentPreset; intent: string};
  /** The whole structured prompt, when the helper wrote or changed it. */
  prompt?: unknown;
  change?: string;
  /** Passages of an imported prompt that fit no structured part. */
  unmapped?: unknown;
  /** One short question when the request is unclear (R3-10): the turn then proposes nothing. */
  question?: string;
  /** A skill to run (#39): the runtime reads its brief and the skill gives the answer. */
  skill?: {name: AgentSkillName; args?: Record<string, unknown>};
  /** Improve with AI: each change with its reason. */
  changes?: unknown;
}

/** What a skill that drafts adds to its answer: the prompt it drafted from, and that version. */
interface SkillDraft {
  base: StructuredPrompt;
  versionId: string | null;
  version: string | null;
  changes: {text: string; reason: string}[];
}

type Answer = RawAgentReply & {draft?: SkillDraft};

/**
 * The tools as the runtime's helpers call them: a request by name. `createAgentRuntime` binds each
 * request to the project, turn and context it serves before it reaches the `AgentToolHost`.
 */
export interface ToolCaller {
  call(req: AgentToolRequest): Promise<unknown>;
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

function buildAgentContext(input: AgentTurnInput, targetAgent: AgentPreset): Record<string, unknown> {
  const {page, workspace, attachments} = input;
  const ctx: Record<string, unknown> = {
    ...page.context,
    pageHint: page.hint,
    task: page.context.task ?? workspace.task,
    prompt: workspace.prompt,
    pageView: workspace.pageView,
    recentHistory: workspace.history.slice(-systemConfig().agent.recentHistoryCount),
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
  host?: ToolCaller;
  skills: AgentTurnOutput['skills'];
  used: AgentTurnOutput['toolCalls'];
  modelCalls: AgentTurnOutput['modelCalls'];
  parseFailures: AgentTurnOutput['parseFailures'];
  progress?: AgentTurnProgress;
}

/** What the live line in Ask AI says while a tool runs (plain words, the page's terms; a catalog key). */
function workingLine(name: AgentToolName, args: Record<string, unknown>): Msg {
  const v = typeof args.version === 'string' && args.version ? args.version : null;
  switch (name) {
    case 'get_page_view':
      return msg('Reading another page…');
    case 'list_versions':
      return msg('Reading the prompt versions…');
    case 'get_version':
      return v ? msg('Reading {version}…', {version: v}) : msg('Reading the version…');
    case 'get_report':
      return v ? msg('Reading the {version} report…', {version: v}) : msg('Reading the report…');
    case 'get_examples':
      return msg('Reading examples…');
    case 'get_gold_labels':
      return msg('Reading the gold labels…');
    case 'get_predictions':
      return v ? msg('Reading the {version} answers…', {version: v}) : msg('Reading the answers…');
    case 'check_prompt':
      return msg('Checking the prompt…');
    case 'read_feature_info':
      return msg('Reading the feature descriptions…');
    case 'read_doc':
      return msg('Reading the linked document…');
    case 'get_project_summary':
      return msg('Reading the project…');
    case 'get_dataset_stats':
      return msg('Reading the label balance…');
    case 'search_examples':
      return msg('Searching examples…');
    case 'compare_versions':
      return msg('Comparing versions…');
    case 'get_mismatch_summary':
      return msg('Counting mismatches…');
    case 'get_gates':
      return msg('Reading what each step waits for…');
    case 'get_running_work':
      return msg('Reading what is running…');
    case 'get_upload_result':
      return msg('Reading the upload results…');
    case 'get_optimiser_run':
      return msg('Reading the Optimiser run…');
    case 'get_drafts':
      return msg('Reading earlier drafts…');
    case 'read_guide':
      return msg('Reading the guide…');
    case 'get_mistakes':
      return v ? msg('Reading the {version} mistakes…', {version: v}) : msg('Reading the mistakes…');
    case 'get_flips':
      return msg('Comparing the answers of two versions…');
    case 'get_confusions':
      return msg('Reviewing the values…');
    case 'try_prompt':
      return msg('Trying the prompt on a few examples…');
    case 'score_version':
      return v ? msg('Starting scoring {version}…', {version: v}) : msg('Starting scoring…');
    case 'start_optimiser':
      return msg('Starting the optimiser…');
    case 'report_problem':
      return msg(args.send === true ? 'Sending the problem report…' : 'Drafting a problem report…');
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

function toolBlurb(to: AgentPreset, host?: ToolCaller, only?: AgentToolName[]): string {
  const names = host ? (only ?? PRESETS[to].tools) : [];
  if (!names.length) return '';
  const list = names.map(n => `- ${n} ${TOOL_SPECS[n].args}: ${TOOL_SPECS[n].returns}`).join('\n');
  const paid = names.some(n => START_TOOLS.includes(n))
    ? ' Tools marked PAID spend money and start at once (the user can stop them from the page): use them only when the user asks for that work or clearly agrees.'
    : names.includes('report_problem')
      ? ' Tools only read, except report_problem, which files a report once the user has agreed.'
      : ' Tools only read.';
  return `\nIf the page view doesn't have what you need, use a tool: answer {"tool": {"name": string, "args": object}} instead, and the result comes back as the next message.${paid} At most ${systemConfig().agent.maxToolCalls} calls per turn. Your tools:\n${list}`;
}

/** One agent's part of a turn: calls the model, runs the read tools and the skill it asks for, until it answers. */
async function invokePreset(llm: AgentModel, to: AgentPreset, intent: string, input: AgentTurnInput, tools: TurnTools): Promise<Answer> {
  // A button that runs a skill (Improve with AI) starts it directly, with the page's arguments.
  const direct = SKILL_INTENTS[intent];
  if (direct && PRESET_SKILLS[to].includes(direct)) {
    const started = await runSkill(llm, to, direct, input.page.context as Record<string, unknown>, input, tools);
    return 'error' in started ? {reply: started.error} : started;
  }
  const shape = PRESETS[to].intents[intent] ?? '{"reply": string}';
  const messages: ModelMessage[] = [
    {role: 'system', content: `${systemPrompt(to)}\nAnswer shape for "${intent}": ${shape}${toolBlurb(to, tools.host)}${tools.host ? skillBlurb(to) : ''}${languageLine(input.locale)}`},
    // Example images (the label check) go as content parts, like the Optimiser's wrong examples.
    {role: 'user', content: withImages({preset: to, intent, page: input.page.label, userText: input.userText, context: buildAgentContext(input, to)})},
  ];
  return converse(llm, to, intent, messages, PRESETS[to].tools, tools, async skill => {
    if (!PRESET_SKILLS[to].includes(skill.name) || !SKILLS[skill.name]) return {error: `${String(skill.name)} is not one of your skills.`};
    return runSkill(llm, to, skill.name, skill.args && typeof skill.args === 'object' ? skill.args : {}, input, tools);
  });
}

/**
 * The model loop: calls the model, runs the tools it asks for (only `allowed`), and a skill when
 * `onSkill` is given, until it answers. A refused or extra call still counts as a step, so a model
 * that keeps asking can't loop.
 */
async function converse(llm: AgentModel, to: AgentPreset, intent: string, messages: ModelMessage[], allowed: AgentToolName[], tools: TurnTools, onSkill?: (skill: NonNullable<RawAgentReply['skill']>) => Promise<Answer | {error: string}>): Promise<Answer> {
  let retried = false;
  for (let step = 0; ; step++) {
    const raw = await callModel(llm, to, messages, tools.progress);
    tools.modelCalls.push({agent: to, model: presetModel(to)});
    const notJson = {};
    const out = parseJsonObject<RawAgentReply>(raw, notJson as RawAgentReply);
    if (out === notJson) {
      tools.parseFailures.push({agent: to, intent});
      // Ask once more for the JSON answer (review finding 17); a second miss never shows broken
      // output: plain prose is shown as it is, anything else gets a short apology.
      if (!retried) {
        retried = true;
        messages.push({role: 'assistant', content: raw}, {role: 'user', content: 'That was not one JSON object. Answer again with one JSON object only, in the answer shape.'});
        continue;
      }
      return {reply: raw.trim() && !/[{}[\]]/.test(raw) ? raw.trim() : "Sorry, my answer came out garbled. Please ask again."};
    }
    if (out.skill && onSkill) {
      const done = await onSkill(out.skill);
      if (!('error' in done)) return done;
      // The skill could not start (no such skill, or its brief failed): the helper hears why.
      messages.push({role: 'assistant', content: raw}, {role: 'user', content: JSON.stringify({skill_result: {name: out.skill.name, error: done.error}})});
      if (step >= systemConfig().agent.maxToolCalls + 1) return {reply: done.error};
      continue;
    }
    if (!out.tool) return out;
    if (step >= systemConfig().agent.maxToolCalls + 1) return {reply: "I couldn't find what I needed. Could you say a bit more about what you're asking?"};
    const name = out.tool.name;
    const args = out.tool.args && typeof out.tool.args === 'object' ? out.tool.args : {};
    const result = allowed.includes(name) ? await callTool(to, name, args, tools) : {error: `${name} is not one of your tools${allowed === PRESETS[to].tools ? '' : ' here'}.`};
    let text = JSON.stringify({tool_result: {name, result}});
    if (text.length > systemConfig().agent.maxToolResultChars) text = `${text.slice(0, systemConfig().agent.maxToolResultChars)}… (cut)`;
    messages.push({role: 'assistant', content: raw}, {role: 'user', content: text});
  }
}

/** One tool call through the host, with its live line; an error comes back as `{error}`. */
async function callTool(to: AgentPreset, name: AgentToolName, args: Record<string, unknown>, tools: TurnTools, line?: Msg): Promise<unknown> {
  if (!tools.host || !PRESETS[to].tools.includes(name)) return {error: `${name} is not one of your tools.`};
  if (tools.used.length >= systemConfig().agent.maxToolCalls) return {error: 'No more tool calls in this turn. Answer now with what you have.'};
  const started = Date.now();
  const working = line ?? workingLine(name, args);
  tools.progress?.({agent: to, working: msgText(working), msg: working});
  try {
    const result = await tools.host.call({agent: to, name, args});
    tools.used.push({agent: to, name, args, ok: true, ms: Date.now() - started});
    return result;
  } catch (e) {
    tools.used.push({agent: to, name, args, ok: false, ms: Date.now() - started});
    return {error: (e as Error).message ?? String(e)};
  }
}

/**
 * Runs a skill (#39): reads its brief with the skill's arguments, then asks the helper for the
 * answer under the skill's instructions and shape, with only the skill's tools. A brief that
 * fails comes back as `{error}`, for the helper to answer from.
 */
async function runSkill(llm: AgentModel, to: AgentPreset, name: AgentSkillName, args: Record<string, unknown>, input: AgentTurnInput, tools: TurnTools): Promise<Answer | {error: string}> {
  const skill = SKILLS[name];
  const brief = await callTool(to, skill.brief, args, tools, skill.working(args));
  if (brief && typeof brief === 'object' && 'error' in brief) return {error: String((brief as {error: unknown}).error)};
  tools.skills.push({agent: to, name});
  const b = brief as Record<string, unknown>;
  // Improve with AI: the reasons come in the user's language; the prompt keeps its own (2026-11-16).
  const lang = languageLine(input.locale) + (skill.drafts && input.locale === 'zh' ? ' Write each change\'s "reason" in Simplified Chinese too; "text" quotes the prompt\'s own words.' : '');
  const context: Record<string, unknown> = {brief: {...b, examples: undefined}, args, ...(Array.isArray(b.examples) ? {examples: b.examples} : {}), pageView: input.workspace.pageView};
  const messages: ModelMessage[] = [
    {role: 'system', content: `${systemPrompt(to)}\n\nYou are running the skill "${name}".\n${skill.instructions}\nAnswer shape: ${skill.shape}${toolBlurb(to, tools.host, skill.tools)}${lang}`},
    {role: 'user', content: withImages({preset: to, intent: name, page: input.page.label, userText: input.userText, context})},
  ];
  const out = await converse(llm, to, name, messages, skill.tools, tools);
  if (!skill.drafts) return {...out, prompt: undefined};
  const base = readStructured(b.prompt) ?? input.workspace.prompt;
  if (!base) return {reply: out.reply};
  const changes = Array.isArray(out.changes) ? (out.changes as {text?: unknown; reason?: unknown}[]).filter(c => c && typeof c.text === 'string').map(c => ({text: c.text as string, reason: typeof c.reason === 'string' ? c.reason : ''})) : [];
  return {...out, prompt: reworded(base, out.prompt), draft: {base, versionId: typeof b.versionId === 'string' ? b.versionId : null, version: typeof b.version === 'string' ? b.version : null, changes}};
}

/**
 * A message that holds an existing prompt goes to the Prompt helper's import rules, whatever intent
 * the page set (2026-11-16, 3.1): Prompt Design opens on "draft_prompt", and a pasted prompt there
 * must be imported word for word, not summarised. A long, multi-line message counts as a prompt,
 * and so does a document link sent with words like "use this prompt".
 */
export function importIntent(agent: AgentPreset, intent: string, text: string | undefined): string {
  if (agent !== 'prompt_agent' || !['draft_prompt', 'revise_prompt', 'follow_up'].includes(intent)) return intent;
  const t = (text ?? '').trim();
  const lines = t.split('\n').filter(l => l.trim()).length;
  const pasted = lines >= 8 || (lines >= 4 && t.length >= 400);
  const linked = /https?:\/\/\S+/.test(t) && /\b(prompt|initiali[sz]e|import|start from|use this)\b/i.test(t) && !/\b(compare|explain|why|what)\b/i.test(t);
  return pasted || linked ? 'import_prompt' : intent;
}

/**
 * Executes one user turn in the Agent Runtime service (`@yushiguang/sprint-agents`).
 *
 * Stateless and free of database dependencies: receives `AgentTurnInput` from the BFF,
 * runs the page's active agent (plus an optional specialist handoff from `front_desk`), lets
 * each agent call its read tools through `host`, and returns the emitted messages, invocation
 * records, tool calls, and any schema/prompt proposal.
 */
export async function runAgentTurn(input: AgentTurnInput, llm: AgentModel, host?: ToolCaller, progress?: AgentTurnProgress): Promise<AgentTurnOutput> {
  const invocations: AgentTurnOutput['invocations'] = [];
  const messages: AgentEmittedMessage[] = [];
  const tools: TurnTools = {host, skills: [], used: [], modelCalls: [], parseFailures: [], progress};
  // Each message is reported as soon as it is final, so the host can save it while the turn goes on.
  const emit = (m: AgentEmittedMessage) => {
    messages.push(m);
    progress?.({message: m});
  };

  let agent: AgentPreset = input.page.agent;
  let intent: string = importIntent(agent, input.page.intent, input.userText);

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
    emit({role: 'event', agent: null, event: 'join', text: `${agentName(agent)} joined to answer`, msg: {key: '{who} joined to answer', params: {who: agentName(agent)}}});
    invocations.push({from, to: agent, intent, note: from === 'front_desk' ? 'Handed off by the front desk' : 'Passed on by the helper that stayed'});
    progress?.({agent, working: 'Thinking…'});
    out = await invokePreset(llm, agent, intent, input, tools);
  }

  const question = typeof out.question === 'string' ? out.question.trim() : '';
  const draft = out.draft;
  if (draft) {
    // A skill's draft (Improve with AI): one fixed line; the reasons sit on the marks in the
    // editor, so the chat does not repeat them.
    const n = draft.changes.length;
    const version = draft.version ?? '';
    const line = n === 1 ? msg('I made 1 change to {version}. Hover each mark to see why.', {version}) : n ? msg('I made {n} changes to {version}. Hover each mark to see why.', {n, version}) : msg('I have no new change for {version}.', {version});
    emit({role: 'agent', agent, text: msgText(line), msg: line});
  } else {
    const text = [out.reply?.trim(), question].filter(Boolean).join('\n\n');
    if (text) emit({role: 'agent', agent, text});
  }

  // A question, or an answer that leaves the prompt as it is, is a plain answer: no draft (R3-10).
  let proposal: AgentProposalDraft | null = null;
  const base = draft?.base ?? input.workspace.prompt;
  const structured = question ? null : readStructured(out.prompt, base ?? undefined);
  const unmapped = Array.isArray(out.unmapped) ? out.unmapped.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [];
  if (structured && (!base || !structuredEquals(base, structured) || unmapped.length)) {
    proposal = {
      kind: 'prompt',
      agent,
      brief: draft ? `Improve ${draft.version ?? 'the version'}` : input.userText,
      payload: draft
        ? {structured, change: draft.changes.map(c => c.text).join('; ') || 'Improved with AI', changes: draft.changes, baseVersionId: draft.versionId, unmapped: []}
        : {structured, ...(typeof out.change === 'string' && out.change.trim() ? {change: out.change.trim()} : {}), unmapped},
    };
  }

  return {invocations, messages, proposal, skills: tools.skills, toolCalls: tools.used, modelCalls: tools.modelCalls, parseFailures: tools.parseFailures};
}

/**
 * The request as text, then the examples' images (finding 8): each example's images follow a
 * line naming it, and the JSON keeps only how many images it has.
 */
function withImages(body: {preset: string; intent: string; context: Record<string, unknown>} & Record<string, unknown>): string | ContentPart[] {
  const {context} = body;
  const examples = Array.isArray(context.examples) ? (context.examples as ExampleBrief[]) : [];
  if (!examples.some(e => e.images?.length)) return JSON.stringify(body);
  const text = JSON.stringify({...body, context: {...context, examples: examples.map(({images, ...e}) => ({...e, ...(images?.length ? {images: images.length} : {})}))}});
  const parts: ContentPart[] = [{type: 'text', text}];
  for (const e of examples) {
    if (!e.images?.length) continue;
    parts.push({type: 'text', text: `Images of ${e.externalId}:`});
    for (const url of e.images) parts.push({type: 'image', url});
  }
  return parts;
}

/**
 * A one-shot call (no chat history) that may read feature descriptions first: the model answers
 * {"tool": {"name": "read_feature_info", "args": {"keys": [...]}}} to read them, up to twice.
 */
async function withFeatureInfo(llm: AgentModel, preset: AgentPreset | 'optimiser', intent: string, context: Record<string, unknown>, tools?: ToolCaller, signal?: AbortSignal, extra = ''): Promise<string> {
  const shape = PRESETS[preset].intents[intent];
  const toolLine = tools
    ? `\nTo read what features hold and when they help, answer {"tool": {"name": "read_feature_info", "args": {"keys": string[]}}} first; the result comes back as the next message. At most 2 reads.`
    : '';
  const messages: ModelMessage[] = [
    {role: 'system', content: `${systemPrompt(preset)}\nAnswer shape for "${intent}": ${shape}${toolLine}${extra}`},
    {role: 'user', content: withImages({preset, intent, context})},
  ];
  for (let step = 0; ; step++) {
    const raw = await llm.chat(messages, {model: presetModel(preset), json: true, signal});
    const out = parseJsonObject<RawAgentReply>(raw, {} as RawAgentReply);
    if (!out.tool || !tools || step >= 2) return raw;
    let result: unknown;
    if (out.tool.name !== 'read_feature_info') result = {error: `${out.tool.name} is not one of your tools here.`};
    else {
      try {
        result = await tools.call({agent: 'prompt_agent', name: 'read_feature_info', args: out.tool.args ?? {}});
      } catch (e) {
        result = {error: (e as Error).message};
      }
    }
    messages.push({role: 'assistant', content: raw}, {role: 'user', content: JSON.stringify({tool_result: {name: out.tool.name, result}}).slice(0, systemConfig().agent.maxToolResultChars)});
  }
}

/**
 * One Optimiser step: a change from the parent's mistakes (reflection), or a merge of two
 * versions that win on different examples. May tick or untick features, with the reason.
 */
export async function reflectPrompt(input: OptimiserReflectInput, llm: AgentModel, tools?: ToolCaller, signal?: AbortSignal): Promise<OptimiserReflectOutput> {
  const mode = input.mode ?? 'change';
  const raw = await withFeatureInfo(
    llm,
    'optimiser',
    mode === 'merge' ? 'merge' : 'reflect',
    {
      prompt: input.prompt,
      tried: input.triedChanges,
      mixUps: input.mixUps.slice(0, 6),
      macroF1: input.macroF1,
      lowestValue: input.lowestValue,
      examples: (input.examples ?? []).slice(0, 8),
      ...(input.other ? {other: input.other} : {}),
    },
    tools,
    signal,
  );
  const out = parseJsonObject<{prompt?: unknown; change?: unknown}>(raw, {});
  // Wording only: the label key and value names stay the parent's, whatever the model wrote.
  return {prompt: reworded(input.prompt, out.prompt), change: typeof out.change === 'string' ? out.change : ''};
}

/** A model's rewording laid over the prompt it started from (label key and value names kept). */
function reworded(base: StructuredPrompt, answer: unknown): StructuredPrompt {
  return answer && typeof answer === 'object' ? rewordOnly(base, answer as Partial<StructuredPrompt>) : base;
}

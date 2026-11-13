import {
  AVAILABLE_LLM_MODELS,
  type AgentChatOptions,
  type AgentCompletionResult,
  type AgentModel,
  type LlmStreamChunk,
  type ModelMessage,
} from '@tsp/contracts';
import {SAMPLE_STRUCTURED, addFieldRule, hasRule, ruleFor, schemaOf} from '@tsp/domain';
import type {MixUp, StructuredFieldPrompt, StructuredPrompt} from '@tsp/contracts';

/**
 * Stand-in agent model. It answers each agent request with fixed, sensible JSON so the whole
 * workflow runs without a real model. The request format is the real one (see
 * apps/agents/src/runtime.ts); a real model gets the same system prompts and context.
 */
interface Req {
  preset: string;
  intent: string;
  userText?: string;
  context: Record<string, any>;
  /** Results of read tools called earlier in this turn, by tool name. */
  results: Record<string, any>;
}

/** The request is the first user message; later user messages carry tool results. */
function readRequest(messages: ModelMessage[]): Req {
  // A request may carry images after its text: the first text part is the request.
  const users = messages.filter(x => x.role === 'user').map(m => (typeof m.content === 'string' ? m.content : (m.content.find(p => p.type === 'text') as {text: string} | undefined)?.text ?? ''));
  const req = JSON.parse(users[0] ?? '{}') as Req;
  req.results = {};
  for (const u of users.slice(1)) {
    try {
      const r = JSON.parse(u).tool_result;
      if (r) req.results[r.name] = r.result;
    } catch {
      // not a tool result
    }
  }
  return req;
}

/** Paid starts the user asked for in words: "try the prompt", "score v4 on gpt-5.4", "run the optimiser". */
function startRequest(t: string) {
  const model = t.match(/\bon (gpt-[\w.-]+)/i)?.[1] ?? t.match(/\bmodel ([ab])\b/i)?.[1]?.toUpperCase();
  const v = t.match(/\bv\d+(?:\.\d+)?\b/i)?.[0];
  if (/\btry\b/i.test(t)) return {name: 'try_prompt', model};
  if (/\bscore\b/i.test(t) && v) return {name: 'score_version', version: v, model};
  if ((/\boptimi[sz]er\b/i.test(t) && /\b(run|start)\b/i.test(t)) || /\bauto[- ]?optimi[sz]e\b/i.test(t)) return {name: 'start_optimiser', rounds: Number(t.match(/\b(\d+)\s*rounds?\b/i)?.[1]) || undefined};
  return null;
}

/** The prompt agent's start tools: asks for the tool once, then reports what happened. */
function promptAgentStart(r: Req) {
  const s = startRequest(r.userText ?? '');
  if (!s) return null;
  const res = r.results[s.name];
  if (!(s.name in r.results)) {
    const args: Record<string, unknown> =
      s.name === 'try_prompt' ? {...(r.context.prompt ? {prompt: r.context.prompt} : {}), n: 3, ...(s.model ? {model: s.model} : {})} : s.name === 'score_version' ? {version: s.version, ...(s.model ? {model: s.model} : {})} : s.rounds ? {rounds: s.rounds} : {};
    return {tool: {name: s.name, args}};
  }
  if (res?.error) return {reply: `I couldn't start that: ${res.error}`};
  if (res?.already) return {reply: res.already};
  if (s.name === 'try_prompt') {
    const rows = (res?.rows ?? []) as {gold: unknown; model: unknown}[];
    const same = rows.filter(x => x.gold && JSON.stringify(x.gold) === JSON.stringify(x.model)).length;
    return {reply: `I tried it on ${rows.length} eval examples (nothing saved): ${same} of ${rows.filter(x => x.gold).length} match the gold labels.`};
  }
  return {reply: `Started. ${res?.note ?? ''}`.trim()};
}

// A handoff is written first (see the front desk's answer shape), so its reply is never streamed.
function frontDesk(r: Req) {
  const t = (r.userText ?? '').toLowerCase();
  if (startRequest(t)) return {handoff: {to: 'prompt_agent', intent: 'explain_version'}, reply: "I'll bring in the Prompt helper for that."};
  if (looksLikePrompt(r.userText ?? '')) return {handoff: {to: 'prompt_agent', intent: 'import_prompt'}, reply: "I'll bring in the Prompt helper to read your prompt."};
  if (/\b(value|field|label|prompt|rule|wording|version|draft|definition)\b/.test(t) && /\b(change|fix|add|rename|remove|draft|write|improve|what|new)\b/.test(t))
    return {handoff: {to: 'prompt_agent', intent: /^(what|why)\b/.test(t) ? 'explain_version' : 'revise_prompt'}, reply: "I'll bring in the Prompt helper for that."};
  if (/\b(score|report|f1|pass|threshold|good enough|fail)\b/.test(t)) return {handoff: {to: 'evaluation_agent', intent: 'explain_report'}, reply: "I'll ask the Scores helper, who can read the scores."};
  if (/strict|0\.\d+|default/.test(t))
    return {reply: 'Multi-select fields usually score lower than single-select ones. The default of 0.80 is a common bar for almost perfect agreement. You can change it later without losing any scores.'};
  const view = r.context.pageView;
  if (view?.summary) return {reply: `${view.summary} ${r.context.pageHint ?? 'Ask me about anything you see, or tell me what to change.'}`};
  return {reply: `On this page you can ${r.context.pageHint ?? 'follow the steps on the left'}. Ask me about anything you see, or tell me what to change.`};
}

/** A question gets an answer only, never a draft (R3-10). */
const isQuestion = (t: string) => !/^(please\b|(can|could|would|will) you\b)/i.test(t.trim()) && /\?\s*$|^(what|why|how|which|where|when|does|do|is|are)\b/i.test(t.trim());
/** Too short to know what to change: the helper asks one question first. */
const isVague = (t: string) => /^(please )?(improve|fix|change|update|better|rewrite)( it| this| the prompt| the labels)?( please)?[.!]?$/i.test(t.trim());

/** A pasted prompt: several lines, or one that says so. */
const looksLikePrompt = (t: string) => t.trim().split('\n').filter(l => l.trim()).length >= 4 || /^(here is|this is) (my|our|the) (current |existing )?prompt\b/i.test(t.trim());

/**
 * Sorts a raw prompt into the structured parts, by its layout: the text before the first heading
 * is the task; a heading followed by "- Value: definition" lines is a field; other lines under a
 * field are its rules; a "Rules" section is the general rules. Everything else (examples, output
 * format, a field with fewer than two values) is returned in `unmapped`, word for word.
 */
export function parseRawPrompt(raw: string, base: StructuredPrompt): {structured: StructuredPrompt | null; unmapped: string[]} {
  const unmapped: string[] = [];
  const task: string[] = [];
  const rules: string[] = [];
  const fields: StructuredFieldPrompt[] = [];
  type Section = {kind: 'task'} | {kind: 'rules'} | {kind: 'skip'; lines: string[]} | {kind: 'field'; field: StructuredFieldPrompt; heading: string; extra: string[]};
  let sec: Section = {kind: 'task'};
  const close = () => {
    if (sec.kind === 'skip' && sec.lines.length) unmapped.push(sec.lines.join('\n'));
    if (sec.kind === 'field') {
      if (sec.field.values.length >= 2) fields.push({...sec.field, ...(sec.extra.length ? {note: sec.extra.join('\n')} : {})});
      else unmapped.push([sec.heading, ...sec.field.values.map(v => `- ${v.name}: ${v.definition}`), ...sec.extra].join('\n'));
    }
  };
  for (const line0 of raw.split('\n')) {
    const line = line0.trim();
    if (!line) continue;
    const h = line.match(/^#{1,4}\s*(?:\d+[.)]\s*)?(.+?):?$/) ?? line.match(/^(?:\d+[.)]\s*)?([A-Za-z][\w &/-]{1,40}):$/);
    if (h) {
      close();
      const title = h[1].trim();
      if (/^(examples?|few[- ]shot|output|format|response|input|inputs)\b/i.test(title)) sec = {kind: 'skip', lines: [line]};
      else if (/^(general |other |fallback )?(rules?|guidelines|notes?)\b/i.test(title)) sec = {kind: 'rules'};
      else if (/^(task|role|goal|context|background)\b/i.test(title)) sec = {kind: 'task'};
      else {
        const multi = /\b(multi|choose up to|one or more|all that apply)\b/i.test(title);
        const name = title.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase().replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
        sec = {kind: 'field', heading: line, extra: [], field: {name, kind: multi ? 'multi' : 'single', ...(multi ? {min: 1, max: 3} : {}), values: []}};
      }
      continue;
    }
    if (sec.kind === 'skip') sec.lines.push(line);
    else if (sec.kind === 'rules') rules.push(line.replace(/^[-*]\s*/, ''));
    else if (sec.kind === 'task') {
      if (/\b(return|respond|output)\b.*\bjson\b/i.test(line)) unmapped.push(line);
      else task.push(line);
    } else {
      const v = line.match(/^[-*]\s*["“]?([^:"”]{1,40})["”]?\s*[:：]\s*(.+)$/);
      if (v) sec.field.values.push({name: v[1].trim(), definition: v[2].trim()});
      else if (/\b(return|respond|output)\b.*\bjson\b/i.test(line)) unmapped.push(line);
      else sec.extra.push(line.replace(/^[-*]\s*/, ''));
    }
  }
  close();
  if (!fields.length) return {structured: null, unmapped};
  for (const f of fields) if (f.kind === 'multi') f.max = Math.min(f.max ?? 3, f.values.length);
  return {structured: {taskSummary: task.join(' '), features: base.features, fields, generalRules: rules.join('\n'), images: base.images}, unmapped};
}

function importPrompt(r: Req) {
  const base = (r.context.prompt as StructuredPrompt | null) ?? SAMPLE_STRUCTURED;
  const {structured, unmapped} = parseRawPrompt(r.userText ?? '', base);
  if (!structured) return {reply: '', question: 'I could not find label fields in that prompt. Which labels should the model give, and what does each value mean?'};
  const n = unmapped.length;
  return {
    reply: `I sorted your prompt into ${structured.fields.length} label field${structured.fields.length === 1 ? '' : 's'}, the task and the rules. ${n ? `${n} passage${n === 1 ? ' has' : 's have'} no place in the structured prompt (for example examples or output format): the page lists ${n === 1 ? 'it' : 'them'} under "Not carried over".` : 'Everything was carried over.'} Check the draft, then approve it at the top right.`,
    prompt: structured,
    change: 'Imported from an existing prompt',
    unmapped,
  };
}

function promptAgent(r: Req) {
  if (r.intent === 'improve') return improve(r);
  const start = promptAgentStart(r);
  if (start) return start;
  const t = (r.userText ?? '').trim();
  const current = r.context.prompt as StructuredPrompt | null;
  if (r.intent === 'import_prompt' || looksLikePrompt(t)) return importPrompt(r);
  if (r.intent === 'explain_version' || (t && isQuestion(t) && r.context.version)) {
    const v = r.context.version;
    return {reply: v ? `${v.label} was made by ${v.madeBy}. ${v.change ? `It changed: ${v.change}.` : ''} ${v.delta ?? ''}`.trim() : 'Pick a version and I can tell you what it changed.'};
  }
  if (t && isQuestion(t)) {
    return {reply: current?.fields.length ? `The prompt has ${current.fields.length} label fields: ${current.fields.map(f => `${f.name} (${f.values.length} values)`).join(', ')}. I changed nothing; tell me what to change and I'll draft it.` : 'There is no prompt yet. Describe what you want to label, or paste the prompt you use today, and I will draft it.'};
  }
  if (t && isVague(t)) return {reply: '', question: 'Which field should the change help, and what goes wrong with it today?'};
  if (!current?.fields.length || r.intent === 'draft_prompt') {
    const prompt = structuredClone(SAMPLE_STRUCTURED);
    return {reply: `I drafted a prompt from your description: ${prompt.fields.length} label fields, each value with a one-line definition, and the input features they need. It is on the page: edit anything, then press Approve at the top right.`, prompt, change: 'First draft'};
  }
  const prompt = structuredClone(current);
  const add = t.match(/add (?:a |the )?(?:value )?["“]?([^"”]+?)["”]? (?:to|in) (\w+)/i);
  if (add) {
    const field = prompt.fields.find(f => f.name.toLowerCase() === add[2].toLowerCase());
    if (field && !field.values.some(v => v.name.toLowerCase() === add[1].toLowerCase())) {
      field.values.splice(Math.max(0, field.values.length - (field.values.at(-1)?.name === 'Other' ? 1 : 0)), 0, {name: add[1], definition: '[add a one-line definition]'});
      return {reply: `I added ${add[1]} to ${field.name} in a draft. This changes the labels, so gold labels given before will need a quick re-check.`, prompt, change: `Added the value ${add[1]} to ${field.name}`};
    }
  }
  const rename = t.match(/rename ["“]?([^"”]+?)["”]? to ["“]?([^"”]+?)["”]?$/i);
  if (rename) {
    for (const f of prompt.fields) for (const v of f.values) if (v.name.toLowerCase() === rename[1].toLowerCase()) v.name = rename[2];
    return {reply: `I renamed ${rename[1]} to ${rename[2]} in a draft. This changes the labels, so gold labels given before will need a quick re-check.`, prompt, change: `Renamed ${rename[1]} to ${rename[2]}`};
  }
  const rule = t.replace(/\.?$/, '.');
  const named = prompt.fields.find(f => new RegExp(`\\b${f.name}\\b`, 'i').test(t));
  return {reply: 'I drafted that change on the page. Save it to make a new version.', prompt: addFieldRule(prompt, named?.name ?? '', rule), change: rule};
}

/** Reads the report from the page view; off the report page it asks for one with get_report. */
function evaluationAgent(r: Req) {
  const fromView = r.context.pageView?.data ?? null;
  const found = r.results.get_report;
  if (!found && !('get_report' in r.results)) {
    const v = (r.userText ?? '').match(/\bv\d+(?:\.\d+)?\b/i)?.[0];
    return {tool: {name: 'get_report', args: v ? {version: v} : {}}};
  }
  const rep = found?.report;
  if (!rep) return {reply: `${found?.why ?? 'There is no report yet.'} Scores start when the eval set has gold labels and a version has been labeled.`};
  const lv = rep.lowestValue;
  const mix = rep.topMixUps?.[0];
  const failing = (rep.checks ?? []).filter((c: any) => !c.met);
  const verdict = rep.passed
    ? 'It passes every check, so it is ready to use as your final prompt.'
    : failing.length
      ? `It is below the bar on ${failing.map((c: any) => `${c.label} (${c.actual}, needs ${c.need.replace('≥ ', 'at least ')})`).join(' and ')}.`
      : '';
  return {
    reply: [
      `${rep.version} on ${rep.model} has a lowest field Macro-F1 of ${rep.lowestField.macroF1.toFixed(2)} (${rep.lowestField.field}).`,
      verdict,
      lv ? `The weakest value is ${lv.value} at ${lv.f1.toFixed(2)}.` : '',
      mix ? `The most common mix-up: ${mix.gold ?? 'nothing'} labeled as ${mix.predicted ?? 'nothing'} in ${mix.field}, ${mix.count} time${mix.count === 1 ? '' : 's'}.` : '',
      fromView?.advice?.nextStep ? `Next step: ${fromView.advice.nextStep}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

const FALLBACK_RULE = 'Read the description and the on-screen text before judging; when unsure, prefer the more common value.';

function reflect(r: Req) {
  const mixUps: MixUp[] = r.context.mixUps ?? [];
  const tried: string[] = r.context.tried ?? [];
  const prompt = r.context.prompt as StructuredPrompt;
  for (const m of mixUps) {
    const rule = ruleFor(m, schemaOf(prompt));
    if (hasRule(prompt, rule) || tried.includes(rule)) continue;
    return {prompt: addFieldRule(prompt, m.field, rule), change: rule};
  }
  return {prompt: hasRule(prompt, FALLBACK_RULE) ? prompt : addFieldRule(prompt, prompt.fields[0]?.name ?? '', FALLBACK_RULE), change: FALLBACK_RULE};
}

/** Merge: keeps the prompt's rules and adds the other version's rule lines it lacks, in the same field. */
function merge(r: Req) {
  const other = r.context.other?.prompt as StructuredPrompt | undefined;
  let prompt = r.context.prompt as StructuredPrompt;
  if (!other) return reflect(r);
  let added = 0;
  for (const f of other.fields) {
    for (const line of (f.note ?? '').split('\n').map(l => l.trim()).filter(Boolean)) {
      if (hasRule(prompt, line)) continue;
      prompt = addFieldRule(prompt, f.name, line);
      added++;
    }
  }
  return {prompt, change: added ? `Merged the rules of two versions (${added} rule${added === 1 ? '' : 's'} added)` : 'Merged two versions'};
}

/** What a mix-up looks like in a reason line. */
const mixLine = (m: MixUp) =>
  m.kind === 'confused' ? `${m.count} ${m.gold} example${m.count === 1 ? ' was' : 's were'} read as ${m.predicted}` : m.kind === 'extra' ? `${m.predicted} was added ${m.count} time${m.count === 1 ? '' : 's'} when it did not apply` : `${m.gold} was missed ${m.count} time${m.count === 1 ? '' : 's'}`;

/** Improve with AI: up to 3 rules from the top mix-ups, each with its reason. */
function improve(r: Req) {
  const mixUps: MixUp[] = r.context.mixUps ?? [];
  let prompt = r.context.prompt as StructuredPrompt;
  const changes: {text: string; reason: string}[] = [];
  for (const m of mixUps) {
    if (changes.length >= 3) break;
    const rule = ruleFor(m, schemaOf(prompt));
    if (hasRule(prompt, rule)) continue;
    prompt = addFieldRule(prompt, m.field, rule);
    changes.push({text: rule, reason: mixLine(m)});
  }
  if (!changes.length && !hasRule(prompt, FALLBACK_RULE)) {
    prompt = addFieldRule(prompt, prompt.fields[0]?.name ?? '', FALLBACK_RULE);
    changes.push({text: FALLBACK_RULE, reason: `${r.context.mistakes ?? 'Some'} examples are still wrong with no clear mix-up`});
  }
  return {
    reply: changes.length ? `I made ${changes.length} change${changes.length === 1 ? '' : 's'} to ${r.context.version}. Hover each mark to see why.` : `I have no new change for ${r.context.version}.`,
    prompt,
    changes,
  };
}

/** A helper that stayed on its page passes on what the front desk would send to another helper. */
function passOn(r: Req) {
  if (r.intent !== 'follow_up') return null;
  const fd = frontDesk(r) as {handoff?: {to: string}};
  return fd.handoff && fd.handoff.to !== r.preset ? fd : null;
}

export function scriptedAgent(): AgentModel {
  const runText = async (messages: ModelMessage[]) => {
    await new Promise(res => setTimeout(res, 450));
    const req = readRequest(messages);
    const out =
      passOn(req) ??
      req.preset === 'front_desk'
        ? frontDesk(req)
        : req.preset === 'prompt_agent'
          ? promptAgent(req)
          : req.preset === 'optimiser'
            ? req.intent === 'merge'
              ? merge(req)
              : reflect(req)
            : evaluationAgent(req);
    return JSON.stringify(out);
  };

  return {
    models: () => AVAILABLE_LLM_MODELS,
    chat: (messages: ModelMessage[], _opts?: AgentChatOptions) => runText(messages),
    async complete(messages: ModelMessage[], opts?: AgentChatOptions): Promise<AgentCompletionResult> {
      const text = await runText(messages);
      return {
        text,
        model: opts?.model ?? 'gpt-5.4',
        stopReason: 'end_turn',
        usage: {inputTokens: 120, outputTokens: Math.max(1, Math.round(text.length / 4))},
      };
    },
    // Streams the answer in small pieces, the way a real model writes it.
    async *chatStream(messages: ModelMessage[], _opts?: AgentChatOptions): AsyncGenerator<LlmStreamChunk> {
      const text = await runText(messages);
      for (let i = 0; i < text.length; i += 12) {
        yield {type: 'delta', text: text.slice(i, i + 12)};
        await new Promise(res => setTimeout(res, 25));
      }
      yield {type: 'done', createdAt: new Date().toISOString()};
    },
  };
}

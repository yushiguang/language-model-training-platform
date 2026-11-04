import {
  AVAILABLE_LLM_MODELS,
  type AgentChatOptions,
  type AgentCompletionResult,
  type AgentModel,
  type LlmStreamChunk,
  type ModelMessage,
} from '@tsp/contracts';
import {SAMPLE_SCHEMA, draftTemplate, insertRule, ruleFor} from '@tsp/domain';
import type {MixUp, Schema} from '@tsp/contracts';

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
  const users = messages.filter(x => x.role === 'user').map(m => (typeof m.content === 'string' ? m.content : ''));
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

function frontDesk(r: Req) {
  const t = (r.userText ?? '').toLowerCase();
  if (/\b(value|field|label|schema|policy)\b/.test(t) && /\b(add|rename|change|remove|new|split)\b/.test(t))
    return {reply: "That's a change to the labels, so I'll bring in the schema agent.", handoff: {to: 'schema_agent', intent: 'revise_schema'}};
  if (/\b(prompt|rule|wording|version|draft)\b/.test(t) && /\b(change|fix|add|draft|write|improve|what)\b/.test(t))
    return {reply: "I'll bring in the prompt agent for that.", handoff: {to: 'prompt_agent', intent: /what|why/.test(t) ? 'explain_version' : 'revise_prompt'}};
  if (/\b(score|report|f1|pass|threshold|good enough)\b/.test(t))
    return {reply: "I'll ask the evaluation agent, who can read the reports.", handoff: {to: 'evaluation_agent', intent: 'explain_report'}};
  if (/both|which model|cheaper/.test(t))
    return {reply: 'If your training set will be large, pick both: a cheaper model with similar quality saves real money on the full run. If you only need a quick result, Model A alone is simpler.'};
  if (/strict|0\.\d+|default/.test(t))
    return {reply: 'Multi-select fields usually score lower than single-select ones. The default of 0.80 is a common bar for almost perfect agreement. You can change it later without losing any scores.'};
  const view = r.context.pageView;
  if (view?.summary) return {reply: `${view.summary} ${r.context.pageHint ?? 'Ask me about anything you see, or tell me what to change.'}`};
  return {reply: `On this page you can ${r.context.pageHint ?? 'follow the steps on the left'}. Ask me about anything you see, or tell me what to change.`};
}

function schemaAgent(r: Req) {
  const schema: Schema = structuredClone((r.context.schema as Schema) ?? SAMPLE_SCHEMA);
  if (r.intent === 'propose_schema') {
    return {
      reply: `I read your description${r.context.attachments?.length ? ` and the ${r.context.attachments.length} attached files` : ''} and drafted ${schema.fields.length} label fields with a policy. The proposal is on the left. Approve it, or tell me what to change.`,
      schema,
    };
  }
  const t = r.userText ?? '';
  const add = t.match(/add (?:a |the )?(?:value )?["“]?([^"”]+?)["”]? (?:to|in) (\w+)/i);
  if (add) {
    const field = schema.fields.find(f => f.name.toLowerCase() === add[2].toLowerCase());
    if (field && !field.values.some(v => v.name.toLowerCase() === add[1].toLowerCase())) {
      field.values.splice(Math.max(0, field.values.length - (field.values.at(-1)?.name === 'Other' ? 1 : 0)), 0, {name: add[1], definition: '[add a one-line definition]'});
      return {reply: `I added ${add[1]} to ${field.name}. Labels made under the old schema will need a quick re-check.`, schema};
    }
  }
  const rename = t.match(/rename ["“]?([^"”]+?)["”]? to ["“]?([^"”]+?)["”]?$/i);
  if (rename) {
    for (const f of schema.fields) for (const v of f.values) if (v.name.toLowerCase() === rename[1].toLowerCase()) v.name = rename[2];
    return {reply: `I renamed ${rename[1]} to ${rename[2]}.`, schema};
  }
  schema.policy = `${schema.policy} ${t.trim().replace(/\.?$/, '.')}`;
  return {reply: 'I added that to the policy. The change is on the left.', schema};
}

function promptAgent(r: Req) {
  if (r.intent === 'draft_prompt') {
    const d = draftTemplate(r.context.schema, r.context.task ?? '');
    return {reply: 'I drafted a starting prompt from your schema and ticked the features it uses. Edit anything, then press Create.', ...d};
  }
  if (r.intent === 'explain_version') {
    const v = r.context.version;
    return {reply: v ? `${v.label} was made by ${v.madeBy}. ${v.change ? `It changed: ${v.change}.` : ''} ${v.delta ?? ''}`.trim() : 'Pick a version and I can tell you what it changed.'};
  }
  const rule = (r.userText ?? '').trim().replace(/\.?$/, '.');
  const template = insertRule(r.context.template, r.context.schema?.fields?.[0]?.name ?? '', rule);
  return {reply: "I drafted that change in the editor. Save it to make a new version; it's scored on your models right away.", template, change: rule};
}

/** Reads the report from the page view; off the report page it asks for one with get_report. */
function evaluationAgent(r: Req) {
  const fromView = r.context.pageView?.page === 'report' ? r.context.pageView.data : null;
  const found = fromView?.report ? fromView : r.results.get_report;
  if (!found && !('get_report' in r.results)) {
    const v = (r.userText ?? '').match(/\bv\d+\.\d+\b/i)?.[0];
    return {tool: {name: 'get_report', args: v ? {version: v} : {}}};
  }
  const rep = found?.report;
  if (!rep) return {reply: `${found?.why ?? 'There is no report yet.'} Scores start when the eval set has gold labels and a version has been labeled.`};
  const lv = rep.lowestValue;
  const mix = rep.topMixUps?.[0];
  const failing = (rep.checks ?? []).filter((c: any) => !c.met);
  const verdict = rep.passed
    ? 'It passes every check, so it is ready for the training and test sets.'
    : failing.length
      ? `It is below the bar on ${failing.map((c: any) => `${c.label} (${c.actual}, needs ${c.need.replace('≥ ', 'at least ')})`).join(' and ')}.`
      : '';
  return {
    reply: [
      `${rep.version} on Model ${rep.model} has a lowest field macro-F1 of ${rep.lowestField.macroF1.toFixed(2)} (${rep.lowestField.field}).`,
      verdict,
      lv ? `The weakest value is ${lv.value} at ${lv.f1.toFixed(2)}.` : '',
      mix ? `The most common mix-up: ${mix.gold ?? 'nothing'} labeled as ${mix.predicted ?? 'nothing'} in ${mix.field}, ${mix.count} time${mix.count === 1 ? '' : 's'}.` : '',
      fromView?.advice?.nextStep ? `Next step: ${fromView.advice.nextStep}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function reflect(r: Req) {
  const mixUps: MixUp[] = r.context.mixUps ?? [];
  const tried: string[] = r.context.tried ?? [];
  let template: string = r.context.template;
  for (const m of mixUps) {
    const rule = ruleFor(m, r.context.schema);
    if (template.includes(rule) || tried.includes(rule)) continue;
    template = insertRule(template, m.field, rule);
    return {template, change: rule};
  }
  const rule = 'Read the description and the on-screen text before judging; when unsure, prefer the more common value.';
  return {template: template.includes(rule) ? template : insertRule(template, r.context.schema.fields[0].name, rule), change: rule};
}

export function scriptedAgent(): AgentModel {
  const runText = async (messages: ModelMessage[]) => {
    await new Promise(res => setTimeout(res, 450));
    const req = readRequest(messages);
    const out =
      req.preset === 'front_desk'
        ? frontDesk(req)
        : req.preset === 'schema_agent'
          ? schemaAgent(req)
          : req.preset === 'prompt_agent'
            ? promptAgent(req)
            : req.preset === 'optimiser'
              ? reflect(req)
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
    async *chatStream(messages: ModelMessage[], _opts?: AgentChatOptions): AsyncGenerator<LlmStreamChunk> {
      const text = await runText(messages);
      yield {type: 'delta', text};
      yield {type: 'done', createdAt: new Date().toISOString()};
    },
  };
}

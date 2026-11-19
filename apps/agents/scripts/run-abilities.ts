/**
 * Runs the ability cases (`apps/agents/abilities/*.json`, issue #39) against a real model and
 * reports how the helpers did. The model is yours: call `runAbilities` with an `AgentModel` (the
 * same port the hosting platform gives the agent runtime), from a script of your own:
 *
 *   import {runAbilities} from './apps/agents/scripts/run-abilities.ts';
 *   await runAbilities({model: myModel, only: ['A2', 'T8'], out: 'report.json'});
 *
 * The tool side is scored exactly: the tools a case expects were called, the ones it forbids were
 * not, no paid tool ran unasked, and the turn ended with the right helper. The reply items are
 * graded by a model (the grader, else the same model); an item it cannot decide is "unsure", for a
 * person to grade. Paid tools and gold labels never reach anything real: the tools answer from the
 * case file.
 */
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {AgentModel, AgentToolCall} from '@yushiguang/sprint-contracts';
import {createAgentRuntime} from '../src/index.ts';
import {scoreCalls, type AbilityCase, type AbilityResult} from '../src/abilities.ts';

const DIR = fileURLToPath(new URL('../abilities/', import.meta.url));

export interface RunAbilitiesOptions {
  /** The model the helpers run on. */
  model: AgentModel;
  /** The model that grades the replies; the same model when left out. */
  grader?: AgentModel;
  /** Only these rows, like ["A2", "T8"]. */
  only?: string[];
  /** Write the results to this JSON file. */
  out?: string;
  /** Where the lines of the report go (default: the console). */
  log?: (line: string) => void;
}

export type AbilityRun = AbilityResult & {toolCalls: number; modelCalls: number};

/** The grader: one call per case, each reply item met, not met or unsure. */
async function grade(grader: AgentModel, c: AbilityCase, reply: string): Promise<AbilityResult['reply']> {
  const ask = [
    'You grade a helper\'s reply in a labeling website against a checklist. For each item, answer true when the reply clearly does it, false when it clearly does not, and "unsure" when you cannot tell.',
    `The user asked: ${JSON.stringify(c.request.userText)}`,
    `The reply: ${JSON.stringify(reply)}`,
    `The checklist: ${JSON.stringify(c.expect.reply)}`,
    'Answer with one JSON object: {"items": [true | false | "unsure", ...]}, one entry per checklist item, in order.',
  ].join('\n\n');
  try {
    // The grader may wrap its JSON in a code fence: read from the first "{" to the last "}".
    const raw = await grader.chat([{role: 'user', content: ask}], {json: true});
    const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {items?: unknown[]};
    return c.expect.reply.map((item, i) => {
      const v = out.items?.[i];
      return {item, met: v === true || v === false ? v : 'unsure'};
    });
  } catch {
    return c.expect.reply.map(item => ({item, met: 'unsure' as const}));
  }
}

/** Runs the cases, prints a line per case and the totals, and returns the results. */
export async function runAbilities(opts: RunAbilitiesOptions): Promise<AbilityRun[]> {
  const {model} = opts;
  const grader = opts.grader ?? model;
  const log = opts.log ?? ((line: string) => console.log(line));
  const only = opts.only?.map(r => r.trim().toUpperCase());
  const cases = readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(DIR + f, 'utf8')) as AbilityCase)
    .filter(c => !only || only.includes(c.row));

  const results: AbilityRun[] = [];
  for (const c of cases) {
    const rt = createAgentRuntime({
      llm: model,
      tools: {
        async call(t: AgentToolCall) {
          const answer = c.tools[t.name];
          if (!answer) throw new Error(`This case has no answer for ${t.name}.`);
          if ('error' in answer) throw new Error(answer.error);
          return answer.result;
        },
      },
      progress: {publish: () => {}},
    });
    const out = await rt.runTurn({...c.request, turnId: `turn_${c.row}`, ctx: {requestId: `rq_${c.row}`, user: {id: 'u_ability', name: 'Ability user'}, caller: 'abilities', locale: c.request.locale ?? 'en'}});
    const calls = scoreCalls(c, out);
    const reply = out.messages.filter(m => m.role === 'agent').map(m => m.text).join('\n\n');
    const items = await grade(grader, c, reply);
    const toolsOk = !calls.missing.length && !calls.missingSkills.length && !calls.forbidden.length && !calls.unaskedPaid.length && calls.handoffOk;
    const passed = toolsOk && items.every(i => i.met === true);
    results.push({...calls, reply: items, passed, toolCalls: out.toolCalls.length, modelCalls: out.modelCalls.length});
    const unsure = items.filter(i => i.met === 'unsure').length;
    // "unsure" only when the tool side is right and no item is clearly missed.
    log(`${passed ? 'pass' : toolsOk && unsure && items.every(i => i.met !== false) ? 'unsure' : 'FAIL'}  ${c.row}  ${c.name}`);
    for (const m of calls.missing) log(`        did not call ${m}`);
    for (const k of calls.missingSkills) log(`        did not run the skill ${k}`);
    for (const f of calls.forbidden) log(`        called ${f}, which the case forbids`);
    for (const p of calls.unaskedPaid) log(`        started paid work unasked: ${p}`);
    if (!calls.handoffOk) log(`        ended with the wrong helper`);
    for (const i of items.filter(x => x.met !== true)) log(`        ${i.met === false ? 'not met' : 'unsure'}: ${i.item}`);
  }

  const total = (f: (r: (typeof results)[number]) => number) => results.reduce((n, r) => n + f(r), 0);
  log('');
  log(`Cases passed: ${results.filter(r => r.passed).length} of ${results.length}`);
  log(`Paid work started unasked: ${total(r => r.unaskedPaid.length)} (target 0)`);
  log(`Reply items to grade by hand: ${total(r => r.reply.filter(i => i.met === 'unsure').length)}`);
  log(`Tool calls: ${total(r => r.toolCalls)}, model calls: ${total(r => r.modelCalls)}`);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(results, null, 2) + '\n');
  return results;
}

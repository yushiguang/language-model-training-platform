import type {AgentPreset, AgentSkillName, AgentToolName, AgentTurnInput, AgentTurnOutput} from '@yushiguang/sprint-contracts';
import {mayCallTool, PRESET_SKILLS, PRESET_TOOLS, START_TOOLS} from '@yushiguang/sprint-domain';
import {SKILLS} from './skills.ts';

/**
 * Ability cases (#39): what users ask the helpers, with what a good answer does. Plain JSON in
 * `apps/agents/abilities/`, one row of the abilities list per case or more. Unlike the golden
 * fixtures they hold no model replies: they run against a real model (`scripts/run-abilities.ts`),
 * so any agent runtime with any model can be measured on the same cases. See abilities/README.md.
 */
export interface AbilityCase {
  /** The row of the abilities list (issue #39), like "A2" or "T8". */
  row: string;
  /** The case in one line. */
  name: string;
  /** The user's message, the page it was sent from and what that page shows. */
  request: AgentTurnInput;
  /** What each tool answers, by name, whatever its arguments. A tool not listed answers with an error. */
  tools: Partial<Record<AgentToolName, {result: unknown} | {error: string}>>;
  expect: {
    /** Tools a good answer calls (each at least once). */
    calls: AgentToolName[];
    /** Tools a good answer never calls. Paid tools are never allowed unless listed in `calls`. */
    notCalls?: AgentToolName[];
    /** Skills a good answer runs (each at least once); their brief tools count as calls. */
    skills?: AgentSkillName[];
    /** The helper the turn should end with, when it should hand off; left out: no handoff. */
    handoffTo?: AgentPreset;
    /** What the reply must do, item by item; a grader model checks them. */
    reply: string[];
  };
}

/** What one run of a case did, against what it expects. */
export interface AbilityResult {
  row: string;
  name: string;
  called: string[];
  missing: string[];
  forbidden: string[];
  /** Skills the case expects that did not run. */
  missingSkills: string[];
  /** A paid tool the case did not ask for (target: 0 over all cases). */
  unaskedPaid: string[];
  handoffOk: boolean;
  /** Each reply item: met, not met, or unsure (a person grades it). */
  reply: {item: string; met: boolean | 'unsure'}[];
  passed: boolean;
}

/** Problems with a case file, before any model runs it (checked on every `npm test`). */
export function caseProblems(c: AbilityCase): string[] {
  const out: string[] = [];
  if (!/^[A-Z]\d+$/.test(c.row ?? '')) out.push('row must be like "A2"');
  if (!c.name) out.push('name is missing');
  if (!c.request?.userText) out.push('request.userText is missing');
  const agent = c.request?.page?.agent;
  if (!agent || !(agent in PRESET_TOOLS)) out.push('request.page.agent must be a helper');
  if (!c.expect?.reply?.length) out.push('expect.reply needs at least one item');
  const helpers = [agent, c.expect?.handoffTo].filter(Boolean) as AgentPreset[];
  for (const t of c.expect?.calls ?? []) {
    if (!helpers.some(h => mayCallTool(h, t))) out.push(`no helper of this case may call ${t}`);
    if (!(t in (c.tools ?? {}))) out.push(`tools has no answer for ${t}`);
  }
  for (const k of c.expect?.skills ?? []) {
    if (!SKILLS[k]) out.push(`${k} is not a skill`);
    else {
      if (!helpers.some(h => PRESET_SKILLS[h].includes(k))) out.push(`no helper of this case may run ${k}`);
      if (!(SKILLS[k].brief in (c.tools ?? {}))) out.push(`tools has no answer for ${SKILLS[k].brief}, the brief of ${k}`);
    }
  }
  for (const t of c.expect?.notCalls ?? []) if (!Object.values(PRESET_TOOLS).some(list => list.includes(t))) out.push(`${t} is not a tool`);
  return out;
}

/** Scores the tool side of a run (the reply items are graded separately). */
export function scoreCalls(c: AbilityCase, out: AgentTurnOutput): Omit<AbilityResult, 'reply' | 'passed'> {
  const called = out.toolCalls.map(t => t.name as string);
  const missing = c.expect.calls.filter(t => !called.includes(t));
  const forbidden = (c.expect.notCalls ?? []).filter(t => called.includes(t));
  const ran = (out.skills ?? []).map(k => k.name as string);
  const missingSkills = (c.expect.skills ?? []).filter(k => !ran.includes(k));
  const unaskedPaid = called.filter(t => (START_TOOLS as string[]).includes(t) && !(c.expect.calls as string[]).includes(t));
  const last = out.messages.filter(m => m.role === 'agent').at(-1)?.agent ?? null;
  const handoffOk = c.expect.handoffTo ? last === c.expect.handoffTo : last === null || last === c.request.page.agent;
  return {row: c.row, name: c.name, called, missing, forbidden, missingSkills, unaskedPaid, handoffOk};
}

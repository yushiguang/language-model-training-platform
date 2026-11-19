import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAgentRuntime} from './index.ts';
import {caseProblems, scoreCalls, type AbilityCase} from './abilities.ts';
import {replayModel} from './golden.ts';

/**
 * The ability cases (`apps/agents/abilities/*.json`, issue #39) are checked here without a model:
 * each is well formed and its helpers may call the tools it expects. `scripts/run-abilities.ts`
 * runs them against a real model.
 */

const DIR = fileURLToPath(new URL('../abilities/', import.meta.url));
const cases = readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => [f, JSON.parse(readFileSync(DIR + f, 'utf8')) as AbilityCase] as const);

test('ability cases: each is well formed, and its helpers may call the tools it expects', () => {
  assert.ok(cases.length > 0);
  for (const [file, c] of cases) {
    assert.deepEqual(caseProblems(c), [], file);
    assert.ok(file.startsWith(`${c.row}-`), `${file} starts with its row`);
  }
});

test('ability cases: a run is scored on the tools called, paid tools not asked for, and the handoff', async () => {
  const c = cases.find(([f]) => f.startsWith('A5-'))![1];
  const run = async (replies: string[]) => {
    const rt = createAgentRuntime({
      llm: replayModel(replies),
      tools: {call: async t => (c.tools[t.name] && 'result' in c.tools[t.name]! ? (c.tools[t.name] as {result: unknown}).result : {})},
      progress: {publish: () => {}},
    });
    return rt.runTurn({...c.request, turnId: 'turn_ability', ctx: {requestId: 'rq_ability', user: {id: 'u', name: 'U'}, caller: 'test'}});
  };
  const good = scoreCalls(c, await run(['{"tool": {"name": "get_running_work", "args": {}}}', '{"reply": "v3 is being scored: 40 of 120. Stop is on its row."}']));
  assert.deepEqual([good.missing, good.missingSkills, good.forbidden, good.unaskedPaid, good.handoffOk], [[], [], [], [], true]);
  const lazy = scoreCalls(c, await run(['{"reply": "Nothing is running."}']));
  assert.deepEqual(lazy.missing, ['get_running_work']);
});

test('ability cases: a case that expects a tool its helpers cannot call is refused', () => {
  const c = structuredClone(cases[0][1]);
  c.request.page.agent = 'front_desk';
  c.expect.calls = ['get_drafts'];
  c.tools = {get_drafts: {result: {}}};
  assert.deepEqual(caseProblems(c), ['no helper of this case may call get_drafts']);
});

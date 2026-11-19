import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {AgentToolCall} from '@yushiguang/sprint-contracts';
import {createAgentRuntime} from './index.ts';
import {callContext, replayModel, runRequest, type GoldenFixture, type PublishedEvent} from './golden.ts';

/**
 * The golden fixtures (`apps/agents/fixtures/*.json`) replayed on the reference runtime: the
 * recorded model replies go in, each tool call must be the next recorded one and carry the
 * request's project, turn and caller, and the output must equal the recorded one. Any other
 * implementation of `AgentRuntimeContract` is held to the same files (see fixtures/README.md).
 */

const DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtures = readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => [f, JSON.parse(readFileSync(DIR + f, 'utf8')) as GoldenFixture] as const);

test('golden fixtures: there are cases of every kind', () => {
  const kinds = new Set(fixtures.map(([, fx]) => fx.kind));
  assert.deepEqual([...kinds].sort(), ['reflect', 'turn']);
  for (const [file, fx] of fixtures) {
    assert.ok(fx.name && fx.guards.length, `${file} names its case and the guards it holds`);
    assert.deepEqual(JSON.parse(JSON.stringify(fx.request)), fx.request, `${file}: the request is plain JSON`);
  }
});

for (const [file, fx] of fixtures) {
  test(`golden fixture ${file}: ${fx.name}`, async () => {
    const llm = replayModel(fx.model);
    const want = callContext(fx);
    let next = 0;
    const published: PublishedEvent[] = [];
    const rt = createAgentRuntime({
      llm,
      tools: {
        async call(c: AgentToolCall) {
          const rec = fx.tools[next++];
          assert.ok(rec, `${file}: an extra tool call ${c.name}`);
          assert.deepEqual({agent: c.agent, name: c.name, args: c.args}, {agent: rec.agent, name: rec.name, args: rec.args}, `${file}: tool call ${next}`);
          assert.deepEqual({projectId: c.projectId, turnId: c.turnId, ctx: c.ctx}, want, `${file}: the call carries the request's project, turn and caller`);
          if (rec.error != null) throw new Error(rec.error);
          return rec.result;
        },
      },
      progress: {publish: (projectId, turnId, event) => void published.push({projectId, turnId, event})},
    });
    const out = await runRequest(rt, fx);
    assert.deepEqual(out, fx.expected);
    assert.equal(next, fx.tools.length, `${file}: every recorded tool call was made`);
    assert.equal(llm.left(), 0, `${file}: every recorded model reply was used`);
    if (fx.kind === 'turn') {
      // Each final message is published as it is made, under the request's turn.
      const messages = published.filter(p => 'message' in p.event).map(p => ('message' in p.event ? p.event.message : null));
      assert.deepEqual(messages, fx.expected.messages);
      assert.ok(published.every(p => p.projectId === fx.request.workspace.projectId && p.turnId === fx.request.turnId));
    }
  });
}

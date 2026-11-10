import assert from 'node:assert/strict';
import test from 'node:test';
import {scriptedAgent} from '../../../packages/infra/src/standins/scripted-agent.ts';
import {runAgentTurn} from './runtime.ts';

test('runAgentTurn hands off from front_desk to schema_agent and returns a schema proposal', async () => {
  const llm = scriptedAgent();
  const out = await runAgentTurn(
    {
      userText: 'Please add value "News" to primary_value in the schema',
      page: {
        label: 'Setup · evaluation',
        agent: 'front_desk',
        intent: 'answer',
        context: {},
      },
      workspace: {
        projectId: 'pr_1',
        task: 'Tag short videos',
        schema: null,
        history: [],
      },
    },
    llm,
  );

  assert.equal(out.invocations.length, 2);
  assert.equal(out.invocations[0].to, 'front_desk');
  assert.equal(out.invocations[1].to, 'schema_agent');
  assert.equal(out.proposal?.kind, 'schema');
  assert.ok(out.messages.some(m => m.role === 'event' && m.text.includes('Schema agent joined')));
});

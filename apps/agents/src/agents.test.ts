import assert from 'node:assert/strict';
import test from 'node:test';
import {scriptedAgent} from '@tsp/platform';
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
        pageView: null,
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

test('an unknown handoff target is ignored and the front desk answers itself', async () => {
  const llm = {
    async chat() {
      return JSON.stringify({reply: 'Here is what I know.', handoff: {to: 'billing_agent', intent: 'refund'}});
    },
  } as unknown as Parameters<typeof runAgentTurn>[1];
  const out = await runAgentTurn(
    {userText: 'hi', page: {label: 'Setup', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', schema: null, history: [], pageView: null}},
    llm,
  );
  assert.equal(out.invocations.length, 1);
  assert.deepEqual(out.messages.map(m => m.text), ['Here is what I know.']);
});

test('off the report page, the evaluation agent reads the report with a tool and explains it', async () => {
  const calls: string[] = [];
  const host = {
    async call(c: {name: string; args: Record<string, unknown>}) {
      calls.push(`${c.name}:${JSON.stringify(c.args)}`);
      return {report: {version: 'v1.2', model: 'A', passed: false, lowestField: {field: 'format', macroF1: 0.71}, lowestValue: null, checks: [{label: 'Lowest field macro-F1', actual: '0.71', need: '≥ 0.80', met: false}], topMixUps: []}};
    },
  };
  const out = await runAgentTurn(
    {
      userText: 'Is v1.2 good enough?',
      page: {label: 'Prompt versions', agent: 'evaluation_agent', intent: 'explain_report', context: {}},
      workspace: {projectId: 'pr_1', task: '', schema: null, history: [], pageView: {page: 'prompt', title: 'Prompt versions', summary: '', data: {}}},
    },
    scriptedAgent(),
    host,
  );
  assert.deepEqual(calls, ['get_report:{"version":"v1.2"}']);
  assert.deepEqual(out.toolCalls.map(t => [t.agent, t.name, t.ok]), [['evaluation_agent', 'get_report', true]]);
  assert.match(out.messages.at(-1)!.text, /v1\.2 on Model A .*0\.71.*needs at least 0\.80/);
});

test('a tool outside the preset list is refused, and a model that keeps asking still ends the turn', async () => {
  let n = 0;
  const llm = {
    async chat() {
      n++;
      return JSON.stringify({tool: {name: 'check_template', args: {}}});
    },
  } as unknown as Parameters<typeof runAgentTurn>[1];
  const host = {
    async call() {
      throw new Error('should not run');
    },
  };
  const out = await runAgentTurn(
    {userText: 'hi', page: {label: 'Setup', agent: 'evaluation_agent', intent: 'explain_report', context: {}}, workspace: {projectId: 'pr_1', task: '', schema: null, history: [], pageView: null}},
    llm,
    host,
  );
  assert.equal(out.toolCalls.length, 0);
  assert.ok(n <= 6);
  assert.equal(out.messages.length, 1);
});

test('the front desk cannot use start tools; the scripted prompt agent starts score_version', async () => {
  const calls: string[] = [];
  const host = {
    async call(c: {name: string; args: Record<string, unknown>}) {
      calls.push(`${c.name}:${JSON.stringify(c.args)}`);
      return {started: true, note: 'Scoring runs on the eval set; the report appears when it finishes.'};
    },
  };
  const out = await runAgentTurn(
    {userText: 'Please score v1.2 on model A', page: {label: 'Prompt versions', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', schema: null, history: [], pageView: null}},
    scriptedAgent(),
    host,
  );
  assert.equal(out.invocations.at(-1)!.to, 'prompt_agent');
  assert.deepEqual(calls, ['score_version:{"version":"v1.2","model":"A"}']);
  assert.match(out.messages.at(-1)!.text, /[Ss]cor/);
  assert.equal(out.modelCalls.length, 3);
});

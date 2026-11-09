import assert from 'node:assert/strict';
import test from 'node:test';
import {scriptedAgent} from '@tsp/platform';
import {draftImprovement, partialReply, reflectPrompt, runAgentTurn} from './runtime.ts';

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
  assert.ok(out.messages.some(m => m.role === 'event' && m.event === 'join' && m.text === 'Labels helper joined to answer'));
  // The front desk's "I'll bring in…" is not shown: the join line says who answers.
  assert.equal(out.messages.filter(m => m.role === 'agent' && m.agent === 'front_desk').length, 0);
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
  assert.match(out.messages.at(-1)!.text, /v1\.2 on A .*0\.71.*needs at least 0\.80/);
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

test('the reply of a JSON answer is read while it arrives', () => {
  assert.equal(partialReply('{"rep'), null);
  assert.equal(partialReply('{"reply": "On gpt'), 'On gpt');
  assert.equal(partialReply('{"reply": "Line one\\nand \\"two\\" \\u00e9'), 'Line one\nand "two" é');
  assert.equal(partialReply('{"reply": "Done.", "schema": {}}'), 'Done.');
  assert.equal(partialReply('{"reply": "half an escape \\'), 'half an escape ');
});

test('with progress, the turn reports the live line, the streamed reply and each message as it is final', async () => {
  const seen: string[] = [];
  const out = await runAgentTurn(
    {userText: 'Is v1 good enough?', page: {label: 'Prompt versions', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', schema: null, history: [], pageView: null}},
    scriptedAgent(),
    {async call() {
      return {report: null, why: 'No report yet.'};
    }},
    p => seen.push('message' in p ? `message:${p.message.event ?? p.message.role}` : 'working' in p ? `working:${p.agent}:${p.working}` : `reply:${p.agent}`),
  );
  assert.equal(out.messages.at(-1)!.agent, 'evaluation_agent');
  const first = (s: string) => seen.findIndex(x => x.startsWith(s));
  assert.ok(first('working:front_desk:Thinking') === 0);
  assert.ok(first('message:join') > 0);
  assert.ok(seen.includes('working:evaluation_agent:Reading the v1 report…'));
  assert.ok(first('reply:evaluation_agent') > first('working:evaluation_agent:Reading the v1 report…'));
  assert.ok(!seen.includes('reply:front_desk'), "a reply that hands off isn't streamed");
  assert.equal(seen.at(-1), 'message:agent');
});

const optSchema = {fields: [{name: 'format', kind: 'single' as const, values: [{name: 'Vlog', definition: 'a day in a life'}, {name: 'Clip', definition: 'a cut from a longer video'}]}]};
const optTemplate = 'Label the post.\n\n### 1. format\n  Pick one.\n\n## Output\nJSON';
const noFeatures = {video: [], photo_text: [], metadata: []};
const mix = {field: 'format', kind: 'confused' as const, gold: 'Clip', predicted: 'Vlog', count: 5, exampleIds: []};

test('the Optimiser may read feature descriptions before its change, through the tool host', async () => {
  const llm = scriptedAgent();
  const asked: string[] = [];
  let first = true;
  const reading = {
    ...llm,
    chat: async (messages: Parameters<typeof llm.chat>[0], o?: Parameters<typeof llm.chat>[1]) => {
      if (first) {
        first = false;
        return JSON.stringify({tool: {name: 'read_feature_info', args: {keys: ['OCR_Text']}}});
      }
      return llm.chat(messages, o);
    },
  };
  const out = await reflectPrompt(
    {template: optTemplate, features: noFeatures, schema: optSchema, triedChanges: [], mixUps: [mix], lowestField: {field: 'format', macroF1: 0.5}, lowestValue: null},
    reading,
    {call: async c => (asked.push(c.name), {OCR_Text: {description: 'text on screen'}})},
  );
  assert.deepEqual(asked, ['read_feature_info']);
  assert.match(out.template, /Before choosing Vlog/);
});

test('merge keeps the rules of both versions', async () => {
  const a = optTemplate.replace('  Pick one.', '  Pick one.\n  Rule A.');
  const b = optTemplate.replace('  Pick one.', '  Pick one.\n  Rule B.');
  const out = await reflectPrompt(
    {mode: 'merge', template: a, features: noFeatures, schema: optSchema, triedChanges: [], mixUps: [], lowestField: {field: 'format', macroF1: 0.5}, lowestValue: null, other: {template: b, features: noFeatures, change: 'Rule B'}},
    scriptedAgent(),
  );
  assert.match(out.template, /Rule A\.[\s\S]*Rule B\./);
});

test('Improve with AI returns a draft with each change and its reason', async () => {
  const out = await draftImprovement(
    {version: 'v2', template: optTemplate, features: noFeatures, schema: optSchema, mixUps: [mix], lowestField: {field: 'format', macroF1: 0.5}, lowestValue: null, mistakes: 5},
    scriptedAgent(),
  );
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].reason, '5 Clip examples were read as Vlog');
  assert.ok(out.template.includes(out.changes[0].text));
});

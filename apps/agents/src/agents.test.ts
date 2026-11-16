import assert from 'node:assert/strict';
import test from 'node:test';
import type {StructuredPrompt} from '@tsp/contracts';
import {scriptedAgent} from '@tsp/platform';
import {translate} from '@tsp/domain';
import {draftImprovement, importIntent, partialReply, reflectPrompt, runAgentTurn} from './runtime.ts';
import {languageLine, PRESETS, systemPrompt} from './presets.ts';
import {createAgentRuntime} from './index.ts';

test('runAgentTurn hands off from front_desk to the Prompt helper and returns a structured prompt draft', async () => {
  const llm = scriptedAgent();
  const out = await runAgentTurn(
    {
      userText: 'Please add value "News" to primary_value',
      page: {
        label: 'Prompt Design',
        agent: 'front_desk',
        intent: 'answer',
        context: {},
      },
      workspace: {
        projectId: 'pr_1',
        task: 'Tag short videos',
        prompt: null,
        history: [],
        pageView: null,
      },
    },
    llm,
  );

  assert.equal(out.invocations.length, 2);
  assert.equal(out.invocations[0].to, 'front_desk');
  assert.equal(out.invocations[1].to, 'prompt_agent');
  assert.equal(out.proposal?.kind, 'prompt');
  assert.ok(out.proposal!.payload.structured.label.values.length > 0);
  assert.deepEqual(out.proposal!.payload.unmapped, []);
  assert.ok(out.messages.some(m => m.role === 'event' && m.event === 'join' && m.text === 'Prompt helper joined to answer'));
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
    {userText: 'hi', page: {label: 'Setup', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}},
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
      workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: {page: 'prompt', title: 'Prompt versions', summary: '', data: {}}},
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
      return JSON.stringify({tool: {name: 'check_prompt', args: {}}});
    },
  } as unknown as Parameters<typeof runAgentTurn>[1];
  const host = {
    async call() {
      throw new Error('should not run');
    },
  };
  const out = await runAgentTurn(
    {userText: 'hi', page: {label: 'Setup', agent: 'evaluation_agent', intent: 'explain_report', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}},
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
    {userText: 'Please score v1.2 on model A', page: {label: 'Prompt versions', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}},
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
    {userText: 'Is v1 good enough?', page: {label: 'Prompt versions', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}},
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

const optPrompt: StructuredPrompt = {
  taskSummary: 'Label the post.',
  features: {video: ['Description'], photo_text: [], metadata: []},
  label: {name: 'format', kind: 'single', values: [{name: 'Vlog', definition: 'a day in a life'}, {name: 'Clip', definition: 'a cut from a longer video'}]},
  ruleGroups: [],
  images: [],
};
/** All the prompt's rules as one text: the rule groups and the definitions. */
const rules = (p: StructuredPrompt) => [...p.ruleGroups.map(g => g.content), ...p.label.values.map(v => v.definition)].join('\n');
const withRules = (content: string): StructuredPrompt => ({...optPrompt, ruleGroups: [{id: 'rg1', title: 'Label priority', content}]});
const mix = {kind: 'confused' as const, gold: 'Clip', predicted: 'Vlog', count: 5, exampleIds: []};

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
    {prompt: optPrompt, triedChanges: [], mixUps: [mix], macroF1: 0.5, lowestValue: null},
    reading,
    {call: async c => (asked.push(c.name), {OCR_Text: {description: 'text on screen'}})},
  );
  assert.deepEqual(asked, ['read_feature_info']);
  // A fix for one value's boundary goes into that value's definition, as a list item (2026-11-16, 3.2).
  assert.equal(out.prompt.label.values[0].definition, '- a day in a life\n- Does not apply when the post fits Clip better (a cut from a longer video).');
  assert.deepEqual(out.prompt.ruleGroups, [], 'no rule group for a single value');
});

test('merge keeps the rules of both versions', async () => {
  const out = await reflectPrompt(
    {mode: 'merge', prompt: withRules('Rule A.'), triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null, other: {prompt: withRules('Rule B.'), change: 'Rule B'}},
    scriptedAgent(),
  );
  assert.deepEqual(out.prompt.ruleGroups, [{id: 'rg1', title: 'Label priority', content: 'Rule A.\nRule B.'}]);
});

test('a helper that renames a value or the key is overruled: the Optimiser changes wording only', async () => {
  const answer = {prompt: {...optPrompt, taskSummary: 'New task.', label: {name: 'kind', kind: 'single', values: [{name: 'Daily vlog', definition: 'x'}, {name: 'Clip', definition: 'sharper'}, {name: 'Extra', definition: ''}]}}, change: 'c'};
  const llm = {chat: async () => JSON.stringify(answer)} as unknown as Parameters<typeof runAgentTurn>[1];
  const out = await reflectPrompt({prompt: optPrompt, triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null}, llm);
  assert.equal(out.prompt.taskSummary, 'New task.');
  assert.deepEqual([out.prompt.label.name, out.prompt.label.values.map(v => v.name)], ['format', ['Vlog', 'Clip']]);
  assert.equal(out.prompt.label.values[1].definition, 'sharper');
});

test('Improve with AI returns a draft with each change and its reason', async () => {
  const out = await draftImprovement(
    {version: 'v2', prompt: optPrompt, mixUps: [mix], macroF1: 0.5, lowestValue: null, mistakes: 5},
    scriptedAgent(),
  );
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].reason, '5 Clip examples were read as Vlog');
  assert.ok(rules(out.prompt).includes(out.changes[0].text));
});

test('a question on a page gets an answer and never a draft (R3-10)', async () => {
  const ws = {projectId: 'pr_1', task: '', prompt: optPrompt, history: [], pageView: null};
  const ask = (userText: string, intent: string) => runAgentTurn({userText, page: {label: 'Edit prompt', agent: 'prompt_agent', intent, context: {}}, workspace: ws}, scriptedAgent());
  const q = await ask('What does this prompt do with Clips?', 'revise_prompt');
  assert.equal(q.proposal, null);
  assert.ok(q.messages.some(m => m.role === 'agent' && /changed nothing/.test(m.text)));
  const vague = await ask('improve it', 'revise_prompt');
  assert.equal(vague.proposal, null);
  assert.ok(vague.messages.some(m => m.role === 'agent' && m.text.endsWith('?')));
  // A request still drafts: the rule lands in the rule group of the field it names.
  const change = await ask('In format, treat cooking clips as Clip', 'revise_prompt');
  assert.equal(change.proposal?.kind, 'prompt');
  assert.match(rules(change.proposal!.payload.structured), /cooking clips/);
});

test('importing a pasted prompt sorts it into the structured parts and lists what has no place', async () => {
  const pasted = [
    'You label customer messages for a support team.',
    '',
    '## Intent',
    '- Complaint: something went wrong and the customer wants it fixed',
    '- Question: the customer asks how to do something',
    'When a message does both, choose Complaint.',
    '',
    '## Rules',
    '- If the message is empty, choose Question.',
    '',
    '## Examples',
    'Message: "my order is late" -> Complaint',
    '',
    '## Output',
    'Return JSON only.',
  ].join('\n');
  const out = await runAgentTurn({userText: pasted, page: {label: 'Prompt Design', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}}, scriptedAgent());
  assert.deepEqual(out.invocations.map(i => `${i.to}:${i.intent}`), ['front_desk:answer', 'prompt_agent:import_prompt']);
  const p = out.proposal!.payload;
  assert.equal(p.structured.taskSummary, 'You label customer messages for a support team.');
  assert.deepEqual([p.structured.label.name, p.structured.label.values.map(v => v.name)], ['intent', ['Complaint', 'Question']]);
  // Each rules section keeps its heading as a rule group; task-wide lines under the label go to "Choosing a value".
  assert.deepEqual(
    p.structured.ruleGroups.map(g => [g.title, g.content]),
    [
      ['Choosing a value', 'When a message does both, choose Complaint.'],
      ['Rules', '- If the message is empty, choose Question.'],
    ],
  );
  // Examples and the output format have no slot: they are reported word for word, never dropped.
  assert.deepEqual(p.unmapped, ['## Examples\nMessage: "my order is late" -> Complaint', '## Output\nReturn JSON only.']);
  assert.match(out.messages.at(-1)!.text, /2 passages have no place/);
});

test('an answer with a question, or with the same prompt, proposes nothing', async () => {
  const llm = (o: object) => ({chat: async () => JSON.stringify(o)}) as unknown as Parameters<typeof runAgentTurn>[1];
  const turn = (o: object) => runAgentTurn({userText: 'x', page: {label: 'Edit prompt', agent: 'prompt_agent', intent: 'revise_prompt', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: optPrompt, history: [], pageView: null}}, llm(o));
  const more = {...optPrompt, ruleGroups: [{id: '', title: 'Extra', content: 'More.'}]};
  const a = await turn({reply: 'Sure.', question: 'Which field?', prompt: more});
  assert.equal(a.proposal, null);
  assert.deepEqual(a.messages.map(m => m.text), ['Sure.\n\nWhich field?']);
  assert.equal((await turn({reply: 'It reads the description first.', prompt: optPrompt})).proposal, null);
  assert.deepEqual((await turn({reply: 'Done.', prompt: more})).proposal?.payload.structured.ruleGroups, [{id: 'rg1', title: 'Extra', content: 'More.'}]);
});

test('the Optimiser and Improve with AI get the wrong examples', async () => {
  const seen: string[] = [];
  const llm = {chat: async (msgs: {content: string}[]) => (seen.push(msgs.at(-1)!.content), JSON.stringify({prompt: optPrompt, change: 'x', changes: [], reply: ''}))} as unknown as Parameters<typeof runAgentTurn>[1];
  const examples = [{externalId: 'ex-7', features: {Title: 'cooking'}, gold: ['Clip'], predicted: ['Vlog']}];
  await reflectPrompt({prompt: optPrompt, triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null, examples}, llm);
  await draftImprovement({version: 'v2', prompt: optPrompt, mixUps: [], macroF1: 0.5, lowestValue: null, mistakes: 1, examples}, llm);
  assert.equal(seen.filter(c => c.includes('"ex-7"')).length, 2);
});

test('a reply that is not JSON is asked again once, then never shown as broken output', async () => {
  const replies = (xs: string[]) => {
    let i = 0;
    return {chat: async () => xs[Math.min(i++, xs.length - 1)]} as unknown as Parameters<typeof runAgentTurn>[1];
  };
  const turn = (llm: Parameters<typeof runAgentTurn>[1]) => runAgentTurn({userText: 'hi', page: {label: 'Setup', agent: 'front_desk', intent: 'answer', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}}, llm);
  assert.deepEqual((await turn(replies(['{"reply": "Hel', '{"reply": "Hello."}']))).messages.map(m => m.text), ['Hello.']);
  assert.deepEqual((await turn(replies(['{"reply": "Hel', '{"reply": "Hel']))).messages.map(m => m.text), ['Sorry, my answer came out garbled. Please ask again.']);
  assert.deepEqual((await turn(replies(['Hello there.']))).messages.map(m => m.text), ['Hello there.']);
});

test('createAgentRuntime: calls are plain data; progress goes to the injected port under the turn id, tools by project, and cancel stops a request', async () => {
  const published: string[] = [];
  const toolsFor: string[] = [];
  const rt = createAgentRuntime({
    llm: scriptedAgent(),
    tools: projectId => (toolsFor.push(projectId), {call: async () => ({})}),
    progress: {publish: (projectId, turnId, e) => published.push(`${projectId}/${turnId}/${'message' in e ? 'message' : 'working' in e ? 'working' : 'reply'}`)},
  });
  const req = {userText: 'Please add value "News" to primary_value', page: {label: 'Prompt Design', agent: 'front_desk' as const, intent: 'answer', context: {}}, workspace: {projectId: 'pr_9', task: '', prompt: null, history: [], pageView: null}, turnId: 't_1'};
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(req)), 'the request is plain JSON');
  const out = await rt.runTurn(req);
  assert.ok(out.invocations.length >= 1);
  assert.ok(published.length > 0 && published.every(p => p.startsWith('pr_9/t_1/')));
  assert.deepEqual([...new Set(toolsFor)], ['pr_9']);
  // A slow reflect that the caller cancels by id.
  const slow = createAgentRuntime({
    llm: {chat: (_m: unknown, o: {signal?: AbortSignal}) => new Promise((_, rej) => o.signal?.addEventListener('abort', () => rej(new DOMException('Stopped', 'AbortError'))))} as unknown as Parameters<typeof createAgentRuntime>[0]['llm'],
    tools: () => ({call: async () => ({})}),
  });
  const p = slow.reflectPrompt({projectId: 'pr_9', requestId: 'rq_1', prompt: optPrompt, triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null});
  await slow.cancel('rq_1');
  await assert.rejects(p);
});


test('problem reports (1.1.0): every helper has report_problem, the Optimiser does not; the prompt says when to send', () => {
  for (const p of ['front_desk', 'prompt_agent', 'evaluation_agent'] as const) assert.ok(PRESETS[p].tools.includes('report_problem'), p);
  assert.ok(!PRESETS.optimiser.tools.includes('report_problem'));
  assert.match(systemPrompt('front_desk'), /report_problem/);
});

test('problem reports (1.1.0): the helper drafts, asks, and sends only on the next turn after a yes', async () => {
  const calls: {name: string; args: Record<string, unknown>}[] = [];
  const host = {
    async call({name, args}: {name: string; args: Record<string, unknown>}) {
      calls.push({name, args});
      return args.send ? {ticketId: 'T-ABC123'} : {draft: {summary: String(args.summary)}, attached: ['the page'], notAttached: ['your prompt']};
    },
  };
  const page = {label: 'Prompt Tuning', agent: 'front_desk' as const, intent: 'answer' as const, context: {}};
  const ws = (history: {role: 'user' | 'agent'; text: string}[]) => ({projectId: 'pr_1', task: '', prompt: null, history: history.map(h => ({...h, agent: null, page: 'prompt', createdAt: ''})), pageView: null});
  const first = await runAgentTurn({userText: 'The Save button does nothing', page, workspace: ws([])}, scriptedAgent(), host);
  assert.deepEqual(calls.map(c => c.args.send ?? false), [false]);
  const ask = first.messages.at(-1)!.text;
  assert.match(ask, /Shall I send it\?/);
  const second = await runAgentTurn({userText: 'yes', page, workspace: ws([{role: 'user', text: 'The Save button does nothing'}, {role: 'agent', text: ask}])}, scriptedAgent(), host);
  assert.deepEqual(calls.map(c => c.args.send ?? false), [false, true]);
  assert.match(second.messages.at(-1)!.text, /T-ABC123/);
});

test('languages (1.1.0): the helpers answer in Chinese with the site\'s own words, and nothing changes for English', () => {
  assert.equal(languageLine('en'), '');
  assert.equal(languageLine(undefined), '');
  const zh = languageLine('zh');
  assert.match(zh, /Simplified Chinese/);
  for (const term of ['Prompt Design', 'Gold Labels', 'Optimiser']) assert.ok(zh.includes(`${term} = ${translate('zh', term)}`), term);
});

test('a pasted or linked prompt on Prompt Design is imported, whatever intent the page set (2026-11-16, 3.1)', async () => {
  const pasted = ['You label posts.', '## Category', '- Strong: clearly explicit', '- Weak: suggestive only', '- None: neither', '## Strong criteria', 'Nudity is shown.', 'A close-up of underwear.'].join('\n');
  assert.equal(importIntent('prompt_agent', 'draft_prompt', pasted), 'import_prompt');
  assert.equal(importIntent('prompt_agent', 'revise_prompt', 'Initialize from this prompt: https://docs.example.com/d/abc'), 'import_prompt');
  assert.equal(importIntent('prompt_agent', 'draft_prompt', 'I want to label posts as strong, weak or none.'), 'draft_prompt');
  assert.equal(importIntent('evaluation_agent', 'explain_report', pasted), 'explain_report');
  const out = await runAgentTurn({userText: pasted, page: {label: 'Prompt Design', agent: 'prompt_agent', intent: 'draft_prompt', context: {}}, workspace: {projectId: 'pr_1', task: '', prompt: null, history: [], pageView: null}}, scriptedAgent());
  assert.deepEqual(out.invocations.map(i => `${i.to}:${i.intent}`), ['prompt_agent:import_prompt']);
  // A heading named after a value goes into that value's definition, line by line (3.2).
  const strong = out.proposal!.payload.structured.label.values.find(v => v.name === 'Strong');
  assert.equal(strong?.definition, '- clearly explicit\n- Nudity is shown.\n- A close-up of underwear.');
  assert.deepEqual(out.proposal!.payload.structured.ruleGroups, []);
});

test('Improve with AI answers in Chinese when the user reads the site in Chinese; the prompt keeps its language', async () => {
  const systems: string[] = [];
  const llm = {chat: async (msgs: {role: string; content: string}[]) => (systems.push(msgs[0].content), JSON.stringify({prompt: optPrompt, changes: [], reply: ''}))} as unknown as Parameters<typeof runAgentTurn>[1];
  await draftImprovement({version: 'v2', prompt: optPrompt, mixUps: [], macroF1: 0.5, lowestValue: null, mistakes: 1, locale: 'zh'}, llm);
  await draftImprovement({version: 'v2', prompt: optPrompt, mixUps: [], macroF1: 0.5, lowestValue: null, mistakes: 1}, llm);
  assert.match(systems[0], /Simplified Chinese/);
  assert.match(systems[0], /each change's "reason" in Simplified Chinese/);
  assert.doesNotMatch(systems[1], /Simplified Chinese/);
});

test('the helpers know the one-label rules: definitions hold one value, rule groups span values, both item types get features', () => {
  for (const p of ['prompt_agent', 'optimiser'] as const) {
    const text = systemPrompt(p);
    assert.doesNotMatch(text, /"fields"|lowest field|definition is one line/i, p);
  }
  // Single or multi select on the one label (resilience spec, 1).
  assert.match(systemPrompt('prompt_agent'), /"kind" is "single" when each item gets one value and "multi"/);
  assert.match(systemPrompt('prompt_agent'), /"exclusive": true/);
  assert.match(systemPrompt('optimiser'), /single or multi select/);
  assert.match(systemPrompt('prompt_agent'), /Never put a value's own criteria into a rule group/);
  assert.match(systemPrompt('prompt_agent'), /tick the matching evidence features in BOTH groups/);
  assert.match(systemPrompt('prompt_agent'), /"Other" or "None"/);
  assert.match(systemPrompt('optimiser'), /refine that value's "definition"/);
  assert.match(systemPrompt('evaluation_agent'), /Macro-F1 of the project's label/);
});

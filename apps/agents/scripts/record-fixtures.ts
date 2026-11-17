/**
 * Records the golden agent fixtures in `apps/agents/fixtures/` (see its README.md). Each case is a
 * request, the model's replies (written here, or the stand-in model's when a reply is `null`) and
 * the answer each tool gives; the reference runtime runs it and the file keeps what it asked and
 * answered. Run it after a change that is meant to change a fixture, and read the diff:
 *
 *   node --experimental-strip-types --no-warnings apps/agents/scripts/record-fixtures.ts
 */
import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {AgentModel, AgentToolCall, AgentTurnRequest, LlmStreamChunk, ModelMessage, RequestContext, StructuredPrompt} from '@sprint/contracts';
import {scriptedAgent} from '@sprint/platform';
import {createAgentRuntime} from '../src/index.ts';
import {runRequest, type GoldenFixture, type GoldenRequest, type GoldenToolCall} from '../src/golden.ts';

const DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

type Answer = {result: unknown} | {error: string};

type Case = GoldenRequest & {
  file: string;
  name: string;
  guards: string[];
  /** The model's replies in order; `null` (or no list) lets the stand-in model answer. */
  replies?: (string | null)[];
  /** What each tool answers, by name. */
  tools?: Record<string, Answer>;
};

const ctx: RequestContext = {requestId: 'rq_fixture', user: {id: 'u_fixture', name: 'Fixture user'}, caller: 'workflow', locale: 'en'};
const prompt: StructuredPrompt = {
  taskSummary: 'Label the post.',
  features: {video: ['Description'], photo_text: [], metadata: []},
  label: {name: 'format', kind: 'single', values: [{name: 'Vlog', definition: 'a day in a life'}, {name: 'Clip', definition: 'a cut from a longer video'}]},
  ruleGroups: [],
  images: [],
};
const withRules = (content: string): StructuredPrompt => ({...prompt, ruleGroups: [{id: 'rg1', title: 'Label priority', content}]});
const workspace = (over: Partial<AgentTurnRequest['workspace']> = {}): AgentTurnRequest['workspace'] => ({projectId: 'pr_fixture', task: 'Tag short videos', prompt: null, history: [], pageView: null, ...over});
const turn = (file: string, name: string, guards: string[], userText: string, page: {label: string; agent: 'front_desk' | 'prompt_agent' | 'evaluation_agent'; intent: string}, more: Partial<Case> & {ws?: Parameters<typeof workspace>[0]} = {}): Case => {
  const {ws, ...rest} = more;
  return {file, name, guards, kind: 'turn', request: {userText, page: {...page, context: {}}, workspace: workspace(ws), turnId: 'turn_fixture', ctx, locale: 'en'}, ...rest} as Case;
};
const json = (x: unknown) => JSON.stringify(x);
const mixUp = {kind: 'confused' as const, gold: 'Clip', predicted: 'Vlog', count: 5, exampleIds: []};
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

const CASES: Case[] = [
  turn('turn-front-desk-answers', 'The front desk answers a question about the page itself', ['the page view is the workspace: no tool is needed for what the page shows'], 'What is this page for?', {label: 'Prompt Design', agent: 'front_desk', intent: 'answer'}, {
    ws: {pageView: {page: 'prompt_design', title: 'Prompt Design', summary: 'Write the first prompt: what to label and the values.', data: {}}},
  }),
  turn('turn-handoff-prompt-draft', 'The front desk hands a prompt change to the Prompt helper, which drafts it', ['handoffs go only to known specialists, and the join line says who answers', 'a draft is a proposal: the turn saves nothing'], 'Please add value "News" to primary_value', {label: 'Prompt Design', agent: 'front_desk', intent: 'answer'}),
  turn('turn-unknown-handoff-ignored', 'A handoff to a helper that does not exist is ignored; the front desk answers itself', ['handoffs go only to known specialists'], 'hi', {label: 'Projects', agent: 'front_desk', intent: 'answer'}, {
    replies: [json({reply: 'Here is what I know.', handoff: {to: 'billing_agent', intent: 'refund'}})],
  }),
  turn('turn-import-lists-unmapped', 'A pasted prompt is imported into the structured parts; what has no place is listed', ['nothing is carried over silently on import: unmapped passages are listed word for word'], pasted, {label: 'Prompt Design', agent: 'front_desk', intent: 'answer'}),
  turn('turn-question-drafts-nothing', 'A question about the prompt gets an answer and no draft', ['a question, or an answer that leaves the prompt as it is, proposes nothing'], 'What does this prompt do with Clips?', {label: 'Edit prompt', agent: 'prompt_agent', intent: 'revise_prompt'}, {ws: {prompt}}),
  turn('turn-evaluation-reads-report', 'Off the report page, the Scores helper reads the report with a tool and explains it', ['tool calls carry the turn\'s project, turn id and caller'], 'Is v1.2 good enough?', {label: 'Prompt versions', agent: 'evaluation_agent', intent: 'explain_report'}, {
    ws: {pageView: {page: 'prompt', title: 'Prompt versions', summary: '', data: {}}},
    tools: {
      get_report: {result: {report: {version: 'v1.2', model: 'A', macroF1: 0.74, passed: false, lowestField: {field: 'format', macroF1: 0.71}, lowestValue: null, checks: [{label: 'Lowest field macro-F1', actual: '0.71', need: '≥ 0.80', met: false}], topMixUps: []}}},
    },
  }),
  turn('turn-tool-outside-preset-refused', 'A tool the helper does not have is refused before it reaches the host', ['a helper calls only the tools its preset lists (the host refuses them too)'], 'Start the optimiser', {label: 'Projects', agent: 'front_desk', intent: 'answer'}, {
    replies: [json({tool: {name: 'start_optimiser', args: {}}}), json({reply: 'I cannot start that here. Open Prompt Tuning and ask the Prompt helper.'})],
  }),
  turn('turn-tool-error-reaches-helper', 'A tool error goes back to the helper as a message it can act on', ['a failed tool call is recorded as not ok and the turn goes on'], 'Show me v9', {label: 'Projects', agent: 'front_desk', intent: 'answer'}, {
    replies: [json({tool: {name: 'get_version', args: {version: 'v9'}}}), json({reply: 'There is no v9. The project has v1.'})],
    tools: {get_version: {error: 'There is no version "v9". Versions: v1.'}},
  }),
  turn('turn-not-json-retried-once', 'An answer that is not JSON is asked for once more', ['an answer that is not one JSON object is retried once'], 'hello', {label: 'Projects', agent: 'front_desk', intent: 'answer'}, {
    replies: ['{"reply": "Hel', json({reply: 'Hello.'})],
  }),
  turn('turn-garbled-twice-apology', 'Two broken answers end in a short apology, never broken output', ['broken output is never shown'], 'hello', {label: 'Projects', agent: 'front_desk', intent: 'answer'}, {
    replies: ['{"reply": "Hel', '{"reply": "Hel'],
  }),
  turn('turn-problem-report-draft', 'A problem is drafted as a report and shown to the user; nothing is sent', ['a problem report is drafted first; it is sent only on a later yes (the host enforces it)'], 'Saving does nothing', {label: 'Prompt Design', agent: 'front_desk', intent: 'answer'}, {
    ws: {pageView: {page: 'prompt_design', title: 'Prompt Design', summary: '', data: {}}},
    tools: {
      report_problem: {result: {draft: {summary: 'Saving does nothing', expected: 'Prompt Design works as described.', actual: 'Saving does nothing', steps: ['Open Prompt Design']}, attached: ['the page and the project it is about'], notAttached: ['your prompt, examples and gold labels']}},
    },
  }),
  {
    file: 'reflect-wording-only',
    name: 'An Optimiser change that renames the label or its values keeps the names',
    guards: ['the Optimiser changes wording only: label key and value names stay'],
    kind: 'reflect',
    request: {projectId: 'pr_fixture', ctx, prompt, triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null},
    replies: [json({prompt: {...prompt, taskSummary: 'New task.', label: {name: 'kind', kind: 'single', values: [{name: 'Daily vlog', definition: 'x'}, {name: 'Clip', definition: 'sharper'}, {name: 'Extra', definition: ''}]}}, change: 'Sharper Clip definition'})],
  },
  {
    file: 'reflect-reads-feature-info',
    name: 'The Optimiser reads feature descriptions through the tool host before its change',
    guards: ['the Optimiser reads feature descriptions only (read_feature_info), as the Prompt helper', 'tool calls outside a turn carry the project, no turn id and the caller'],
    kind: 'reflect',
    request: {projectId: 'pr_fixture', ctx, prompt, triedChanges: [], mixUps: [mixUp], macroF1: 0.5, lowestValue: null},
    replies: [json({tool: {name: 'read_feature_info', args: {keys: ['OCR_Text']}}}), null],
    tools: {read_feature_info: {result: {OCR_Text: {description: 'Text read from the video frames.'}}}},
  },
  {
    file: 'reflect-merge-keeps-both',
    name: 'A merge keeps the rules of both versions',
    guards: ['a merge keeps what both parents had'],
    kind: 'reflect',
    request: {projectId: 'pr_fixture', ctx, mode: 'merge', prompt: withRules('Rule A.'), triedChanges: [], mixUps: [], macroF1: 0.5, lowestValue: null, other: {prompt: withRules('Rule B.'), change: 'Rule B'}},
  },
  {
    file: 'improve-draft-with-reasons',
    name: 'Improve with AI returns a draft with each change and its reason',
    guards: ['Improve with AI changes wording only and gives a reason for every change'],
    kind: 'improve',
    request: {projectId: 'pr_fixture', ctx, version: 'v2', prompt, mixUps: [mixUp], macroF1: 0.5, lowestValue: null, mistakes: 5},
  },
];

/** The stand-in model, or the case's own replies, with every reply written down. */
function recordingModel(replies: (string | null)[] | undefined, said: string[]): AgentModel {
  const stand = scriptedAgent();
  let i = 0;
  const next = async (messages: ModelMessage[]) => {
    const own = replies?.[i++];
    const text = own ?? (await stand.chat(messages));
    said.push(text);
    return text;
  };
  return {
    models: () => stand.models(),
    chat: next,
    complete: async messages => ({text: await next(messages), model: 'fixture'}),
    async *chatStream(messages): AsyncGenerator<LlmStreamChunk> {
      yield {type: 'delta', text: await next(messages)};
      yield {type: 'done', createdAt: ''};
    },
  };
}

async function record(c: Case): Promise<GoldenFixture> {
  const model: string[] = [];
  const tools: GoldenToolCall[] = [];
  const rt = createAgentRuntime({
    llm: recordingModel(c.replies, model),
    tools: {
      async call({agent, name, args}: AgentToolCall) {
        const answer = c.tools?.[name];
        if (!answer) throw new Error(`Case ${c.file} has no answer for tool ${name}.`);
        tools.push({agent, name, args, ...answer});
        if ('error' in answer) throw new Error(answer.error);
        return answer.result;
      },
    },
    progress: {publish: () => undefined},
  });
  const expected = await runRequest(rt, c);
  const {file: _f, replies: _r, tools: _t, ...rest} = c;
  return {...rest, model, tools, expected} as GoldenFixture;
}

mkdirSync(DIR, {recursive: true});
for (const f of readdirSync(DIR)) if (f.endsWith('.json')) rmSync(DIR + f);
for (const c of CASES) {
  const fx = await record(c);
  writeFileSync(`${DIR}${c.file}.json`, `${JSON.stringify(fx, null, 2)}\n`);
}
console.log(`Recorded ${CASES.length} fixtures in ${DIR}`);

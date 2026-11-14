import type {
  AgentLive,
  AgentPreset,
  AgentProgressPort,
  AgentProposal,
  AgentTurnOutput,
  AgentTurnProgress,
  AgentWorkspaceSnapshot,
  ChatAttachment,
  ChatMessage,
  ClientDiagnostics,
  Locale,
  PageContext,
  StartRequest,
  StructuredPrompt,
} from '@tsp/contracts';
import {agentName, answersForHelpers, fieldsRight, newId, promptKeys, readStructured, rewordOnly, settingsHash, structuredEquals, tidyStructured, versionLabel, visibleToAgents, wrongExamples, toMap, msg} from '@tsp/domain';
import {loadProjectState} from './projects.ts';
import {emitChange, getApp, now, tm} from './app.ts';
import {joinedMsg, postEvent} from './chat-events.ts';
import {beginTurn, endTurn} from './problems.ts';
import {agentTools, getPageView} from './page-views.ts';
import {scoreOnOptimiserHalf} from './evaluation.ts';
import {labelComments, withComments} from './mismatches.ts';
import {lockHoldout} from './governance.ts';


/** Progress handlers of the turns running now, by turn id. */
const turnProgress = new Map<string, AgentTurnProgress>();

/**
 * The progress port the agent runtime is built with (spec 1.0.0, 7.1.3): each event goes to the
 * turn that asked for it, which saves its messages and moves Ask AI's live line.
 */
export const agentProgress: AgentProgressPort = {
  publish: (_projectId, turnId, event) => turnProgress.get(turnId)?.(event),
};

export type {PageContext};

const busyProjects = new Set<string>();
export const isAgentBusy = (projectId: string): boolean => busyProjects.has(projectId);

/**
 * The turn running now, per project: who works, the live line and the reply so far. Kept apart
 * from the change feed, so a streaming reply doesn't reload the page's state (HTTP: an SSE stream).
 */
const live = new Map<string, AgentLive>();
const liveListeners = new Set<() => void>();
const setLive = (projectId: string, l: AgentLive | null) => {
  if (l) live.set(projectId, l);
  else live.delete(projectId);
  liveListeners.forEach(fn => fn());
};
export const agentLive = (projectId: string): AgentLive | null => live.get(projectId) ?? null;
export function subscribeAgentLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => void liveListeners.delete(listener);
}

/**
 * A helper that joined to answer keeps answering on that page: the user's next messages there go
 * straight to it, until they write from another page. Kept per project for this session.
 */
const stays = new Map<string, {agent: AgentPreset; page: string}>();
const pageKey = (page: PageContext) => page.where?.page ?? page.label;
/** The page's name in action lines: its label without the version or other detail. */
const pageName = (page: PageContext) => page.label.split(' · ')[0];

/** Which helper answers the next message on this page. */
export function answeringAgent(projectId: string, page: PageContext): AgentPreset {
  const s = stays.get(projectId);
  return s && s.page === pageKey(page) ? s.agent : page.agent;
}

export async function chatHistory(projectId: string): Promise<ChatMessage[]> {
  return getApp().catalog.find('chat_messages', {projectId}, 'createdAt');
}

async function post(projectId: string, m: Omit<ChatMessage, 'id' | 'projectId' | 'createdAt'>): Promise<ChatMessage> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), ...m};
  await getApp().catalog.insert('chat_messages', msg);
  emitChange();
  return msg;
}

async function loadWorkspaceSnapshot(
  projectId: string,
  page: PageContext,
  attachments?: ChatAttachment[],
): Promise<AgentWorkspaceSnapshot> {
  const {catalog, examples} = getApp();
  const project = await catalog.get('projects', projectId);
  const setup = project?.setupVersionId ? await catalog.get('setup_versions', project.setupVersionId) : null;
  const history = await chatHistory(projectId);
  const [newest] = await catalog.find('prompt_versions', {projectId}, 'createdAt desc');

  // The prompt the user is looking at: the page's unsaved draft, else an open draft, else the newest version.
  const open = (await openProposals(projectId))[0];
  const prompt = readStructured(page.context.prompt) ?? open?.payload.structured ?? newest?.structured ?? null;
  const task = prompt?.taskSummary || setup?.task || '';

  let attachedExamples = undefined;
  if (attachments?.length) {
    const idCandidates = new Set<string>();
    for (const a of attachments) {
      if (!a.content) continue;
      for (const m of a.content.matchAll(/\b(?:ext_\d+|\d{3,})\b/g)) {
        idCandidates.add(m[0]);
      }
    }
    if (idCandidates.size > 0) {
      const found = await examples.lookup([...idCandidates].slice(0, 10));
      if (found.length > 0) attachedExamples = found;
    }
  }

  // The page's unsaved edits go to the agent as the page's `context`; the view holds saved data.
  // What the page holds that isn't saved (the editor's draft template, ticked features, images) goes
  // into the view's `unsaved` block too, so every helper reads the same workspace (R3-3).
  const {...unsaved} = (page.context ?? {}) as Record<string, unknown>;
  const pageView = await getPageView(projectId, page.where ?? {page: 'projects', params: {}}, unsaved);

  return {
    projectId,
    task,
    prompt,
    pageView,
    history: history.map(({role, agent, text, page: p, createdAt}) => ({role, agent, text, page: p, createdAt})),
    attachedExamples,
  };
}

/**
 * BFF dispatcher for assistant turns:
 * 1. Persists the user's message and loads the project's workspace snapshot from the catalog.
 * 2. Calls the stateless Agent Runtime service (`@tsp/agents`) with `AgentTurnInput`, which
 *    includes the view of the page the user is on, and lends it the read tools.
 * 3. Persists start requests, emitted agent/event messages, and any new proposal to the catalog.
 */
export async function sendUserMessage(
  projectId: string,
  text: string,
  page: PageContext,
  attachments?: ChatAttachment[],
  /** A helper the user called by a button: it joins with a line and keeps answering on this page. */
  join?: boolean,
  /** The user's language and what their browser saw (spec 1.1.0): for this turn only, never saved. */
  extra: {locale?: Locale; client?: ClientDiagnostics} = {},
): Promise<AgentProposal | null> {
  busyProjects.add(projectId);
  const started = Date.now();
  const pageId = page.where?.page ?? 'other';
  // Back from another page: the page's own helper answers again, and the chat says so.
  const stay = stays.get(projectId);
  if (stay && stay.page !== pageKey(page)) {
    stays.delete(projectId);
    if (stay.agent !== page.agent) await postEvent(projectId, 'page', page.agent, msg('answers on {page}', {page: pageName(page)}));
  }
  if (join) stays.delete(projectId);
  const turnPage: PageContext = stays.has(projectId) ? {...page, agent: stays.get(projectId)!.agent, intent: 'follow_up'} : page;
  const entry = turnPage.agent;
  setLive(projectId, {agent: entry, working: 'Thinking…', reply: null});
  let outcome = 'error';
  tm().event('chat_message_sent', {entry_agent: entry, chars: text.length, attachments: attachments?.length ?? 0});
  const cleanAttachments = attachments?.map(({name, size, url}) => ({name, size, ...(url ? {url} : {})}));
  await post(projectId, {
    role: 'user',
    agent: null,
    text,
    page: page.label,
    ...(cleanAttachments?.length ? {attachments: cleanAttachments} : {}),
  });
  if (join) await post(projectId, {role: 'event', agent: null, event: 'join', text: `${agentName(page.agent)} joined to answer`, msg: joinedMsg(page.agent), page: page.label});

  try {
    const {catalog, agents, gateway} = getApp();
    const workspace = await loadWorkspaceSnapshot(projectId, turnPage, attachments);
    // Messages are saved the moment they are final; the live line and the streamed reply show
    // what the turn is doing until then.
    let saving = Promise.resolve();
    const progress: AgentTurnProgress = p => {
      if ('message' in p) {
        const msg = p.message;
        saving = saving.then(() =>
          post(projectId, {role: msg.role, agent: msg.agent, text: msg.text, page: page.label, ...(msg.event ? {event: msg.event} : {}), ...(msg.msg ? {msg: msg.msg} : {}), ...(msg.choices ? {choices: msg.choices} : {})}).then(() => undefined),
        );
        setLive(projectId, msg.role === 'agent' ? null : {agent: agentLive(projectId)?.agent ?? entry, working: 'Thinking…', reply: null});
      } else if ('working' in p) setLive(projectId, {agent: p.agent, working: p.working, msg: p.msg ?? null, reply: null});
      else setLive(projectId, {agent: p.agent, working: null, reply: p.reply});
    };
    const turnId = newId('turn');
    turnProgress.set(turnId, progress);
    const locale = extra.locale ?? 'en';
    beginTurn(projectId, {page: turnPage, locale, client: extra.client ?? null});
    const turnOut = await agents.runTurn({userText: text, page: turnPage, attachments, workspace, turnId, locale}).finally(() => {
      turnProgress.delete(turnId);
      endTurn(projectId);
    });
    await saving;
    outcome = 'ok';
    recordTurn(turnOut, entry, started);
    const joined = turnOut.invocations.filter(i => i.from !== 'user').at(-1);
    if (joined) stays.set(projectId, {agent: joined.to, page: pageKey(page)});
    else if (join) stays.set(projectId, {agent: page.agent, page: pageKey(page)});

    for (const inv of turnOut.invocations) {
      const start: StartRequest = {
        id: newId('sr'),
        projectId,
        createdAt: now(),
        from: inv.from,
        to: inv.to,
        intent: inv.intent,
        refs: {},
        userRequest: text,
        note: inv.note,
      };
      await catalog.insert('start_requests', start);
    }

    if (turnOut.proposal) {
      // A draft that changes nothing on the page is a plain answer, not a draft.
      const base = workspace.prompt;
      const structured = tidyStructured(turnOut.proposal.payload.structured);
      if (base && structuredEquals(base, structured) && !turnOut.proposal.payload.unmapped.length) return null;
      for (const prev of await openProposals(projectId)) await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
      const [newest] = await catalog.find('prompt_versions', {projectId}, 'createdAt desc');
      const onEdit = page.where?.page === 'prompt_edit';
      const baseVersionId = onEdit ? (page.where?.params.v ?? newest?.id ?? null) : (newest?.id ?? null);
      const proposal: AgentProposal = {
        id: newId('ap'),
        projectId,
        agent: turnOut.proposal.agent,
        kind: 'prompt',
        payload: {...turnOut.proposal.payload, structured, baseVersionId},
        brief: turnOut.proposal.brief,
        state: 'open',
        createdAt: now(),
      };
      await catalog.insert('agent_proposals', proposal);
      await postEvent(projectId, 'draft', proposal.agent, msg('put a draft on {page}', {page: newest ? 'Edit prompt' : 'Prompt Design'}), draftLink(page, newest?.id ?? null, baseVersionId));
      emitChange();
      return proposal;
    }
    return null;
  } finally {
    busyProjects.delete(projectId);
    setLive(projectId, null);
    tm().counter('tsp_agent_turns_total', {agent: entry, page: pageId, outcome});
    tm().histogram('tsp_agent_turn_duration_seconds', (Date.now() - started) / 1000, {agent: entry});
    emitChange();
  }
}

/** Metrics and events for one answered turn. Only counts and names; never the text. */
function recordTurn(out: AgentTurnOutput, entry: string, started: number) {
  const t = tm();
  for (const c of out.modelCalls) t.counter('tsp_agent_model_calls_total', {agent: c.agent, model: c.model});
  for (const f of out.parseFailures) t.counter('tsp_agent_parse_failures_total', {agent: f.agent, intent: f.intent});
  const handoff = out.invocations.find(i => i.from !== 'user' && i.from !== 'system');
  if (handoff) t.counter('tsp_agent_handoffs_total', {from: handoff.from, to: handoff.to, outcome: 'joined'});
  const last = out.invocations[out.invocations.length - 1]?.to ?? entry;
  t.histogram('tsp_agent_tool_calls_per_turn', out.toolCalls.length, {agent: last});
  for (const c of out.toolCalls) {
    t.counter('tsp_agent_tool_calls_total', {agent: c.agent, tool: c.name, outcome: c.ok ? 'ok' : 'error'});
    t.histogram('tsp_agent_tool_duration_seconds', c.ms / 1000, {tool: c.name});
    t.event('agent_tool_called', {agent: c.agent, tool: c.name, ok: c.ok, ms: c.ms});
  }
  if (out.proposal) {
    t.counter('tsp_agent_proposals_total', {agent: out.proposal.agent, kind: 'prompt', outcome: 'shown'});
    t.event('prompt_proposal_shown', {agent: out.proposal.agent, unmapped: out.proposal.payload.unmapped.length});
  }
  t.event('agent_replied', {agent: last, seconds: (Date.now() - started) / 1000, handoff_to: handoff?.to ?? null, tool_calls: out.toolCalls.length, proposal_kind: out.proposal?.kind ?? null});
}

/** Where a draft lands: Prompt Design before the first version, the editor after. */
function draftLink(page: PageContext, newestId: string | null, baseVersionId: string | null) {
  if (!newestId) return {path: '/prompt-design'};
  return {path: '/prompt/edit', params: {v: baseVersionId ?? newestId}};
}

export async function openProposals(projectId: string): Promise<AgentProposal[]> {
  return getApp().catalog.find('agent_proposals', {projectId, state: 'open'}, 'createdAt desc');
}

/** Open and approved proposals, oldest first: Ask AI shows each as a one-line card. */
export async function proposals(projectId: string): Promise<AgentProposal[]> {
  const all = await getApp().catalog.find('agent_proposals', {projectId}, 'createdAt desc');
  return all.filter(p => p.state !== 'discarded').reverse();
}

/**
 * A draft is "approved" when the page takes it in (the user's own act there is Approve or Save),
 * and "discarded" by Discard. Approval is never a card in the chat (spec 1.0.0, 6.2).
 */
export async function closeProposal(p: AgentProposal, state: 'approved' | 'discarded') {
  // Closing twice (two checks racing on the page) changes nothing and is not counted twice.
  const fresh = await getApp().catalog.get('agent_proposals', p.id);
  if (fresh && fresh.state !== 'open') return;
  await getApp().catalog.patch('agent_proposals', p.id, {state});
  if (state === 'discarded') await postEvent(p.projectId, 'discarded', 'user', msg('discarded the draft'));
  tm().counter('tsp_agent_proposals_total', {agent: p.agent, kind: 'prompt', outcome: state});
  tm().event(state === 'approved' ? 'prompt_proposal_approved' : 'prompt_proposal_discarded', state === 'approved' ? {agent: p.agent, edited_before_approve: false} : {agent: p.agent});
  emitChange();
}

/**
 * Improve with AI: the Prompt helper drafts a few changes to a version from its mistakes, each
 * with a reason. The draft goes into the editor (an open prompt proposal) with the changes
 * marked; nothing is labeled until the user saves it.
 */
export async function improveWithAi(projectId: string, versionId: string): Promise<void> {
  const {catalog, agents, gateway, labeling} = getApp();
  // The helper reads examples: the halves are fixed from here on (spec 1.0.0, 4.2).
  await lockHoldout(projectId);
  const state = await loadProjectState(projectId);
  const v = state?.versions.find(x => x.id === versionId);
  const setup = state?.setup;
  if (!state || !v || !setup?.schema) throw new Error('The version was not found.');
  const report = state.reports.find(r => r.promptVersionId === v.id && !r.archivedNow);
  if (!report) throw new Error(`${versionLabel(v)} has no scores yet.`);
  const settings = setup.models.find(m => m.endpoint === report.endpoint);
  const answers = settings ? toMap(await labeling.predictions(v.id, report.endpoint, settingsHash(settings))) : new Map();
  const schema = setup.schema;
  // R3-9 (D3) and finding 3: the mistakes, mix-ups and up to 8 wrong examples all come from the
  // optimiser half; nothing of the held-out half reaches the helper.
  const half = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e));
  const mistakes = half.filter(e => !!state.gold[e.id] && fieldsRight(schema, state.gold[e.id]!.answer, answers.get(e.id)?.answer ?? null).length < schema.fields.length).length;
  const gold = new Map(half.filter(e => !!state.gold[e.id]).map(e => [e.id, state.gold[e.id]!.answer]));
  const said = answersForHelpers(half.filter(e => answers.has(e.id)).map(e => answers.get(e.id)!));
  const examples = withComments(wrongExamples(schema, half, promptKeys(v), gold, said.predicted, undefined, said.notes), half, await labelComments(projectId, state));
  busyProjects.add(projectId);
  setLive(projectId, {agent: 'prompt_agent', working: `Reading the ${versionLabel(v)} mistakes…`, msg: msg('Reading the {version} mistakes…', {version: versionLabel(v)}), reply: null});
  await postEvent(projectId, 'start', 'user', msg('asked the Prompt helper to improve {version}', {version: versionLabel(v)}), {path: '/prompt'});
  let outcome = 'error';
  try {
    const m = await scoreOnOptimiserHalf(setup, v, report.endpoint, state.examples, state.gold);
    const out = await agents.draftImprovement({projectId, version: versionLabel(v), prompt: v.structured, mixUps: m.mixUps.slice(0, 8), lowestField: m.lowestField, lowestValue: m.lowestValue, mistakes, examples});
    for (const prev of await openProposals(projectId)) await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
    // Improve with AI rewords; the label fields and values stay as they are.
    const structured: StructuredPrompt = tidyStructured(rewordOnly(v.structured, out.prompt));
    const change = out.changes.map(c => c.text).join('; ') || 'Improved with AI';
    const proposal: AgentProposal = {
      id: newId('ap'),
      projectId,
      agent: 'prompt_agent',
      kind: 'prompt',
      payload: {structured, change, changes: out.changes, baseVersionId: v.id, unmapped: []},
      brief: `Improve ${versionLabel(v)}`,
      state: 'open',
      createdAt: now(),
    };
    await catalog.insert('agent_proposals', proposal);
    // One line: the reasons sit on the marks in the editor, so the chat does not repeat them.
    const n = out.changes.length;
    const text = n ? `I made ${n} change${n === 1 ? '' : 's'} to ${versionLabel(v)}. Hover each mark to see why.` : `I have no new change for ${versionLabel(v)}.`;
    await post(projectId, {role: 'agent', agent: 'prompt_agent', text, page: 'Edit prompt'});
    await postEvent(projectId, 'draft', 'prompt_agent', msg('put a draft on {page}', {page: 'Edit prompt'}), {path: '/prompt/edit', params: {v: v.id}});
    tm().counter('tsp_agent_proposals_total', {agent: 'prompt_agent', kind: 'prompt', outcome: 'shown'});
    tm().event('prompt_proposal_shown', {agent: 'prompt_agent', unmapped: 0});
    outcome = 'ok';
  } finally {
    busyProjects.delete(projectId);
    setLive(projectId, null);
    tm().counter('tsp_agent_turns_total', {agent: 'prompt_agent', page: 'prompt', outcome});
    emitChange();
  }
}

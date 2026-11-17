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
} from '@sprint/contracts';
import {agentName, answersForHelpers, isRight, newId, promptKeys, readStructured, rewordOnly, settingsHash, structuredEquals, tidyStructured, versionLabel, visibleToAgents, wrongExamples, toMap, msg, msgText} from '@sprint/domain';
import {loadProjectState} from './projects.ts';
import {now, type Instance, type Scope} from './app.ts';
import {joinedMsg, postEvent} from './chat-events.ts';
import {beginTurn, endTurn} from './turns.ts';
import {getPageView} from './page-views.ts';
import {scoreOnOptimiserHalf} from './evaluation.ts';
import {labelComments, withComments} from './mismatches.ts';
import {lockHoldout} from './governance.ts';

/**
 * The progress port the agent runtime is built with (spec 1.0.0, 7.1.3): each event goes to the
 * turn that asked for it, which saves its messages and moves Ask AI's live line. The handlers are
 * callbacks, so they stay with the instance that runs the turn (spec 6 moves turns to the agent
 * service, which then reports progress over the wire).
 */
export function agentProgress(inst: Instance): AgentProgressPort {
  return {publish: (_projectId, turnId, event) => inst.local.turnProgress.get(turnId)?.(event)};
}

export type {PageContext};

/** A live turn whose instance stopped is forgotten after this. */
const LIVE_TTL_MS = 10 * 60_000;
/** How long a helper that joined keeps answering on its page with no new message. */
const STAY_TTL_MS = 24 * 3600_000;

/**
 * The turn running now, per project: who works, the live line and the reply so far. Kept apart
 * from the change feed, so a streaming reply doesn't reload the page's state: it is kept in shared
 * state, and each change raises the data-free `agent_live` event, on which a client reads it again
 * (`getAgentLive`; over HTTP, polling until streaming is scheduled).
 */
async function setLive(w: Scope, projectId: string, l: AgentLive | null): Promise<void> {
  if (l) await w.shared.set(`live:${projectId}`, l, LIVE_TTL_MS);
  else await w.shared.delete(`live:${projectId}`);
  w.emitLive();
}
export async function agentLive(w: Scope, projectId: string): Promise<AgentLive | null> {
  return w.shared.get<AgentLive>(`live:${projectId}`);
}

/**
 * A helper that joined to answer keeps answering on that page: the user's next messages there go
 * straight to it, until they write from another page. Kept per project in shared state.
 */
interface Stay {
  agent: AgentPreset;
  page: string;
}
const stayKey = (projectId: string) => `stay:${projectId}`;
const pageKey = (page: PageContext) => page.where?.page ?? page.label;
/** The page's name in action lines: its label without the version or other detail. */
const pageName = (page: PageContext) => page.label.split(' · ')[0];

/** Which helper answers the next message on this page. */
export async function answeringAgent(w: Scope, projectId: string, page: PageContext): Promise<AgentPreset> {
  const s = await w.shared.get<Stay>(stayKey(projectId));
  return s && s.page === pageKey(page) ? s.agent : page.agent;
}

export async function chatHistory(w: Scope, projectId: string): Promise<ChatMessage[]> {
  return w.catalog.find('chat_messages', {projectId}, 'createdAt');
}

async function post(w: Scope, projectId: string, m: Omit<ChatMessage, 'id' | 'projectId' | 'createdAt'>): Promise<ChatMessage> {
  const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), ...m};
  await w.catalog.insert('chat_messages', msg);
  w.emitChange(projectId);
  return msg;
}

async function loadWorkspaceSnapshot(w: Scope,
  projectId: string,
  page: PageContext,
  attachments?: ChatAttachment[],
): Promise<AgentWorkspaceSnapshot> {
  const {catalog, examples} = w;
  const project = await catalog.get('projects', projectId);
  const setup = project?.setupVersionId ? await catalog.get('setup_versions', project.setupVersionId) : null;
  const history = await chatHistory(w, projectId);
  const [newest] = await catalog.find('prompt_versions', {projectId}, 'createdAt desc');

  // The prompt the user is looking at: the page's unsaved draft, else an open draft, else the newest version.
  const open = (await openProposals(w, projectId))[0];
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
  const pageView = await getPageView(w, projectId, page.where ?? {page: 'projects', params: {}}, unsaved);

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
 * The workflow's dispatcher for assistant turns:
 * 1. Persists the user's message and loads the project's workspace snapshot from the catalog.
 * 2. Calls the stateless Agent Runtime service (`@sprint/agents`) with `AgentTurnInput`, which
 *    includes the view of the page the user is on, and lends it the read tools.
 * 3. Persists start requests, emitted agent/event messages, and any new proposal to the catalog.
 */
export async function sendUserMessage(
  w: Scope,
  projectId: string,
  text: string,
  page: PageContext,
  attachments?: ChatAttachment[],
  /** A helper the user called by a button: it joins with a line and keeps answering on this page. */
  join?: boolean,
  /** The user's language and what their browser saw (spec 1.1.0): for this turn only, never saved. */
  extra: {locale?: Locale; client?: ClientDiagnostics} = {},
): Promise<AgentProposal | null> {
  const started = Date.now();
  const pageId = page.where?.page ?? 'other';
  // Live lines go out in the order they were made; `current` is the newest.
  let current: AgentLive | null = null;
  let liveWrites = Promise.resolve();
  const live = (l: AgentLive | null) => {
    current = l;
    liveWrites = liveWrites.then(() => setLive(w, projectId, l)).catch(() => undefined);
  };
  // Back from another page: the page's own helper answers again, and the chat says so.
  let stay = await w.shared.get<Stay>(stayKey(projectId));
  if (stay && stay.page !== pageKey(page)) {
    await w.shared.delete(stayKey(projectId));
    if (stay.agent !== page.agent) await postEvent(w, projectId, 'page', page.agent, msg('answers on {page}', {page: pageName(page)}));
    stay = null;
  }
  if (join && stay) {
    await w.shared.delete(stayKey(projectId));
    stay = null;
  }
  const turnPage: PageContext = stay ? {...page, agent: stay.agent, intent: 'follow_up'} : page;
  const entry = turnPage.agent;
  live({agent: entry, working: 'Thinking…', reply: null});
  let outcome = 'error';
  w.tm.event('chat_message_sent', {entry_agent: entry, chars: text.length, attachments: attachments?.length ?? 0});
  const cleanAttachments = attachments?.map(({name, size, url}) => ({name, size, ...(url ? {url} : {})}));
  await post(w, projectId, {
    role: 'user',
    agent: null,
    text,
    page: page.label,
    ...(cleanAttachments?.length ? {attachments: cleanAttachments} : {}),
  });
  if (join) await post(w, projectId, {role: 'event', agent: null, event: 'join', text: `${agentName(page.agent)} joined to answer`, msg: joinedMsg(page.agent), page: page.label});

  try {
    const {catalog, agents, gateway} = w;
    const workspace = await loadWorkspaceSnapshot(w, projectId, turnPage, attachments);
    // Messages are saved the moment they are final; the live line and the streamed reply show
    // what the turn is doing until then.
    let saving = Promise.resolve();
    const progress: AgentTurnProgress = p => {
      if ('message' in p) {
        const msg = p.message;
        saving = saving.then(() =>
          post(w, projectId, {role: msg.role, agent: msg.agent, text: msg.text, page: page.label, ...(msg.event ? {event: msg.event} : {}), ...(msg.msg ? {msg: msg.msg} : {}), ...(msg.choices ? {choices: msg.choices} : {})}).then(() => undefined),
        );
        live(msg.role === 'agent' ? null : {agent: current?.agent ?? entry, working: 'Thinking…', reply: null});
      } else if ('working' in p) live({agent: p.agent, working: p.working, msg: p.msg ?? null, reply: null});
      else live({agent: p.agent, working: null, reply: p.reply});
    };
    const turnId = newId('turn');
    w.local.turnProgress.set(turnId, progress);
    const locale = extra.locale ?? 'en';
    await beginTurn(w, projectId, {page: turnPage, locale, client: extra.client ?? null});
    const turnOut = await agents.runTurn({userText: text, page: turnPage, attachments, workspace, turnId, locale}).finally(async () => {
      w.local.turnProgress.delete(turnId);
      await endTurn(w, projectId);
    });
    await saving;
    outcome = 'ok';
    recordTurn(w, turnOut, entry, started);
    const joined = turnOut.invocations.filter(i => i.from !== 'user').at(-1);
    if (joined || join) await w.shared.set<Stay>(stayKey(projectId), {agent: joined ? joined.to : page.agent, page: pageKey(page)}, STAY_TTL_MS);

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
      for (const prev of await openProposals(w, projectId)) await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
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
      await postEvent(w, projectId, 'draft', proposal.agent, msg('put a draft on {page}', {page: newest ? 'Edit prompt' : 'Prompt Design'}), draftLink(page, newest?.id ?? null, baseVersionId));
      w.emitChange(projectId);
      return proposal;
    }
    return null;
  } finally {
    live(null);
    await liveWrites;
    w.tm.counter('sprint_agent_turns_total', {agent: entry, page: pageId, outcome});
    w.tm.histogram('sprint_agent_turn_duration_seconds', (Date.now() - started) / 1000, {agent: entry});
    w.emitChange(projectId);
  }
}

/** Metrics and events for one answered turn. Only counts and names; never the text. */
function recordTurn(w: Scope, out: AgentTurnOutput, entry: string, started: number) {
  const t = w.tm;
  for (const c of out.modelCalls) t.counter('sprint_agent_model_calls_total', {agent: c.agent, model: c.model});
  for (const f of out.parseFailures) t.counter('sprint_agent_parse_failures_total', {agent: f.agent, intent: f.intent});
  const handoff = out.invocations.find(i => i.from !== 'user' && i.from !== 'system');
  if (handoff) t.counter('sprint_agent_handoffs_total', {from: handoff.from, to: handoff.to, outcome: 'joined'});
  const last = out.invocations[out.invocations.length - 1]?.to ?? entry;
  t.histogram('sprint_agent_tool_calls_per_turn', out.toolCalls.length, {agent: last});
  for (const c of out.toolCalls) {
    t.counter('sprint_agent_tool_calls_total', {agent: c.agent, tool: c.name, outcome: c.ok ? 'ok' : 'error'});
    t.histogram('sprint_agent_tool_duration_seconds', c.ms / 1000, {tool: c.name});
    t.event('agent_tool_called', {agent: c.agent, tool: c.name, ok: c.ok, ms: c.ms});
  }
  if (out.proposal) {
    t.counter('sprint_agent_proposals_total', {agent: out.proposal.agent, kind: 'prompt', outcome: 'shown'});
    t.event('prompt_proposal_shown', {agent: out.proposal.agent, unmapped: out.proposal.payload.unmapped.length});
  }
  t.event('agent_replied', {agent: last, seconds: (Date.now() - started) / 1000, handoff_to: handoff?.to ?? null, tool_calls: out.toolCalls.length, proposal_kind: out.proposal?.kind ?? null});
}

/** Where a draft lands: Prompt Design before the first version, the editor after. */
function draftLink(page: PageContext, newestId: string | null, baseVersionId: string | null) {
  if (!newestId) return {path: '/prompt-design'};
  return {path: '/prompt/edit', params: {v: baseVersionId ?? newestId}};
}

export async function openProposals(w: Scope, projectId: string): Promise<AgentProposal[]> {
  return w.catalog.find('agent_proposals', {projectId, state: 'open'}, 'createdAt desc');
}

/** Open and approved proposals, oldest first: Ask AI shows each as a one-line card. */
export async function proposals(w: Scope, projectId: string): Promise<AgentProposal[]> {
  const all = await w.catalog.find('agent_proposals', {projectId}, 'createdAt desc');
  return all.filter(p => p.state !== 'discarded').reverse();
}

/**
 * A draft is "approved" when the page takes it in (the user's own act there is Approve or Save),
 * and "discarded" by Discard. Approval is never a card in the chat (spec 1.0.0, 6.2).
 */
export async function closeProposal(w: Scope, p: AgentProposal, state: 'approved' | 'discarded') {
  // Closing twice (two checks racing on the page) changes nothing and is not counted twice.
  const fresh = await w.catalog.get('agent_proposals', p.id);
  if (fresh && fresh.state !== 'open') return;
  await w.catalog.patch('agent_proposals', p.id, {state});
  if (state === 'discarded') await postEvent(w, p.projectId, 'discarded', 'user', msg('discarded the draft'));
  w.tm.counter('sprint_agent_proposals_total', {agent: p.agent, kind: 'prompt', outcome: state});
  w.tm.event(state === 'approved' ? 'prompt_proposal_approved' : 'prompt_proposal_discarded', state === 'approved' ? {agent: p.agent, edited_before_approve: false} : {agent: p.agent});
  w.emitChange(p.projectId);
}

/**
 * Improve with AI: the Prompt helper drafts a few changes to a version from its mistakes, each
 * with a reason. The draft goes into the editor (an open prompt proposal) with the changes
 * marked; nothing is labeled until the user saves it.
 */
export async function improveWithAi(w: Scope, projectId: string, versionId: string, locale?: Locale): Promise<void> {
  const {catalog, agents, gateway, labeling} = w;
  // The helper reads examples: the halves are fixed from here on (spec 1.0.0, 4.2).
  await lockHoldout(w, projectId);
  const state = await loadProjectState(w, projectId);
  const v = state?.versions.find(x => x.id === versionId);
  const setup = state?.setup;
  if (!state || !v || !setup?.schema) throw new Error('The version was not found.');
  const report = state.reports.find(r => r.promptVersionId === v.id && !r.archivedNow);
  if (!report) throw new Error(`${versionLabel(v)} has no scores yet.`);
  const settings = setup.models.find(m => m.endpoint === report.endpoint);
  const answers = settings ? toMap(await labeling.predictions(v.id, report.endpoint, settingsHash(settings))) : new Map();
  // R3-9 (D3) and finding 3: the mistakes, mix-ups and up to 8 wrong examples all come from the
  // optimiser half; nothing of the held-out half reaches the helper.
  const half = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e));
  const mistakes = half.filter(e => !!state.gold[e.id] && !isRight(state.gold[e.id]!.answer, answers.get(e.id)?.answer ?? null)).length;
  const gold = new Map(half.filter(e => !!state.gold[e.id]).map(e => [e.id, state.gold[e.id]!.answer]));
  const said = answersForHelpers(half.filter(e => answers.has(e.id)).map(e => answers.get(e.id)!));
  const examples = withComments(wrongExamples(half, promptKeys(v), gold, said.predicted, undefined, said.notes), half, await labelComments(w, projectId, state));
  await setLive(w, projectId, {agent: 'prompt_agent', working: `Reading the ${versionLabel(v)} mistakes…`, msg: msg('Reading the {version} mistakes…', {version: versionLabel(v)}), reply: null});
  await postEvent(w, projectId, 'start', 'user', msg('asked the Prompt helper to improve {version}', {version: versionLabel(v)}), {path: '/prompt'});
  let outcome = 'error';
  try {
    const m = await scoreOnOptimiserHalf(w, setup, v, report.endpoint, state.examples, state.gold);
    const out = await agents.draftImprovement({projectId, version: versionLabel(v), prompt: v.structured, mixUps: m.mixUps.slice(0, 8), macroF1: m.macroF1, lowestValue: m.lowestValue, mistakes, examples, ...(locale ? {locale} : {})});
    for (const prev of await openProposals(w, projectId)) await catalog.patch('agent_proposals', prev.id, {state: 'discarded'});
    // Improve with AI rewords; the label's key and values stay as they are.
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
    // With its catalog key, so the line reads in the user's language (resilience spec, 8).
    const version = versionLabel(v);
    const line = n === 1 ? msg('I made 1 change to {version}. Hover each mark to see why.', {version}) : n ? msg('I made {n} changes to {version}. Hover each mark to see why.', {n, version}) : msg('I have no new change for {version}.', {version});
    await post(w, projectId, {role: 'agent', agent: 'prompt_agent', text: msgText(line), msg: line, page: 'Edit prompt'});
    await postEvent(w, projectId, 'draft', 'prompt_agent', msg('put a draft on {page}', {page: 'Edit prompt'}), {path: '/prompt/edit', params: {v: v.id}});
    w.tm.counter('sprint_agent_proposals_total', {agent: 'prompt_agent', kind: 'prompt', outcome: 'shown'});
    w.tm.event('prompt_proposal_shown', {agent: 'prompt_agent', unmapped: 0});
    outcome = 'ok';
  } finally {
    await setLive(w, projectId, null);
    w.tm.counter('sprint_agent_turns_total', {agent: 'prompt_agent', page: 'prompt', outcome});
    w.emitChange(projectId);
  }
}

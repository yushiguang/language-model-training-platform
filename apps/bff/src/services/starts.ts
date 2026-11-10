import type {AgentPreset, ChatMessage, EndpointId, ProjectState, StartCard} from '@tsp/contracts';
import {autoSpendUsd, autoStartCheck, evalEstimate, newId, optimiserEstimate, TRY_TEMPLATE_MAX, versionLabel} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {asModel, findVersion} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {reserve, reservedUsd, scoreVersion, startOptimiser} from './work.ts';

/**
 * Start-work agent tools: try_template, score_version, start_optimiser. They spend money, so
 * they run at once only when `autoStartCheck` allows an automatic start (Setup's switch is on and
 * no fixed cap applies). Otherwise the tool returns `{asked_user: true}`, the bff posts a card
 * with Approve and Cancel in the chat, and the agent's turn ends. On Approve the bff runs it as a
 * user start and posts the result in the chat, so the agent reads it in the next turn.
 */

type StartTool = StartCard['tool'];
export const START_TOOLS: StartTool[] = ['try_template', 'score_version', 'start_optimiser'];
export const isStartTool = (name: string): name is StartTool => (START_TOOLS as string[]).includes(name);

interface Planned {
  label: string;
  estimateUsd: number;
  run: () => Promise<unknown>;
}

const money = (x: number) => `$${x.toFixed(2)}`;

/** Checks the arguments and works out the label and cost of a start, without starting it. */
function plan(state: ProjectState, tool: StartTool, args: Record<string, unknown>, auto: boolean): Planned {
  const projectId = state.project.id;
  const models = state.setup?.models ?? [];
  const pickModel = (): EndpointId => {
    const m = asModel(args.model) ?? models[0]?.endpoint;
    if (!m || !models.some(x => x.endpoint === m)) throw new Error(`Model ${String(args.model)} is not chosen in Setup. Chosen: ${models.map(x => x.endpoint).join(', ')}.`);
    return m;
  };
  switch (tool) {
    case 'try_template': {
      const template = typeof args.template === 'string' ? args.template : '';
      if (!template.trim()) throw new Error('Give the template to try.');
      if (!state.setup?.schema) throw new Error('The labels are not set up yet.');
      const endpoint = pickModel();
      const base = state.versions[0];
      const draft = {template, features: (args.features as typeof base.features | undefined) ?? base?.features ?? {video: [], photo_text: [], metadata: []}, images: base?.images ?? []};
      const n = Math.max(1, Math.min(TRY_TEMPLATE_MAX, typeof args.n === 'number' ? Math.floor(args.n) : 3));
      const examples = state.examples.filter(e => e.split === 'eval').slice(0, n);
      if (!examples.length) throw new Error('There are no eval examples to try it on.');
      return {
        label: `Try the draft on ${examples.length} eval example${examples.length === 1 ? '' : 's'} with Model ${endpoint}`,
        estimateUsd: evalEstimate(state, draft, endpoint, examples.length),
        run: async () => {
          const settings = models.find(m => m.endpoint === endpoint)!;
          const trying = getApp().labeling.tryTemplate({...draft, schema: state.setup!.schema!, settings, examples});
          if (auto) reserve(`try:${newId('rs')}`, evalEstimate(state, draft, endpoint, examples.length), trying);
          const rows = await trying;
          const byId = new Map(examples.map(e => [e.id, e]));
          const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
          // No task is saved, so an automatic try's spend is recorded here for the $5 cap.
          if (auto && costUsd > 0) await getApp().catalog.audit(projectId, 'system', 'auto_spend', {what: 'try_template', costUsd});
          return {
            model: endpoint,
            rows: rows.map(r => ({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, model: r.answer, invalid: r.invalidReason, error: r.error, gold: state.gold.get(r.exampleId)?.answer ?? null})),
            costUsd,
            saved: false,
          };
        },
      };
    }
    case 'score_version': {
      const v = findVersion(state, args.version);
      if (!v) throw new Error(`There is no version "${String(args.version)}". Versions: ${state.versions.map(versionLabel).join(', ')}.`);
      const endpoint = pickModel();
      if (state.runs.some(r => r.promptVersionId === v.id && r.endpoint === endpoint && (r.state === 'done' || r.state === 'running'))) {
        return {label: `Score ${versionLabel(v)} on Model ${endpoint}`, estimateUsd: 0, run: async () => ({already: `${versionLabel(v)} is already scored or being scored on Model ${endpoint}.`})};
      }
      return {
        label: `Score ${versionLabel(v)} on Model ${endpoint}`,
        estimateUsd: evalEstimate(state, v, endpoint),
        run: async () => {
          const scoring = scoreVersion(projectId, v, endpoint, {auto});
          if (auto) reserve(`score:${newId('rs')}`, evalEstimate(state, v, endpoint), scoring);
          return {started: true, note: 'Scoring runs on the eval set; the report appears when it finishes.'};
        },
      };
    }
    case 'start_optimiser': {
      const endpoint = pickModel();
      if (state.optimisation.some(o => o.state === 'running')) return {label: `Run the optimiser on Model ${endpoint}`, estimateUsd: 0, run: async () => ({already: 'An optimiser run is already going.'})};
      return {
        label: `Run the optimiser on Model ${endpoint}`,
        estimateUsd: optimiserEstimate(state, endpoint),
        run: async () => {
          const running = startOptimiser(projectId, endpoint, {auto});
          if (auto) reserve(`optimiser:${newId('rs')}`, optimiserEstimate(state, endpoint), running);
          return {started: true, note: 'The optimiser tries up to 6 changes; new versions appear on Prompt Engineering.'};
        },
      };
    }
  }
}

/**
 * Called by the agent tool host. Runs the start when an automatic start is allowed; otherwise
 * adds a card to `cards` (posted after the agent's reply) and tells the agent it asked.
 */
export async function agentStart(projectId: string, agent: AgentPreset, tool: StartTool, args: Record<string, unknown>, cards: StartCard[]): Promise<unknown> {
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('The project was not found.');
  const p = plan(state, tool, args, true);
  const check = autoStartCheck(state, p.estimateUsd, reservedUsd());
  if (check.allowed || p.estimateUsd === 0) {
    const spent = autoSpendUsd(state);
    const result = await p.run();
    if (p.estimateUsd > 0) {
      await getApp().catalog.audit(projectId, `agent:${agent}`, 'auto_start', {what: tool, args, estimateUsd: p.estimateUsd, autoSpendUsd: spent});
      tm().counter('tsp_auto_starts_total', {what: tool, decision: 'started'});
      tm().event('auto_started', {what: tool, estimate_usd: p.estimateUsd, project_auto_spend_usd: spent});
    }
    return result;
  }
  if (cards.length) return {error: 'You already asked the user to approve one start in this turn.'};
  cards.push({tool, agent, label: p.label, estimateUsd: p.estimateUsd, args, reason: check.reason as StartCard['reason'], state: 'open'});
  tm().counter('tsp_cost_confirms_total', {what: tool, outcome: 'shown'});
  tm().event('start_card_shown', {tool, estimate_usd: p.estimateUsd});
  return {asked_user: true, label: p.label, estimate_usd: Number(p.estimateUsd.toFixed(2))};
}

/** Why a card asks, in the user's words. */
export function cardReason(c: StartCard): string {
  if (c.reason === 'off') return 'Automatic paid starts are off in Setup.';
  if (c.reason === 'over_single_cap') return 'Starts above $1 always ask.';
  if (c.reason === 'over_project_cap') return 'This would take automatic starts in this project past $5, so it asks.';
  return 'This asks before it starts.';
}

/** Cards being answered in this page, so a double click runs the start once. */
const answering = new Set<string>();

/**
 * Approve or Cancel on a start card. Approve works out the start again from fresh state (its
 * cost may have changed), runs it as the user's start and posts the result. When it can't be
 * worked out, the card stays open with the reason posted, so it can be approved again later.
 */
export async function answerStartCard(projectId: string, messageId: string, approve: boolean): Promise<void> {
  if (answering.has(messageId)) return;
  answering.add(messageId);
  try {
    await answer(projectId, messageId, approve);
  } finally {
    answering.delete(messageId);
  }
}

async function answer(projectId: string, messageId: string, approve: boolean): Promise<void> {
  const {catalog, user} = getApp();
  const msg = await catalog.get('chat_messages', messageId);
  const card = msg?.startCard;
  if (!msg || !card || card.state !== 'open') return;
  const u = await user();
  // Short outcomes are an event line; try_template's answers come back as the agent's message.
  const post = async (text: string, asAgent = false) => {
    const m: ChatMessage = {id: newId('cm'), projectId, role: asAgent ? 'agent' : 'event', agent: asAgent ? card.agent : null, text, page: msg.page, createdAt: now()};
    await catalog.insert('chat_messages', m);
  };
  if (!approve) {
    await catalog.patch('chat_messages', messageId, {startCard: {...card, state: 'cancelled'}});
    tm().counter('tsp_cost_confirms_total', {what: card.tool, outcome: 'cancelled'});
    tm().event('start_card_cancelled', {tool: card.tool, estimate_usd: card.estimateUsd});
    await catalog.audit(projectId, u.name, 'start_card.cancel', {what: card.tool});
    await post(`You cancelled: ${card.label}.`);
    emitChange();
    return;
  }
  let p: Planned;
  try {
    const state = await loadProjectState(projectId);
    if (!state) throw new Error('The project was not found.');
    p = plan(state, card.tool, card.args, false);
  } catch (e) {
    await post(`Couldn't start: ${(e as Error).message}`);
    emitChange();
    return;
  }
  const approved: StartCard = {...card, state: 'approved', estimateUsd: p.estimateUsd};
  await catalog.patch('chat_messages', messageId, {startCard: approved});
  tm().counter('tsp_cost_confirms_total', {what: card.tool, outcome: 'accepted'});
  tm().event('start_card_accepted', {tool: card.tool, estimate_usd: p.estimateUsd});
  await catalog.audit(projectId, u.name, 'start_card.approve', {what: card.tool, estimateUsd: p.estimateUsd, shownUsd: card.estimateUsd});
  try {
    const result = (await p.run()) as Record<string, unknown>;
    await post(resultText(approved, result), card.tool === 'try_template' && typeof result.already !== 'string');
  } catch (e) {
    await post(`Couldn't start: ${(e as Error).message}`);
  }
  emitChange();
}

function resultText(card: StartCard, r: Record<string, unknown>): string {
  if (typeof r.already === 'string') return r.already;
  if (card.tool !== 'try_template') return `Started: ${card.label} (about ${money(card.estimateUsd)}).`;
  const rows = (r.rows as {title?: string; model: Record<string, string[]> | null; gold: Record<string, string[]> | null; error: string | null}[]) ?? [];
  const same = (a: Record<string, string[]> | null, b: Record<string, string[]> | null) => !!a && !!b && Object.keys(b).every(k => JSON.stringify([...(a[k] ?? [])].sort()) === JSON.stringify([...(b[k] ?? [])].sort()));
  const withGold = rows.filter(x => x.gold && x.model);
  const lines = rows.map(x => `${x.title ?? 'Example'}: ${x.error ? 'failed' : x.model ? Object.entries(x.model).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ') : 'not valid JSON'}${x.gold ? (same(x.model, x.gold) ? ' (matches gold)' : ' (differs from gold)') : ''}`);
  return `Tried the draft on ${rows.length} eval examples, ${money(Number(r.costUsd ?? 0))}, nothing saved${withGold.length ? `; ${withGold.filter(x => same(x.model, x.gold)).length} of ${withGold.length} match the gold labels` : ''}.\n${lines.join('\n')}`;
}

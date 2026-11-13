import type {AgentToolCall, AgentToolHost, EndpointId, Example, PageId, PageLocation, PageView, ProjectState, PromptVersion} from '@tsp/contracts';
import {agentStart, isStartTool} from './starts.ts';
import {aiSuggestion, checkStructured, compilePrompt, dryRunSize, optimiserVersions, pageFromPath, isImageKey, judge, MADE_BY, readStructured, settingsHash, stepLine, versionLabel, visibleToAgents, HIDDEN_NOTE, systemConfig, toMap} from '@tsp/domain';
import {getApp} from './app.ts';
import {mismatches} from './mismatches.ts';
import {loadProjectState} from './projects.ts';

/**
 * Page views: each page as the agent sees it, built from the same saved data the page shows.
 * The page is the agent's workspace (like a repo for a coding agent): the view of the page the
 * user is on goes with every message, and the read tools below open any other part of it.
 * Nothing here reads the DOM, and nothing here changes data.
 */

const TITLES: Record<PageId, string> = {
  projects: 'Projects',
  prompt_design: 'Prompt Design',
  dataset: 'Eval Dataset',
  gold: 'Gold Labels',
  prompt: 'Prompt Tuning · prompt versions',
  prompt_edit: 'Prompt editor',
};

/** Two decimals, the same way the pages print them (toFixed), so the agent quotes what people see. */
const r2 = (x: number) => Number(x.toFixed(2));

export function findVersion(state: ProjectState, ref: unknown): PromptVersion | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  const label = ref.trim().toLowerCase().replace(/^version\s+/, '');
  return state.versions.find(v => v.id === ref || versionLabel(v) === label || versionLabel(v) === `v${label}`);
}

/** A model named the way the pages name it ("gpt-5.4"), or by its slot ("A"); undefined if neither. */
export function asModel(m: unknown, state?: ProjectState): EndpointId | undefined {
  if (m === 'A' || m === 'B') return m;
  if (typeof m !== 'string' || !state) return undefined;
  return state.endpoints.find(e => e.name.toLowerCase() === m.trim().toLowerCase())?.id;
}

/** The model's name as the pages show it. */
export const modelName = (state: ProjectState, id: EndpointId): string => state.endpoints.find(e => e.id === id)?.name ?? id;

function scoresOf(state: ProjectState, v: PromptVersion) {
  return (state.setup?.models ?? []).map(m => {
    const r = state.reports.find(x => x.promptVersionId === v.id && x.endpoint === m.endpoint && !x.archivedNow);
    const run = state.runs.find(x => x.promptVersionId === v.id && x.endpoint === m.endpoint);
    return {
      model: modelName(state, m.endpoint),
      lowestFieldMacroF1: r ? r2(r.metrics.lowestField.macroF1) : null,
      passed: r ? r.passed : null,
      labeling: !r && run ? `${run.state}, ${run.done} of ${run.total}` : undefined,
    };
  });
}

function versionRow(state: ProjectState, v: PromptVersion) {
  const o = optimiserVersions(state.optimisation).get(v.id);
  const dry = o?.round.dryRun;
  const parent = dry ? state.versions.find(x => x.id === dry.parentId) : undefined;
  return {
    id: v.id,
    label: versionLabel(v),
    madeBy: MADE_BY[v.madeBy] ?? v.madeBy,
    change: v.change || null,
    createdAt: v.createdAt,
    scores: scoresOf(state, v),
    ...(o?.round.outcome === 'dropped' ? {dropped: 'Dropped after dry run: not scored on the eval set'} : {}),
    ...(dry ? {dryRun: `${versionLabel(v)} passed ${dry.passed} / ${dry.examples}, ${parent ? versionLabel(parent) : 'its parent'} passed ${dry.parentPassed} / ${dry.examples}`} : {}),
  };
}

/** The Optimiser run as the progress panel shows it (no cost or time, as on the page). */
function optimiserView(state: ProjectState) {
  const o = state.optimisation[0];
  if (!o) return null;
  const label = (id: string | null) => (id ? (state.versions.find(v => v.id === id) ? versionLabel(state.versions.find(v => v.id === id)!) : null) : null);
  return {
    model: modelName(state, o.endpoint),
    state: o.state,
    round: o.round,
    maxRounds: o.maxRounds,
    startedFrom: label(o.startVersionId),
    now: o.state === 'running' ? stepLine(o.step, label(o.stepVersionId), dryRunSize(state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && !!state.gold[e.id]).length)) : null,
    stopReason: o.stopReason,
    error: o.error,
    rounds: o.history.map(r => ({round: r.round, version: label(r.versionId), from: label(r.parentId), kind: r.kind, change: r.change, outcome: r.outcome, lowestFieldMacroF1: r.score == null ? null : r2(r.score), passed: r.passed, confirmed: r.confirm ? r.confirm.passed : null})),
  };
}

function versionDetail(state: ProjectState, v: PromptVersion) {
  return {...versionRow(state, v), prompt: v.structured, fullPrompt: v.template, promptImages: v.images.length};
}

/**
 * Whether the Optimiser's second labeling of the held-out half agreed with a version's pass:
 * true or false, or null when there was no second labeling (a version scored outside a run, or
 * one that did not pass).
 */
function confirmedOf(state: ProjectState, versionId: string): boolean | null {
  for (const o of state.optimisation) {
    const c = o.history.find(h => h.versionId === versionId)?.confirm;
    if (c) return c.passed;
  }
  return null;
}

/** A report as the Eval report page shows it: scores, the threshold checks, mix-ups, trend. */
function reportView(state: ProjectState, v: PromptVersion | undefined, model: EndpointId | undefined) {
  const current = state.reports.filter(r => !r.archivedNow && (!model || r.endpoint === model));
  const r = v ? current.find(x => x.promptVersionId === v.id) : current[0];
  if (!r) return {report: null, why: v ? `${versionLabel(v)} has no report${model ? ` on ${modelName(state, model)}` : ''} yet.` : 'No version has a report yet.'};
  const ver = state.versions.find(x => x.id === r.promptVersionId)!;
  const t = state.setup?.thresholds;
  const nEval = state.examples.filter(e => e.split === 'eval').length;
  const trend = state.reports
    .filter(x => x.endpoint === r.endpoint && !x.archivedNow)
    .map(x => ({version: versionLabel(state.versions.find(v2 => v2.id === x.promptVersionId)!), lowestFieldMacroF1: r2(x.metrics.lowestField.macroF1), passed: x.passed}))
    .reverse();
  return {
    report: {
      version: versionLabel(ver),
      versionId: ver.id,
      model: modelName(state, r.endpoint),
      // R4-6: invalid and filtered answers are left out of the score; scoredOn counts what is left.
      scoredOn: r.metrics.n,
      examples: r.metrics.total ?? r.metrics.n,
      invalid: r.metrics.invalid,
      filtered: r.metrics.filtered ?? 0,
      passed: r.passed,
      confirmed: confirmedOf(state, ver.id),
      fields: r.metrics.fields.map(f => ({field: f.field, kind: f.kind, macroF1: r2(f.macroF1), accuracy: r2(f.accuracy), weakestValues: [...f.values].sort((a, b) => a.f1 - b.f1).slice(0, 3).map(x => ({value: x.value, f1: r2(x.f1)}))})),
      lowestField: {field: r.metrics.lowestField.field, macroF1: r2(r.metrics.lowestField.macroF1)},
      lowestValue: r.metrics.lowestValue ? {...r.metrics.lowestValue, f1: r2(r.metrics.lowestValue.f1)} : null,
      invalidRate: r2(r.metrics.invalidRate),
      checks: t ? judge(r.metrics, t, nEval).checks : null,
      // Scored on the held-out half, so mix-ups go as counts only: no example ids (finding 3).
      topMixUps: r.metrics.mixUps.slice(0, 5).map(m => ({field: m.field, kind: m.kind, gold: m.gold, predicted: m.predicted, count: m.count})),
    },
    thresholds: t,
    trend,
  };
}

function exampleView(e: Example) {
  const features: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(e.features)) {
    if (isImageKey(k)) features[k] = `${Array.isArray(v) ? v.length : v ? 1 : 0} image(s)`;
    else {
      const s = Array.isArray(v) ? v.join(', ') : v;
      features[k] = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    }
  }
  return {id: e.externalId, type: e.type, title: e.title, features};
}

function adviceOf(state: ProjectState) {
  const a = aiSuggestion(state);
  return a ? {nextStep: a.title, reason: a.text} : null;
}

function build(state: ProjectState, loc: PageLocation, unsaved: Record<string, unknown>): PageView {
  const {page, params} = loc;
  const s = state.setup;
  const total = state.examples.length;
  const settings = {thresholds: s?.thresholds ?? null, model: s?.models[0] ? modelName(state, s.models[0].endpoint) : null, confirmed: state.facts.settingsConfirmed};
  const base = (summary: string, data: Record<string, unknown>): PageView => ({page, title: TITLES[page], summary, data: {...data, ...(Object.keys(unsaved).length ? {unsaved} : {})}});

  switch (page) {
    case 'prompt_design': {
      const v = state.versions[0];
      return base(v ? 'Prompt Design: the prompt was approved as v1. Later changes are made on Prompt Tuning.' : 'Prompt Design: the first prompt is being written. The user approves it as v1 with the Approve button at the top right.', {
        approved: !!v,
        prompt: v ? v.structured : null,
        settings,
      });
    }
    case 'dataset': {
      const snap = state.snapshot;
      return base(snap ? `Eval dataset ${snap.number} from ${snap.sourceName}: ${snap.counts.valid} valid examples (${snap.counts.video} video, ${snap.counts.photoText} photo&text). All of them are used for evaluation.` : 'No eval dataset yet.', {
        snapshot: snap ? {number: snap.number, source: snap.source, name: snap.sourceName, counts: snap.counts} : null,
        sampling: state.samplingTask ? {state: state.samplingTask.state, done: state.samplingTask.fetched, total: state.samplingTask.total} : null,
      });
    }
    case 'gold': {
      return base(`Gold labels: ${state.facts.goldEvalDone} of ${total} examples labeled. Scores are worked out on the labeled examples.`, {
        labeled: state.facts.goldEvalDone,
        total,
        needRecheckAfterLabelChange: Object.keys(state.staleGold).length,
        note: 'Model answers stay hidden while people label, so as not to sway them. Do not reveal them unless asked.',
      });
    }
    case 'prompt': {
      return base(`${state.versions.length} prompt version(s); the newest is ${state.versions[0] ? versionLabel(state.versions[0]) : 'none'}.`, {
        versions: state.versions.slice(0, 12).map(v => versionRow(state, v)),
        moreVersions: Math.max(0, state.versions.length - 12),
        optimiser: optimiserView(state),
        advice: adviceOf(state),
        settings,
      });
    }
    case 'prompt_edit': {
      const v = findVersion(state, params.v) ?? state.versions[0];
      return base(v ? `Editing ${versionLabel(v)}. Saving makes a new version, which is scored right away.` : 'Writing the first prompt version.', {version: v ? versionDetail(state, v) : null});
    }
    default:
      return base(`Project ${state.project.name}.`, {steps: state.facts.approved});
  }
}

export {pageFromPath};

export async function getPageView(projectId: string, loc: PageLocation, unsaved: Record<string, unknown> = {}): Promise<PageView> {
  const state = await loadProjectState(projectId);
  if (!state) return {page: loc.page, title: TITLES[loc.page], summary: 'The project was not found.', data: {}};
  const view = build(state, loc, unsaved);
  // Review finding 2: where the model disagrees with gold labels. Counts only; say which side is
  // right never (the user decides on Gold Labels' Mismatches tab).
  if (loc.page === 'gold' || loc.page === 'prompt') {
    const m = await mismatches(projectId);
    if (m.versionId)
      view.data.mismatches = {
        comparedWith: m.versions.find(v => v.id === m.versionId)?.label,
        count: m.items.length,
        wrongInEveryVersion: m.wrongEverywhere,
        reviewedSoFar: m.reviewed,
        note: 'Gold Labels has a Mismatches tab for these. Give counts only, never which side is right.',
      };
  }
  return view;
}

const limitOf = (x: unknown, max: number, dflt: number) => Math.max(1, Math.min(max, typeof x === 'number' ? Math.floor(x) : dflt));

/**
 * The read tools, run as the signed-in user. Each call is written to the audit log. Errors come
 * back to the agent as messages it can act on.
 */
export function agentTools(projectId: string): AgentToolHost {
  return {
    async call({agent, name, args}: AgentToolCall): Promise<unknown> {
      const {catalog, labeling} = getApp();
      await catalog.audit(projectId, `agent:${agent}`, 'agent.tool', {name, args});
      // Start-work tools spend money and start at once; they live in starts.ts.
      if (isStartTool(name)) return agentStart(projectId, agent, name, args);
      const state = await loadProjectState(projectId);
      if (!state) throw new Error('The project was not found.');
      switch (name) {
        case 'get_page_view': {
          const page = (typeof args.page === 'string' && args.page in TITLES ? args.page : 'projects') as PageId;
          const params: Record<string, string> = {};
          for (const k of ['v', 'm']) if (typeof args[k] === 'string') params[k] = args[k] as string;
          if (params.v) params.v = findVersion(state, params.v)?.id ?? params.v;
          if (params.m) params.m = asModel(params.m, state) ?? params.m;
          return build(state, {page, params}, {});
        }
        case 'list_versions':
          return state.versions.map(v => versionRow(state, v));
        case 'get_version': {
          const v = findVersion(state, args.version);
          if (!v) throw new Error(`There is no version "${String(args.version)}". Versions: ${state.versions.map(versionLabel).join(', ')}.`);
          return versionDetail(state, v);
        }
        case 'get_report':
          return reportView(state, findVersion(state, args.version), asModel(args.model, state));
        case 'get_examples': {
          const ids = Array.isArray(args.ids) ? new Set(args.ids.map(String)) : null;
          const all = state.examples.filter(e => !ids || ids.has(e.externalId) || ids.has(e.id));
          const list = all.filter(visibleToAgents);
          return {total: list.length, examples: list.slice(0, limitOf(args.limit, 10, 5)).map(exampleView), ...(list.length < all.length ? {note: HIDDEN_NOTE} : {})};
        }
        case 'get_gold_labels': {
          const list = state.examples.filter(e => !!state.gold[e.id] && visibleToAgents(e));
          return {labeled: list.length, note: HIDDEN_NOTE, labels: list.slice(0, limitOf(args.limit, 20, 10)).map(e => ({id: e.externalId, title: e.title, answer: state.gold[e.id]!.answer}))};
        }
        case 'get_predictions': {
          const v = findVersion(state, args.version);
          const m = asModel(args.model, state) ?? state.setup?.models[0]?.endpoint;
          const settings = state.setup?.models.find(x => x.endpoint === m);
          if (!v || !settings) throw new Error('Name a version and one of the chosen models.');
          const preds = toMap(await labeling.predictions(v.id, settings.endpoint, settingsHash(settings)));
          const same = (a?: string[], b?: string[]) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
          const rows = state.examples
            .filter(e => e.split === 'eval' && visibleToAgents(e) && preds.has(e.id))
            .map(e => ({e, p: preds.get(e.id)!, g: state.gold[e.id]?.answer ?? null}))
            .filter(({p, g}) => !args.mixedUpOnly || !p.answer || (g && state.setup!.schema!.fields.some(f => !same(g[f.name], p.answer![f.name]))));
          return {version: versionLabel(v), model: modelName(state, settings.endpoint), note: HIDDEN_NOTE, rows: rows.slice(0, limitOf(args.limit, 20, 10)).map(({e, p, g}) => ({id: e.externalId, title: e.title, model: p.answer, ...(p.reason ? {reason: p.reason} : {}), invalid: p.invalidReason, gold: g})), matching: rows.length};
        }
        case 'check_prompt': {
          const prompt = readStructured(args.prompt, state.versions[0]?.structured);
          if (!prompt) throw new Error('Give the structured prompt to check.');
          return {errors: checkStructured(prompt).map(i => i.message), fullPrompt: compilePrompt(prompt)};
        }
        case 'read_feature_info': {
          const keys = Array.isArray(args.keys) ? args.keys.map(String).slice(0, 30) : [];
          const info = (await getApp().featureInfo?.describe(keys)) ?? {};
          return Object.fromEntries(keys.map(k => [k, info[k] ?? {description: 'No description yet.'}]));
        }
        case 'read_doc': {
          const url = typeof args.url === 'string' ? args.url.trim() : '';
          if (!/^https?:\/\//.test(url)) throw new Error('Give the link to read.');
          const doc = await getApp().documents?.read(url);
          if (!doc) return {error: 'This link cannot be opened here. Ask the user to paste the text.'};
          const MAX = systemConfig().agent.maxDocChars;
          return {title: doc.title, text: doc.text.length > MAX ? `${doc.text.slice(0, MAX)}… (cut)` : doc.text};
        }
        default:
          throw new Error(`Unknown tool ${String(name)}.`);
      }
    },
  };
}

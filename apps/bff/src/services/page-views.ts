import type {AgentToolCall, AgentToolHost, EndpointId, Example, PageId, PageLocation, PageView, ProjectState, PromptVersion} from '@tsp/contracts';
import {agentStart, isStartTool} from './starts.ts';
import {checkTemplate, defaultOutputPick, finalRunPlan, pageFromPath, isImageKey, judge, MADE_BY, recommend, settingsHash, versionLabel} from '@tsp/domain';
import {getApp} from './app.ts';
import {loadProjectState} from './projects.ts';

/**
 * Page views: each page as the agent sees it, built from the same saved data the page shows.
 * The page is the agent's workspace (like a repo for a coding agent): the view of the page the
 * user is on goes with every message, and the read tools below open any other part of it.
 * Nothing here reads the DOM, and nothing here changes data.
 */

const TITLES: Record<PageId, string> = {
  projects: 'Projects',
  setup: 'Setup',
  dataset: 'Dataset',
  gold: 'Gold Labels',
  prompt: 'Prompt Engineering · prompt versions',
  prompt_edit: 'Prompt editor',
  compare: 'Compare two scores',
  report: 'Eval report',
  training: 'Training and test sets',
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
  return {id: v.id, label: versionLabel(v), madeBy: MADE_BY[v.madeBy] ?? v.madeBy, change: v.change || null, createdAt: v.createdAt, scores: scoresOf(state, v)};
}

function versionDetail(state: ProjectState, v: PromptVersion) {
  return {...versionRow(state, v), template: v.template, features: v.features, promptImages: v.images.length};
}

/** A report as the Eval report page shows it: scores, the threshold checks, mix-ups, trend. */
function reportView(state: ProjectState, v: PromptVersion | undefined, model: EndpointId | undefined) {
  const current = state.reports.filter(r => !r.archivedNow && (!model || r.endpoint === model));
  const r = v ? current.find(x => x.promptVersionId === v.id) : current[0];
  if (!r) return {report: null, why: v ? `${versionLabel(v)} has no report${model ? ` on ${modelName(state, model)}` : ''} yet.` : 'No version has a report yet.'};
  const ver = state.versions.find(x => x.id === r.promptVersionId)!;
  const t = state.setup?.thresholds;
  const nEval = state.examples.filter(e => e.split === 'eval').length;
  const byId = new Map(state.examples.map(e => [e.id, e]));
  const trend = state.reports
    .filter(x => x.endpoint === r.endpoint && !x.archivedNow)
    .map(x => ({version: versionLabel(state.versions.find(v2 => v2.id === x.promptVersionId)!), lowestFieldMacroF1: r2(x.metrics.lowestField.macroF1), passed: x.passed}))
    .reverse();
  return {
    report: {
      version: versionLabel(ver),
      versionId: ver.id,
      model: modelName(state, r.endpoint),
      scoredOn: r.metrics.n,
      passed: r.passed,
      fields: r.metrics.fields.map(f => ({field: f.field, kind: f.kind, macroF1: r2(f.macroF1), accuracy: r2(f.accuracy), weakestValues: [...f.values].sort((a, b) => a.f1 - b.f1).slice(0, 3).map(x => ({value: x.value, f1: r2(x.f1)}))})),
      lowestField: {field: r.metrics.lowestField.field, macroF1: r2(r.metrics.lowestField.macroF1)},
      lowestValue: r.metrics.lowestValue ? {...r.metrics.lowestValue, f1: r2(r.metrics.lowestValue.f1)} : null,
      invalidRate: r2(r.metrics.invalidRate),
      costPer1000Usd: r2(r.metrics.costPer1000),
      checks: t ? judge(r.metrics, t, nEval).checks : null,
      topMixUps: r.metrics.mixUps.slice(0, 5).map(m => ({field: m.field, kind: m.kind, gold: m.gold, predicted: m.predicted, count: m.count, examples: m.exampleIds.slice(0, 3).map(id => byId.get(id)?.externalId)})),
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
  return {id: e.externalId, type: e.type, split: e.split, title: e.title, features};
}

function adviceOf(state: ProjectState) {
  const running = state.optimisation.find(o => o.state === 'running');
  const a = recommend(state, running?.endpoint ?? null);
  return {nextStep: a.title, reasons: a.reasons};
}

/** Test examples with a valid saved answer from the version the final run would use now. */
async function answeredTest(state: ProjectState, page: PageId): Promise<ReadonlySet<string>> {
  const pick = page === 'training' ? defaultOutputPick(state) : null;
  const settings = pick && state.setup?.models.find(m => m.endpoint === pick.endpoint);
  if (!pick || !settings) return new Set();
  const preds = await getApp().labeling.predictions(pick.version.id, pick.endpoint, settingsHash(settings));
  return new Set(state.examples.filter(e => e.split === 'test' && preds.get(e.id)?.answer).map(e => e.id));
}

function build(state: ProjectState, loc: PageLocation, unsaved: Record<string, unknown>, answered: ReadonlySet<string> = new Set()): PageView {
  const {page, params} = loc;
  const s = state.setup;
  const counts = {eval: 0, test: 0, train: 0} as Record<string, number>;
  for (const e of state.examples) if (e.split) counts[e.split]++;
  const base = (summary: string, data: Record<string, unknown>): PageView => ({page, title: TITLES[page], summary, data: {...data, ...(Object.keys(unsaved).length ? {unsaved} : {})}});

  switch (page) {
    case 'setup': {
      const step = params.step ?? '1';
      return base(
        step === '1' ? 'Setup step 1: the task and the labels (schema).' : step === '2' ? 'Setup step 2: how prompts are evaluated (thresholds).' : 'Setup step 3: which labeling models to use.',
        {step, task: s?.task ?? '', schema: s?.schema ?? null, thresholds: s?.thresholds ?? null, models: s?.models ?? [], availableModels: state.endpoints.map(e => ({id: e.id, name: e.name, cost: e.cost, speed: e.speed}))},
      );
    }
    case 'dataset': {
      const snap = state.snapshot;
      return base(snap ? `Dataset ${snap.number} from ${snap.sourceName}: ${snap.counts.valid} valid examples (${snap.counts.video} video, ${snap.counts.photoText} photo&text).${snap.split ? ` Split: ${snap.split.eval} eval, ${snap.split.test} test, ${snap.split.train} train.` : ' Not split yet.'}` : 'No dataset yet.', {
        snapshot: snap ? {number: snap.number, source: snap.source, name: snap.sourceName, counts: snap.counts, split: snap.split} : null,
        sampling: state.samplingTask ? {state: state.samplingTask.state, done: state.samplingTask.fetched, total: state.samplingTask.total} : null,
      });
    }
    case 'gold': {
      const testRun = state.testRuns[0];
      return base(`Gold labels: eval ${state.facts.goldEvalDone} of ${counts.eval}, test ${state.facts.goldTestDone} of ${counts.test}. Eval labels are needed for scores; test labels are optional.`, {
        eval: {done: state.facts.goldEvalDone, total: counts.eval},
        test: {done: state.facts.goldTestDone, total: counts.test, modelAnswers: testRun ? {state: testRun.state, done: testRun.done, total: testRun.total, model: modelName(state, testRun.endpoint)} : null},
        needRecheckAfterSchemaChange: state.staleGold.size,
        note: 'Model answers stay hidden while people label, so as not to sway them. Do not reveal them unless asked.',
      });
    }
    case 'prompt': {
      const running = state.optimisation.find(o => o.state === 'running') ?? state.optimisation[0];
      return base(`${state.versions.length} prompt version(s); the newest is ${state.versions[0] ? versionLabel(state.versions[0]) : 'none'}.`, {
        versions: state.versions.slice(0, 12).map(v => versionRow(state, v)),
        moreVersions: Math.max(0, state.versions.length - 12),
        optimiser: running ? {model: modelName(state, running.endpoint), state: running.state, candidates: running.candidates, calls: running.calls, budgetCalls: running.budgetCalls, stopReason: running.stopReason} : null,
        advice: adviceOf(state),
      });
    }
    case 'prompt_edit': {
      const v = findVersion(state, params.v) ?? state.versions[0];
      return base(v ? `Editing ${versionLabel(v)}. Saving makes a new version, which is scored right away.` : 'Writing the first prompt version.', {version: v ? versionDetail(state, v) : null});
    }
    case 'compare': {
      const a = findVersion(state, params.a);
      const b = findVersion(state, params.b);
      const one = (v: PromptVersion | undefined, m: unknown) => (v ? {...versionRow(state, v), ...reportView(state, v, asModel(m, state) ?? 'A')} : null);
      return base(a && b ? `Comparing ${versionLabel(a)} (Model ${params.am ?? 'A'}) with ${versionLabel(b)} (Model ${params.bm ?? 'A'}).` : 'Pick two scores to compare.', {a: one(a, params.am), b: one(b, params.bm)});
    }
    case 'report': {
      const v = findVersion(state, params.v);
      const view = reportView(state, v, asModel(params.m, state));
      return base(view.report ? `Eval report for ${view.report.version} on ${view.report.model}: lowest field macro-F1 ${view.report.lowestField.macroF1} (${view.report.lowestField.field}), ${view.report.passed ? 'passes' : 'below'} the threshold.` : view.why!, {...view, advice: adviceOf(state)});
    }
    case 'training': {
      const ts = state.trainingSets[0];
      const pick = defaultOutputPick(state);
      if (ts) {
        const v = state.versions.find(x => x.id === ts.promptVersionId);
        return base(`Training and test sets with ${v ? versionLabel(v) : 'a version'} on ${modelName(state, ts.endpoint)}: ${ts.state}, ${ts.done} of ${ts.total} labeled.`, {
          run: {state: ts.state, version: v ? versionLabel(v) : null, model: modelName(state, ts.endpoint), done: ts.done, total: ts.total, train: ts.trainTotal ?? ts.total, test: ts.testTotal ?? 0, labeled: ts.labeled, invalid: ts.invalid, failed: ts.failed, costUsd: r2(ts.costUsd), approvedUsd: r2(ts.estimateUsd), evaluated: ts.evaluated},
        });
      }
      // The same plan as the page's confirm: train is labeled; a test example uses its gold label,
      // else the version's valid answer, and only the rest are labeled if the user ticks it.
      const p = pick ? finalRunPlan(state, pick.version, pick.endpoint, answered) : null;
      if (!pick || !p) return base('Not generated yet: there is no prompt version.', {plan: null});
      const t = p.test;
      const run = p.total(false);
      return base(
        `Not generated yet. It would use ${versionLabel(pick.version)} on ${modelName(state, pick.endpoint)}: ${p.train.count} train examples, about $${run.costUsd.toFixed(2)}. Test set: ${t.withGold.length} with a gold label, ${t.withAnswer.length} with an answer from it, ${t.toLabel.length} with no label${t.toLabel.length ? ` (labeling them adds about $${t.costUsd.toFixed(2)})` : ''}.`,
        {
          plan: {
            version: versionLabel(pick.version),
            model: modelName(state, pick.endpoint),
            train: p.train.count,
            test: {total: t.total, withGold: t.withGold.length, withAnswer: t.withAnswer.length, noLabel: t.toLabel.length, labelThemUsd: r2(t.costUsd)},
            estimateUsd: r2(run.costUsd),
            minutes: run.minutes,
            evaluated: !!p.report && !!state.reports.find(r => r.id === p.report!.id)?.passed,
          },
        },
      );
    }
    default:
      return base(`Project ${state.project.name}.`, {steps: state.facts.approved});
  }
}

export {pageFromPath};

export async function getPageView(projectId: string, loc: PageLocation, unsaved: Record<string, unknown> = {}): Promise<PageView> {
  const state = await loadProjectState(projectId);
  if (!state) return {page: loc.page, title: TITLES[loc.page], summary: 'The project was not found.', data: {}};
  const view = build(state, loc, unsaved, await answeredTest(state, loc.page));
  if (!state.setup) view.data.note = 'Setup is not finished yet.';
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
          for (const k of ['v', 'm', 'a', 'b', 'am', 'bm', 'step']) if (typeof args[k] === 'string') params[k] = args[k] as string;
          if (params.v) params.v = findVersion(state, params.v)?.id ?? params.v;
          if (params.m) params.m = asModel(params.m, state) ?? params.m;
          return build(state, {page, params}, {}, await answeredTest(state, page));
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
          const split = typeof args.split === 'string' ? args.split : null;
          const list = state.examples.filter(e => (!ids || ids.has(e.externalId) || ids.has(e.id)) && (!split || e.split === split));
          return {total: list.length, examples: list.slice(0, limitOf(args.limit, 10, 5)).map(exampleView)};
        }
        case 'get_gold_labels': {
          const split = args.split === 'test' ? 'test' : 'eval';
          const list = state.examples.filter(e => e.split === split && state.gold.has(e.id));
          return {split, labeled: list.length, labels: list.slice(0, limitOf(args.limit, 20, 10)).map(e => ({id: e.externalId, title: e.title, answer: state.gold.get(e.id)!.answer}))};
        }
        case 'get_predictions': {
          const v = findVersion(state, args.version);
          const m = asModel(args.model, state) ?? state.setup?.models[0]?.endpoint;
          const settings = state.setup?.models.find(x => x.endpoint === m);
          if (!v || !settings) throw new Error('Name a version and one of the chosen models.');
          const preds = await labeling.predictions(v.id, settings.endpoint, settingsHash(settings));
          const same = (a?: string[], b?: string[]) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
          const rows = state.examples
            .filter(e => e.split === 'eval' && preds.has(e.id))
            .map(e => ({e, p: preds.get(e.id)!, g: state.gold.get(e.id)?.answer ?? null}))
            .filter(({p, g}) => !args.mixedUpOnly || !p.answer || (g && state.setup!.schema!.fields.some(f => !same(g[f.name], p.answer![f.name]))));
          return {version: versionLabel(v), model: modelName(state, settings.endpoint), rows: rows.slice(0, limitOf(args.limit, 20, 10)).map(({e, p, g}) => ({id: e.externalId, title: e.title, model: p.answer, invalid: p.invalidReason, gold: g})), matching: rows.length};
        }
        case 'check_template': {
          const template = typeof args.template === 'string' ? args.template : '';
          const v = state.versions[0];
          const features = (args.features as PromptVersion['features'] | undefined) ?? v?.features ?? {video: [], photo_text: [], metadata: []};
          const r = checkTemplate(template, features, {schema: state.setup?.schema, types: [...new Set(state.examples.map(e => e.type))], images: v?.images ?? []});
          return {errors: r.errors.map(e => e.message), warnings: r.warnings.map(w => w.message)};
        }
        default:
          throw new Error(`Unknown tool ${String(name)}.`);
      }
    },
  };
}

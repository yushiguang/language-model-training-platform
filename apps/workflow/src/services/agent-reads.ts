import type {AgentProposal, AuditEntry, GoldUploadRefusal, ProjectState, PromptVersion, SourceFile} from '@yushiguang/sprint-contracts';
import {answersForHelpers, dryRunSize, featureText, isImageKey, findGuideTopic, gate, isRight, labelBalance, NODES, pickWrong, productGuide, promptKeys, settingsHash, stepLine, systemConfig, toMap, versionLabel, visibleToAgents, wrongExamples} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';
import {getSamplingTask} from './dataset.ts';
import {scoreOnOptimiserHalf} from './evaluation.ts';
import {withFeatures} from './features.ts';
import {labelComments, withComments} from './mismatches.ts';
import {tenantOf} from './sources.ts';

/**
 * Agent abilities, step 1 (#39): the reads behind questions the helpers could not answer before.
 * Each one reads what the pages already show, as counts and labels; none of them names an example,
 * so the held-out half stays out of reach without a filter. Nothing here changes data.
 */

const r2 = (x: number) => Number(x.toFixed(2));
const modelName = (state: ProjectState, id: string) => state.endpoints.find(e => e.id === id)?.name ?? id;
const labelOf = (state: ProjectState, id: string | null | undefined) => {
  const v = id ? state.versions.find(x => x.id === id) : undefined;
  return v ? versionLabel(v) : null;
};

/** A2: each step, approved or not, what its Approve button waits for, and the numbers behind it. */
export function gates(state: ProjectState) {
  const f = state.facts;
  const {minEvalHard} = systemConfig().dataset;
  const steps = NODES.map(n => {
    const g = gate(n.id, f);
    return {step: n.label, approved: f.approved.includes(n.id), canApprove: g.ready, waitsFor: g.reason};
  });
  const current = steps.find(s => !s.approved)?.step ?? null;
  return {
    current,
    steps,
    numbers: {
      examples: f.examples,
      goldLabeled: f.goldEvalDone,
      goldLabeledPerHalf: f.goldHalves,
      versions: f.versions,
      passingVersions: f.passing.map(p => ({version: labelOf(state, p.promptVersionId), model: modelName(state, p.endpoint)})),
      settingsSaved: f.settingsConfirmed,
    },
    needed: {
      examples: minEvalHard,
      goldLabeled: minEvalHard,
      goldLabeledInEachHalf: 2,
      toFinish: 'a version that passes the pass rule in Project Settings',
    },
    note: 'Gold Labels also needs 2 gold-labeled examples in each half of the eval set: one half teaches, the other scores. Labeling more examples fills both halves. Paid work does not start by itself until Project Settings is saved once.',
  };
}

/** A5: what is running for the project now, and how far it is. No cost or time, as on the pages. */
export async function runningWork(w: Scope, state: ProjectState) {
  const live = (s: string) => s === 'running' || s === 'paused';
  const sampling = await getSamplingTask(w, state.project.id);
  const imports = (await w.catalog.find('source_files', {tenantId: tenantOf(w)})).filter(f => f.state === 'importing');
  const sources = imports.length ? await w.catalog.find('data_sources', {tenantId: tenantOf(w)}) : [];
  const usedSources = new Set(state.datasetSources.map(s => s.sourceId));
  const runs = state.runs.filter(r => live(r.state));
  const optimiser = state.optimisation.filter(o => live(o.state));
  const work = {
    labeling: runs.map(r => ({
      version: labelOf(state, r.promptVersionId),
      model: modelName(state, r.endpoint),
      why: r.purpose === 'optimiser' ? 'the Optimiser' : 'scoring',
      state: r.state,
      done: r.done,
      of: r.total,
      stoppable: r.purpose !== 'optimiser',
    })),
    optimiser: optimiser.map(o => ({
      round: o.round,
      maxRounds: o.maxRounds,
      startedFrom: labelOf(state, o.startVersionId),
      now: stepLine(o.step, labelOf(state, o.stepVersionId), dryRunSize(state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && !!state.gold[e.id]).length)),
    })),
    takingExamples: sampling && sampling.state === 'running' ? {fetched: sampling.fetched, of: sampling.total, saving: !!sampling.saving} : null,
    dataSourceImports: imports.map(f => ({source: sources.find(s => s.id === f.sourceId)?.name ?? null, file: f.name, done: f.done, of: f.items, usedByThisProject: usedSources.has(f.sourceId)})),
  };
  const nothing = !work.labeling.length && !work.optimiser.length && !work.takingExamples && !work.dataSourceImports.length;
  return {
    ...work,
    ...(nothing ? {note: 'Nothing is running for this project.'} : {}),
    howToStop: 'Scoring stops with Stop on its row on Prompt versions; the Optimiser with Stop on its progress panel; taking examples with Stop on Eval Dataset. Stopping keeps what is already done.',
  };
}

/** One upload's audit record, as the helpers read it. */
function uploadView(a: AuditEntry) {
  const d = a.data as {file?: string | null; saved?: number; replaced?: number; unchanged?: number; notInDataset?: number; refused?: number; refusedRows?: GoldUploadRefusal[]};
  return {
    at: a.createdAt,
    by: a.actor,
    file: d.file ?? null,
    saved: d.saved ?? 0,
    replacedEarlierLabels: d.replaced ?? 0,
    unchanged: d.unchanged ?? 0,
    notInDataset: d.notInDataset ?? 0,
    refused: d.refused ?? 0,
    // The row number and the reason only: an item id could be one of the held-out half. Uploads
    // made before #39 keep no rows.
    refusedRows: d.refusedRows ? d.refusedRows.map(r => ({row: r.row, reason: r.reason})) : null,
  };
}

/** D5: what the last label uploads and the dataset's sources saved, skipped and refused, and why. */
export async function uploadResult(w: Scope, state: ProjectState) {
  const projectId = state.project.id;
  const uploads = (await w.catalog.find('audit_log', {projectId, action: 'gold_labels.uploaded'}, 'createdAt desc')).slice(0, 3).map(uploadView);
  const counts = state.snapshot?.counts;
  const files: SourceFile[] = [];
  for (const line of state.datasetSources) files.push(...(await w.catalog.find('source_files', {sourceId: line.sourceId}, 'uploadedAt desc')));
  return {
    labelUploads: uploads,
    dataset: counts
      ? {
          itemsAsked: counts.rows,
          examplesSaved: counts.valid,
          leftOut: counts.invalid,
          leftOutByChecks: counts.checks ?? null,
          notSaved: counts.notSaved ?? 0,
        }
      : null,
    dataSourceFiles: files.map(f => ({
      source: state.datasetSources.find(s => s.sourceId === f.sourceId)?.name ?? null,
      file: f.name,
      rows: f.rows,
      noUsableItemId: f.bad,
      repeats: f.repeats,
      itemsAdded: f.items,
      state: f.state,
      ...(f.error ? {error: f.error} : {}),
    })),
    note: 'Label uploads: rows for items not in the dataset are skipped; refused rows give their row number and reason. Taking examples: the checks leave out items that no longer exist (missing), whose creator is a minor (minorCreator) or that cannot be publicly recommended (notRecommendable). Data source files: rows with no usable item id and repeated ids are skipped.',
  };
}

/** T6: one Optimiser run, round by round. Scores are on the held-out half; no example is named. */
export function optimiserRun(state: ProjectState, ref: unknown) {
  const runs = state.optimisation;
  if (!runs.length) return {note: 'The Optimiser has not run in this project.'};
  // Runs are newest first; "1" is the first run the project had.
  const n = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref.trim()) ? Number(ref) : null;
  const o = n == null ? runs[0] : runs[runs.length - n];
  if (!o) throw new Error(`There is no run ${String(ref)}. Runs: 1 to ${runs.length}, newest ${runs.length}.`);
  const why = (p: number | null | undefined) => (p == null ? 'the version the run started from' : `the best version on ${p} example${p === 1 ? '' : 's'} of the optimiser half`);
  return {
    run: runs.length - runs.indexOf(o),
    runs: runs.length,
    model: modelName(state, o.endpoint),
    state: o.state,
    startedFrom: labelOf(state, o.startVersionId),
    rounds: o.history.map(r => ({
      round: r.round,
      kind: r.kind,
      from: labelOf(state, r.parentId),
      whyThatVersion: r.kind === 'merge' ? 'two versions that each do best on different examples, merged' : why(r.parentWins),
      aimedAt: r.aimedAt ? {value: r.aimedAt.value, f1: r2(r.aimedAt.f1)} : null,
      change: r.change || null,
      version: labelOf(state, r.versionId),
      dryRun: r.dryRun ? {examples: r.dryRun.examples, passed: r.dryRun.passed, parentPassed: r.dryRun.parentPassed} : null,
      outcome: r.outcome,
      outcomeMeans: OUTCOME[r.outcome],
      macroF1: r.score == null ? null : r2(r.score),
      betterThanParent: r.gain ?? null,
      passed: r.passed,
      confirmed: r.confirm ? r.confirm.passed : null,
    })),
    stopReason: o.stopReason,
    stopReasonMeans: o.stopReason ? (STOP[o.stopReason] ?? null) : null,
    error: o.error,
  };
}

const OUTCOME: Record<string, string> = {
  running: 'still being tried',
  kept: 'did as well or better in the dry run, scored on the eval set and kept as a version',
  dropped: 'did worse than its parent in the dry run, so it was not scored',
  checks: 'broke a rule every prompt must follow (for example it changed the label or its values, which only people may change), so it was dropped',
  repeat: 'repeated a prompt already tried, so it was dropped',
  failed: 'failed; Retry resumes it',
  stopped: 'stopped by the user',
};

const STOP: Record<string, string> = {
  passes: 'a version passed and the pass was confirmed',
  max_rounds: 'it tried the number of rounds asked for',
  no_new_ideas: 'several rounds in a row brought nothing better',
  user: 'the user pressed Stop',
};

/** T8: the Prompt helper's drafts, discarded ones too, newest first, with their changes and reasons. */
export async function drafts(w: Scope, state: ProjectState, limit: number) {
  const all = await w.catalog.find('agent_proposals', {projectId: state.project.id}, 'createdAt desc');
  const label = (v: PromptVersion | undefined) => (v ? versionLabel(v) : null);
  const view = (p: AgentProposal) => ({
    at: p.createdAt,
    state: p.state,
    from: p.payload.baseVersionId ? label(state.versions.find(v => v.id === p.payload.baseVersionId)) : null,
    brief: p.brief || null,
    change: p.payload.change ?? null,
    changes: p.payload.changes ?? [],
    prompt: p.payload.structured,
  });
  return {
    drafts: all.slice(0, limit).map(view),
    total: all.length,
    note: '"open": waiting on the page; "approved": saved as a version; "discarded": the user dropped it. Do not offer a discarded change again unless the user asks for it.',
  };
}

/** A3: the product guide, one topic or the list of topics. */
export function guide(topic: unknown) {
  const all = productGuide();
  const topics = Object.entries(all).map(([name, t]) => ({topic: name, title: t.title}));
  if (typeof topic !== 'string' || !topic.trim()) return {topics};
  const hit = findGuideTopic(topic);
  if (!hit) return {error: `No guide topic matches "${topic}".`, topics};
  return {topic: hit.name, title: hit.topic.title, text: hit.topic.text};
}

// ---------------------------------------------------------------------------------------------
// Step 2 (#39): the briefs the skills start from. Examples come from the optimiser half only.

function findVersionRef(state: ProjectState, ref: unknown): PromptVersion | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  const label = ref.trim().toLowerCase().replace(/^version\s+/, '');
  return state.versions.find(v => v.id === ref || versionLabel(v) === label || versionLabel(v) === `v${label}`);
}

/** The scored report of a version on the project's model, or an error the helper can act on. */
function scoredVersion(state: ProjectState, ref: unknown) {
  const v = ref == null || ref === '' ? state.versions.find(x => state.reports.some(r => r.promptVersionId === x.id && !r.archivedNow)) : findVersionRef(state, ref);
  if (!v) throw new Error(ref ? `There is no version "${String(ref)}". Versions: ${state.versions.map(versionLabel).join(', ')}.` : 'No version has scores yet.');
  const report = state.reports.find(r => r.promptVersionId === v.id && !r.archivedNow);
  if (!report) throw new Error(`${versionLabel(v)} has no scores yet.`);
  const settings = state.setup?.models.find(m => m.endpoint === report.endpoint);
  if (!settings || !state.setup?.schema) throw new Error(`${versionLabel(v)} has no scores on the project's model.`);
  return {v, report, settings, setup: state.setup};
}

/**
 * T1: what Improve with AI reads, in chat or from the button (the same brief either way): a
 * version's prompt, its mix-ups and weakest value on the optimiser half, how many mistakes it
 * makes there, and up to 8 wrong examples with the model's reasons and people's comments.
 */
export async function mistakes(w: Scope, state: ProjectState, ref: unknown) {
  const {v, report, settings, setup} = scoredVersion(state, ref);
  const answers = toMap(await w.labeling.predictions(v.id, report.endpoint, settingsHash(settings)));
  // R3-9 (D3) and finding 3: everything here comes from the optimiser half.
  const half = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e));
  const gold = new Map(half.filter(e => !!state.gold[e.id]).map(e => [e.id, state.gold[e.id]!.answer]));
  const wrong = half.filter(e => gold.has(e.id) && !isRight(gold.get(e.id)!, answers.get(e.id)?.answer ?? null)).length;
  const said = answersForHelpers(half.filter(e => answers.has(e.id)).map(e => answers.get(e.id)!));
  const examples = withComments(wrongExamples(await withFeatures(w, pickWrong(half, gold, said.predicted)), promptKeys(v), gold, said.predicted, undefined, said.notes), half, await labelComments(w, state.project.id, state));
  const m = await scoreOnOptimiserHalf(w, setup, v, report.endpoint, state.examples, state.gold);
  return {
    version: versionLabel(v),
    versionId: v.id,
    prompt: v.structured,
    macroF1: r2(m.macroF1),
    lowestValue: m.lowestValue ? {value: m.lowestValue.value, f1: r2(m.lowestValue.f1)} : null,
    mixUps: m.mixUps.slice(0, 8).map(x => ({kind: x.kind ?? 'confused', gold: x.gold, predicted: x.predicted, count: x.count})),
    mistakes: wrong,
    examples,
    note: 'From the optimiser half only; the scores people see come from the held-out half.',
  };
}

/**
 * T2: why two versions score differently: the parts of the prompt that changed, and the examples
 * of the optimiser half one version gets right and the other wrong, with both answers and reasons.
 */
export async function flips(w: Scope, state: ProjectState, aRef: unknown, bRef: unknown) {
  const b = scoredVersion(state, bRef ?? state.versions[0]?.id);
  const a = scoredVersion(state, aRef ?? state.versions.find(x => x.id === b.v.parentId)?.id ?? state.versions[1]?.id);
  if (a.v.id === b.v.id) throw new Error('Name two different versions.');
  if (a.report.endpoint !== b.report.endpoint) throw new Error('The two versions were scored on different models.');
  const [pa, pb] = await Promise.all([a, b].map(x => w.labeling.predictions(x.v.id, x.report.endpoint, settingsHash(x.settings)).then(toMap)));
  const half = state.examples.filter(e => e.split === 'eval' && visibleToAgents(e) && !!state.gold[e.id] && pa.has(e.id) && pb.has(e.id));
  const ok = (p: typeof pa, id: string) => isRight(state.gold[id]!.answer, p.get(id)?.answer ?? null);
  const row = (id: string) => ({a: pa.get(id)!.answer, aReason: pa.get(id)!.reason ?? null, b: pb.get(id)!.answer, bReason: pb.get(id)!.reason ?? null});
  const fixed = half.filter(e => !ok(pa, e.id) && ok(pb, e.id));
  const broken = half.filter(e => ok(pa, e.id) && !ok(pb, e.id));
  const brief = async (list: typeof half) =>
    (await withFeatures(w, list.slice(0, 6), true)).map(e => ({id: e.externalId, title: e.title, gold: state.gold[e.id]!.answer, ...row(e.id), features: Object.fromEntries(Object.entries(e.features).filter(([k]) => promptKeys(b.v).has(k) && !isImageKey(k)).map(([k, x]) => [k, featureText(x).slice(0, 400)]))}));
  const score = (x: typeof a) => ({macroF1: r2(x.report.metrics.macroF1), values: Object.fromEntries(x.report.metrics.values.map(y => [y.value, r2(y.f1)]))});
  return {
    a: {version: versionLabel(a.v), change: a.v.change || null, scores: score(a)},
    b: {version: versionLabel(b.v), change: b.v.change || null, scores: score(b)},
    promptA: a.v.structured,
    promptB: b.v.structured,
    readableHalf: {examples: half.length, fixedByB: fixed.length, brokenByB: broken.length},
    fixed: await brief(fixed),
    broken: await brief(broken),
    note: 'Scores are on the held-out half; fixed and broken examples are from the optimiser half only, so their counts do not add up to the score change.',
  };
}

/** P3: which values are read as which across every scored version (counts), and the label balance. */
export function confusions(state: ProjectState) {
  const schema = state.setup?.schema;
  if (!schema) throw new Error('The project has no label yet.');
  const pairs = new Map<string, {gold: string | null; predicted: string | null; kind: string; count: number; versions: Set<string>}>();
  for (const r of state.reports.filter(x => !x.archivedNow)) {
    const v = state.versions.find(x => x.id === r.promptVersionId);
    for (const m of r.metrics.mixUps) {
      const key = `${m.kind ?? 'confused'}|${m.gold}|${m.predicted}`;
      const p = pairs.get(key) ?? {gold: m.gold, predicted: m.predicted, kind: m.kind ?? 'confused' as string, count: 0, versions: new Set<string>()};
      p.count += m.count;
      if (v) p.versions.add(versionLabel(v));
      pairs.set(key, p);
    }
  }
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const b = labelBalance(schema, evalEx, state.gold);
  return {
    label: {name: schema.name, kind: schema.kind, values: schema.values.map(v => ({name: v.name, definition: v.definition, ...(v.exclusive ? {exclusive: true} : {})}))},
    scoredVersions: new Set(state.reports.filter(x => !x.archivedNow).map(x => x.promptVersionId)).size,
    mixUps: [...pairs.values()].sort((x, y) => y.count - x.count).slice(0, 10).map(p => ({kind: p.kind, gold: p.gold, predicted: p.predicted, count: p.count, inVersions: [...p.versions]})),
    balance: b.values.map(v => ({value: v.value, goldLabeled: v.count, rare: v.rare, dominant: v.dominant})),
    note: 'Mix-ups are counts summed over every scored version, never examples.',
  };
}

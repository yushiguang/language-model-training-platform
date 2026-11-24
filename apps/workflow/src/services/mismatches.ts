import type {Answer, Example, ExampleBrief, MismatchList, MismatchReview, Prediction, ProjectState} from '@yushiguang/sprint-contracts';
import {withComments, inRanges, isRight, versionLabel, visibleToAgents, systemConfig, sameAnswer} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {saveGold} from './dataset.ts';
import {predictionsFor} from './evaluation.ts';
import {addComment} from './governance.ts';
import {loadProjectState} from './projects.ts';

/** The audit action that records a decision made on the Mismatches tab. */
export const GOLD_REVIEW = 'gold.review';

interface ReviewData {
  exampleId: string;
  versionId: string;
  outcome: 'kept' | 'changed';
  /** Took the model's answer (a change to exactly the version's answer). */
  usedModel?: boolean;
  goldId: string;
  previousGoldId: string;
  previousAnswer?: Answer;
  note?: string;
  at: string;
}

const brief = (d: ReviewData): MismatchReview => ({exampleId: d.exampleId, outcome: d.outcome === 'kept' ? 'kept' : d.usedModel ? 'model' : 'other', note: d.note ?? null, at: d.at});

const same = (a: Answer, b: Answer) => sameAnswer(a, b);

/**
 * The reviews that still stand, by "exampleId|versionId" (Evelyn, 2026-11-11: a review belongs to a
 * gold label and a version): the newest review of each pair. A review
 * lapses once the example's gold label changes after it.
 */
async function standingReviews(w: Scope, projectId: string, state: ProjectState): Promise<Map<string, ReviewData & {earlier: ReviewData[]}>> {
  const {catalog} = w;
  const all = new Map<string, ReviewData[]>();
  for (const r of await catalog.find('audit_log', {projectId, action: GOLD_REVIEW})) {
    const d = r.data as unknown as ReviewData;
    const key = `${d.exampleId}|${d.versionId}`;
    all.set(key, [...(all.get(key) ?? []), d]);
  }
  const out = new Map<string, ReviewData & {earlier: ReviewData[]}>();
  for (const [k, list] of all) {
    // R6-3: a reviewed item is edited by appending a review; the newest stands, the rest are its history.
    // Oldest first (stable, so same-time records keep their order), then the newest first.
    const sorted = [...list].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).reverse();
    const d = sorted[0];
    if (state.gold[d.exampleId]?.id !== d.goldId) continue;
    out.set(k, {...d, earlier: sorted.slice(1)});
  }
  return out;
}

/**
 * The people's comments the helpers may read (spec 1.0.0, 5.4), by example id, oldest first:
 * optimiser-half examples only, never the held-out half. A comment is about what the gold label
 * means, not about one version's answer, so comments from every view are included. Notes saved
 * with a mismatch decision before 1.0.0 come first.
 */
export async function labelComments(w: Scope, projectId: string, state: ProjectState): Promise<Map<string, string[]>> {
  const visible = new Set(state.examples.filter(visibleToAgents).map(e => e.id));
  const out = new Map<string, string[]>();
  const add = (id: string, text: string) => out.set(id, [...(out.get(id) ?? []), text]);
  for (const d of (await standingReviews(w, projectId, state)).values()) if (d.note && visible.has(d.exampleId)) add(d.exampleId, d.note);
  for (const [id, list] of Object.entries(state.comments)) if (visible.has(id)) for (const c of list) add(id, c.text);
  return out;
}

/**
 * Saved answers on the whole eval set, by version (acceptance R5-5). Once a version has an answer
 * for every eval example those answers never change (labeling again uses another pass), so they
 * are read once per page and reused for every gold edit. Partial sets are not kept.
 */
async function answersOnEval(w: Scope, versionId: string, model: NonNullable<ProjectState['setup']>['models'][number], evalIds: string[]): Promise<Map<string, Prediction> | null> {
  const key = `${versionId}|${model.endpoint}|${JSON.stringify(model)}`;
  const had = w.local.fullAnswers.get(key);
  if (had && evalIds.every(id => had.has(id))) return had;
  const p = await predictionsFor(w, versionId, model.endpoint, model);
  if (!evalIds.every(id => p.has(id))) return null;
  w.local.fullAnswers.set(key, p);
  return p;
}

/**
 * Gold Labels' Mismatches tab (review finding 2, approved 2026-11-10): the eval examples where a
 * version's saved answer differs from the gold label, wrong in the most versions first. Only
 * versions with saved answers on the whole eval set count (not ones dropped after a dry run).
 * Nothing is labeled: it reads saved answers only. Reviews are per version (R4-5): an example
 * leaves the picked version's To review list once it is kept or changed for that version, and
 * goes back when the review is reopened. Answers the safety filter stopped are not mismatches.
 */
interface VersionAnswers {
  /** The gold-labeled eval examples. */
  evalEx: Example[];
  /** By version, its answer on each of `evalEx`; only versions of the current label with all of them. */
  answers: Map<string, Map<string, Prediction>>;
  /** Those versions, newest first, with their Macro-F1 on the first model. */
  versions: {id: string; label: string; score: number | null}[];
  /** The best-scored of them (the newest when none has a score). */
  best: {id: string; label: string; score: number | null};
}

/**
 * The versions whose saved answers cover every gold-labeled eval example, and the best-scored of
 * them: what the Mismatches review and the Dataset page compare gold labels with. Null before a
 * version has answers on all of them. Nothing is labeled: it reads saved answers only.
 */
export async function versionAnswers(w: Scope, state: ProjectState): Promise<VersionAnswers | null> {
  const setup = state.setup;
  const model = setup?.models[0];
  if (!setup?.schema || !model) return null;
  const evalEx = state.examples.filter(e => e.split === 'eval' && !!state.gold[e.id]);
  if (!evalEx.length) return null;
  // Versions of the current schema with an answer for every eval example, newest first.
  const answers = new Map<string, Map<string, Prediction>>();
  const evalIds = evalEx.map(e => e.id);
  for (const v of state.versions.filter(x => x.schemaVersion === setup.schemaVersion)) {
    const p = await answersOnEval(w, v.id, model, evalIds);
    if (p) answers.set(v.id, new Map(evalEx.map(e => [e.id, p.get(e.id)!])));
  }
  if (!answers.size) return null;
  const score = (id: string) => state.reports.find(r => r.promptVersionId === id && r.endpoint === model.endpoint && !r.archivedNow)?.metrics.macroF1 ?? null;
  const versions = state.versions.filter(v => answers.has(v.id)).map(v => ({id: v.id, label: versionLabel(v), score: score(v.id)}));
  const best = [...versions].filter(v => v.score != null).sort((a, b) => b.score! - a.score!)[0] ?? versions[0];
  return {evalEx, answers, versions, best};
}

/** A saved answer that does not match the gold label (an answer the safety filter stopped is not a mismatch). */
export const isMismatch = (gold: Answer, p: Prediction | undefined) => !!p && !p.filtered && !isRight(gold, p.answer);

/**
 * The Mismatches review for one version. With `labelSetId` (#115) the items, reviews and counts are
 * those of that label set's samples only; the versions and the best are still picked on the whole
 * dataset, so every set compares with the same version by default.
 */
export async function mismatches(w: Scope, projectId: string, versionId?: string | null, labelSetId?: string | null): Promise<MismatchList> {
  const set = labelSetId ? await w.catalog.get('label_sets', labelSetId) : null;
  if (labelSetId && (!set || set.projectId !== projectId)) throw new Error('This label set does not exist.');
  const state = await loadProjectState(w, projectId);
  const empty: MismatchList = {versions: [], versionId: null, items: [], wrongEverywhere: 0, reviewed: 0, reviewedItems: [], reviewedAll: 0};
  if (!state?.setup?.schema || !state.setup.models[0] || !state.examples.some(e => e.split === 'eval' && !!state.gold[e.id])) return empty;
  const standing = await standingReviews(w, projectId, state);
  const found = await versionAnswers(w, state);
  if (!found) return {...empty, reviewedAll: standing.size};
  const {answers, versions, best} = found;
  const evalEx = set ? found.evalEx.filter(e => inRanges(e, [{first: set.first, last: set.last}])) : found.evalEx;
  const picked = versionId && answers.has(versionId) ? versionId : best.id;
  const wrong = (vid: string, exId: string) => isMismatch(state.gold[exId]!.answer, answers.get(vid)!.get(exId));
  const of = answers.size;
  const reviewedHere = (e: Example) => standing.has(`${e.id}|${picked}`);
  const wrongIn = new Map(evalEx.map(e => [e.id, [...answers.keys()].filter(vid => wrong(vid, e.id)).length]));
  const items = evalEx
    .filter(e => !reviewedHere(e) && wrong(picked, e.id))
    .map(e => ({exampleId: e.id, wrongIn: wrongIn.get(e.id)!, of}))
    .sort((a, b) => b.wrongIn - a.wrongIn);
  const reviewedItems: MismatchReview[] = [...standing.values()]
    .filter(d => d.versionId === picked && evalEx.some(e => e.id === d.exampleId))
    .map(d => ({...brief(d), earlier: d.earlier.map(brief), firstAt: d.earlier.at(-1)?.at ?? d.at}))
    // Newest first by the first review, so editing a reviewed item (R6-3) does not move it.
    .sort((a, b) => (a.firstAt < b.firstAt ? 1 : a.firstAt > b.firstAt ? -1 : 0))
    .map(({firstAt: _, ...m}) => m);
  return {
    versions: versions.map(v => ({...v, best: v.id === best.id})),
    versionId: picked,
    items,
    // Examples no version gets right, whatever their review state.
    wrongEverywhere: of > 1 ? evalEx.filter(e => !reviewedHere(e) && wrongIn.get(e.id) === of).length : 0,
    reviewed: reviewedItems.length,
    reviewedItems,
    reviewedAll: standing.size,
  };
}

/**
 * A decision on the Mismatches tab, for one version: keep the gold label, or change it (to the
 * model's answer or a third answer), with the labeler's optional "Why" (R4-4). Every decision is
 * recorded; a change saves a new gold label, and scores are rebuilt from saved answers, with
 * nothing labeled again.
 */
export async function reviewGold(w: Scope, projectId: string, exampleId: string, versionId: string, outcome: 'kept' | 'changed', answer?: Answer, note?: string): Promise<void> {
  const {catalog, user} = w;
  const state = await loadProjectState(w, projectId);
  const current = state?.gold[exampleId];
  const model = state?.setup?.models[0];
  if (!state?.setup || !current) throw new Error('This example has no gold label.');
  const g = outcome === 'changed' && answer ? await saveGold(w, projectId, exampleId, state.setup.schemaVersion, answer, true) : current;
  const theirs = model ? (await predictionsFor(w, versionId, model.endpoint, model)).get(exampleId)?.answer : null;
  const text = note?.trim().slice(0, systemConfig().labeling.commentMaxChars) || undefined;
  const data: ReviewData = {exampleId, versionId, outcome, usedModel: outcome === 'changed' && !!theirs && !!answer && same(theirs, answer), goldId: g.id, previousGoldId: current.id, previousAnswer: current.answer, at: now()};
  await catalog.audit(projectId, (await user()).name, GOLD_REVIEW, data as unknown as Record<string, unknown>);
  // 1.0.0: the "Why" is a comment on the example (spec 5.4), kept with the version it was written on.
  if (text) await addComment(w, projectId, exampleId, text, versionId);
  w.tm.event('gold_mismatch_reviewed', {outcome, with_note: !!text});
  w.emitChange(projectId);
}

export {withComments};

import type {Answer, Example, ExampleBrief, MismatchList, MismatchReview, Prediction, ProjectState} from '@tsp/contracts';
import {fieldsRight, versionLabel, visibleToAgents} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {saveGold} from './dataset.ts';
import {predictionsFor} from './evaluation.ts';
import {loadProjectState} from './projects.ts';

/** The audit action that records a decision made on the Mismatches tab. */
export const GOLD_REVIEW = 'gold.review';
/** The audit action that reopens one (acceptance R4-5, 2026-11-11). */
export const GOLD_REOPEN = 'gold.reopen';
/** The longest "Why" note kept (R4-4). */
export const NOTE_MAX_CHARS = 500;

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

const same = (a: Answer, b: Answer) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * The reviews that still stand, by "exampleId|versionId" (Evelyn, 2026-11-11: a review belongs to a
 * gold label and a version): the newest review of each pair, unless a reopen names it. A review
 * also lapses once the example's gold label changes after it.
 */
async function standingReviews(projectId: string, state: ProjectState): Promise<Map<string, ReviewData>> {
  const {catalog} = getApp();
  const reopened = new Set(
    (await catalog.find('audit_log', {projectId, action: GOLD_REOPEN})).map(r => {
      const d = r.data as {exampleId: string; versionId: string; reviewAt: string};
      return `${d.exampleId}|${d.versionId}|${d.reviewAt}`;
    }),
  );
  const out = new Map<string, ReviewData>();
  for (const r of await catalog.find('audit_log', {projectId, action: GOLD_REVIEW})) {
    const d = r.data as unknown as ReviewData;
    const key = `${d.exampleId}|${d.versionId}`;
    if ((out.get(key)?.at ?? '') <= d.at) out.set(key, d);
  }
  for (const [k, d] of out) if (reopened.has(`${k}|${d.at}`) || state.gold.get(d.exampleId)?.id !== d.goldId) out.delete(k);
  return out;
}

/**
 * The labelers' "Why" notes the helpers may read (R4-4), by example id: optimiser-half examples
 * only, never the held-out half. The newest standing note on the example wins, from any version:
 * the note is about what the gold label means, not about one version's answer.
 */
export async function labelerNotes(projectId: string, state: ProjectState): Promise<Map<string, string>> {
  const visible = new Set(state.examples.filter(visibleToAgents).map(e => e.id));
  const notes = new Map<string, {note: string; at: string}>();
  for (const d of (await standingReviews(projectId, state)).values()) {
    if (!d.note || !visible.has(d.exampleId)) continue;
    const had = notes.get(d.exampleId);
    if (!had || had.at <= d.at) notes.set(d.exampleId, {note: d.note, at: d.at});
  }
  return new Map([...notes].map(([id, n]) => [id, n.note]));
}

/** Adds the labelers' notes (from `labelerNotes`) to the examples a helper reads. */
export function withLabelerNotes(briefs: ExampleBrief[], examples: Example[], notes: Map<string, string>): ExampleBrief[] {
  if (!notes.size) return briefs;
  const byExt = new Map(examples.filter(e => notes.has(e.id)).map(e => [e.externalId, notes.get(e.id)!]));
  return briefs.map(b => (byExt.has(b.externalId) ? {...b, labelerNote: byExt.get(b.externalId)!} : b));
}

/**
 * Gold Labels' Mismatches tab (review finding 2, approved 2026-11-10): the eval examples where a
 * version's saved answer differs from the gold label, wrong in the most versions first. Only
 * versions with saved answers on the whole eval set count (not ones dropped after a dry run).
 * Nothing is labeled: it reads saved answers only. Reviews are per version (R4-5): an example
 * leaves the picked version's To review list once it is kept or changed for that version, and
 * goes back when the review is reopened. Answers the safety filter stopped are not mismatches.
 */
export async function mismatches(projectId: string, versionId?: string | null): Promise<MismatchList> {
  const state = await loadProjectState(projectId);
  const empty: MismatchList = {versions: [], versionId: null, items: [], wrongEverywhere: 0, reviewed: 0, reviewedItems: [], reviewedAll: 0};
  const setup = state?.setup;
  const model = setup?.models[0];
  if (!state || !setup?.schema || !model) return empty;
  const schema = setup.schema;
  const evalEx = state.examples.filter(e => e.split === 'eval' && state.gold.has(e.id));
  if (!evalEx.length) return empty;
  const standing = await standingReviews(projectId, state);
  // Versions of the current schema with an answer for every eval example, newest first.
  const answers = new Map<string, Map<string, Prediction>>();
  for (const v of state.versions.filter(x => x.schemaVersion === setup.schemaVersion)) {
    const p = await predictionsFor(v.id, model.endpoint, model);
    if (evalEx.every(e => p.has(e.id))) answers.set(v.id, new Map(evalEx.map(e => [e.id, p.get(e.id)!])));
  }
  if (!answers.size) return {...empty, reviewedAll: standing.size};
  const score = (id: string) => state.reports.find(r => r.promptVersionId === id && r.endpoint === model.endpoint && !r.archivedNow)?.metrics.lowestField.macroF1 ?? null;
  const versions = state.versions.filter(v => answers.has(v.id)).map(v => ({id: v.id, label: versionLabel(v), score: score(v.id)}));
  const best = [...versions].filter(v => v.score != null).sort((a, b) => b.score! - a.score!)[0] ?? versions[0];
  const picked = versionId && answers.has(versionId) ? versionId : best.id;
  const wrong = (vid: string, exId: string) => {
    const p = answers.get(vid)!.get(exId)!;
    return !p.filtered && fieldsRight(schema, state.gold.get(exId)!.answer, p.answer).length < schema.fields.length;
  };
  const of = answers.size;
  const reviewedHere = (e: Example) => standing.has(`${e.id}|${picked}`);
  const wrongIn = new Map(evalEx.map(e => [e.id, [...answers.keys()].filter(vid => wrong(vid, e.id)).length]));
  const items = evalEx
    .filter(e => !reviewedHere(e) && wrong(picked, e.id))
    .map(e => ({exampleId: e.id, wrongIn: wrongIn.get(e.id)!, of}))
    .sort((a, b) => b.wrongIn - a.wrongIn);
  const reviewedItems: MismatchReview[] = [...standing.values()]
    .filter(d => d.versionId === picked && evalEx.some(e => e.id === d.exampleId))
    .map(d => ({exampleId: d.exampleId, outcome: d.outcome === 'kept' ? 'kept' : d.usedModel ? 'model' : 'other', note: d.note ?? null, at: d.at}) as MismatchReview)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
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
export async function reviewGold(projectId: string, exampleId: string, versionId: string, outcome: 'kept' | 'changed', answer?: Answer, note?: string): Promise<void> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  const current = state?.gold.get(exampleId);
  const model = state?.setup?.models[0];
  if (!state?.setup || !current) throw new Error('This example has no gold label.');
  const g = outcome === 'changed' && answer ? await saveGold(projectId, exampleId, state.setup.schemaVersion, answer, true) : current;
  const theirs = model ? (await predictionsFor(versionId, model.endpoint, model)).get(exampleId)?.answer : null;
  const text = note?.trim().slice(0, NOTE_MAX_CHARS) || undefined;
  const data: ReviewData = {exampleId, versionId, outcome, usedModel: outcome === 'changed' && !!theirs && !!answer && same(theirs, answer), goldId: g.id, previousGoldId: current.id, previousAnswer: current.answer, ...(text ? {note: text} : {}), at: now()};
  await catalog.audit(projectId, (await user()).name, GOLD_REVIEW, data as unknown as Record<string, unknown>);
  tm().event('gold_mismatch_reviewed', {outcome, with_note: !!text});
  emitChange();
}

/**
 * Reopen a reviewed mismatch for one version (R4-5): the review no longer stands, and a label
 * changed by that review goes back to what it was, so the example is in To review again.
 */
export async function reopenGold(projectId: string, exampleId: string, versionId: string): Promise<void> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state?.setup) throw new Error('The project was not found.');
  const d = (await standingReviews(projectId, state)).get(`${exampleId}|${versionId}`);
  if (!d) return;
  if (d.outcome === 'changed' && d.previousAnswer) await saveGold(projectId, exampleId, state.setup.schemaVersion, d.previousAnswer, true);
  await catalog.audit(projectId, (await user()).name, GOLD_REOPEN, {exampleId, versionId, reviewAt: d.at, at: now()});
  tm().event('gold_mismatch_reopened', {});
  emitChange();
}

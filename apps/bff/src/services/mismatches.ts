import type {Answer, MismatchList} from '@tsp/contracts';
import {fieldsRight, versionLabel} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {saveGold} from './dataset.ts';
import {predictionsFor} from './evaluation.ts';
import {loadProjectState} from './projects.ts';

/** The audit action that records a decision made on the Mismatches tab. */
export const GOLD_REVIEW = 'gold.review';

/**
 * Gold Labels' Mismatches tab (review finding 2, approved 2026-11-10): the eval examples where a
 * version's saved answer differs from the gold label, wrong in the most versions first. Only
 * versions with saved answers on the whole eval set count (not ones dropped after a dry run).
 * Nothing is labeled: it reads saved answers only. An example leaves the list once the user kept
 * or changed its label here (recorded in the audit log, against that gold label).
 */
export async function mismatches(projectId: string, versionId?: string | null): Promise<MismatchList> {
  const state = await loadProjectState(projectId);
  const empty: MismatchList = {versions: [], versionId: null, items: [], wrongEverywhere: 0, reviewed: 0};
  const setup = state?.setup;
  const model = setup?.models[0];
  if (!state || !setup?.schema || !model) return empty;
  const schema = setup.schema;
  const evalEx = state.examples.filter(e => e.split === 'eval' && state.gold.has(e.id));
  if (!evalEx.length) return empty;
  const reviews = await getApp().catalog.find('audit_log', {projectId, action: GOLD_REVIEW});
  const reviewedGold = new Set(reviews.map(r => String((r.data as {goldId?: string}).goldId ?? '')));
  // Versions of the current schema with an answer for every eval example, newest first.
  const answers = new Map<string, Map<string, Answer | null>>();
  for (const v of state.versions.filter(x => x.schemaVersion === setup.schemaVersion)) {
    const p = await predictionsFor(v.id, model.endpoint, model);
    if (evalEx.every(e => p.has(e.id))) answers.set(v.id, new Map(evalEx.map(e => [e.id, p.get(e.id)!.answer])));
  }
  if (!answers.size) return {...empty, reviewed: reviews.length};
  const score = (id: string) => state.reports.find(r => r.promptVersionId === id && r.endpoint === model.endpoint && !r.archivedNow)?.metrics.lowestField.macroF1 ?? null;
  const versions = state.versions.filter(v => answers.has(v.id)).map(v => ({id: v.id, label: versionLabel(v), score: score(v.id)}));
  const best = [...versions].filter(v => v.score != null).sort((a, b) => b.score! - a.score!)[0] ?? versions[0];
  const picked = versionId && answers.has(versionId) ? versionId : best.id;
  const wrong = (vid: string, exId: string) => fieldsRight(schema, state.gold.get(exId)!.answer, answers.get(vid)!.get(exId) ?? null).length < schema.fields.length;
  const of = answers.size;
  const open = evalEx.filter(e => !reviewedGold.has(state.gold.get(e.id)!.id));
  const wrongIn = new Map(open.map(e => [e.id, [...answers.keys()].filter(vid => wrong(vid, e.id)).length]));
  const items = open
    .filter(e => wrong(picked, e.id))
    .map(e => ({exampleId: e.id, wrongIn: wrongIn.get(e.id)!, of}))
    .sort((a, b) => b.wrongIn - a.wrongIn);
  return {
    versions: versions.map(v => ({...v, best: v.id === best.id})),
    versionId: picked,
    items,
    wrongEverywhere: of > 1 ? open.filter(e => wrongIn.get(e.id) === of).length : 0,
    reviewed: reviews.length,
  };
}

/**
 * A decision on the Mismatches tab: keep the gold label, or change it (to the model's answer or a
 * third answer). Every decision is recorded; a change saves a new gold label, and scores are
 * rebuilt from saved answers, with nothing labeled again.
 */
export async function reviewGold(projectId: string, exampleId: string, versionId: string, outcome: 'kept' | 'changed', answer?: Answer): Promise<void> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  const current = state?.gold.get(exampleId);
  if (!state?.setup || !current) throw new Error('This example has no gold label.');
  const g = outcome === 'changed' && answer ? await saveGold(projectId, exampleId, state.setup.schemaVersion, answer, true) : current;
  await catalog.audit(projectId, (await user()).name, GOLD_REVIEW, {exampleId, versionId, outcome, goldId: g.id, previousGoldId: current.id, at: now()});
  tm().event('gold_mismatch_reviewed', {outcome});
  emitChange();
}

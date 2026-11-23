import type {Job, JobOutcome} from '@yushiguang/sprint-contracts';
import type {Scope} from './app.ts';
import {scoreFromState} from './evaluation.ts';
import {loadProjectState} from './projects.ts';
import {computeKey} from './queue.ts';

/**
 * Rescore (Evelyn, 2026-11-12; docs/design/server.md 4.3): only when someone presses it. Nothing
 * starts it by itself, since gold edits, thresholds and samples all move scores. Every version of
 * the current label with saved answers on today's samples gets a fresh report on today's basis,
 * from saved answers only: nothing is labeled. A version missing answers is skipped (scoring it
 * again labels what is missing). Returns how many reports it built.
 */
export async function rebuildReports(w: Scope, projectId: string): Promise<number> {
  return (
    (await w.once(`rebuild:${projectId}`, async () => {
      const state = await loadProjectState(w, projectId);
      if (!state?.setup?.schema || !state.scoring.ready) return 0;
      let built = 0;
      const seen = new Set<string>();
      for (const r of state.runs.filter(x => x.state === 'done')) {
        const key = `${r.promptVersionId}|${r.endpoint}`;
        const v = state.versions.find(x => x.id === r.promptVersionId && x.schemaVersion === state.setup!.schemaVersion);
        if (!v || seen.has(key)) continue;
        seen.add(key);
        if (await scoreFromState(w, state, v, r.endpoint, {replace: true})) built++;
      }
      w.emitChange(projectId);
      return built;
    })) ?? 0
  );
}

/**
 * The Rescore button: queues one `report.rescore` job on the tenant's compute key. Its key names
 * today's basis, so a second press while it waits or runs adds nothing, and a press after the
 * basis moved again queues a new one.
 */
export async function rescore(w: Scope, projectId: string): Promise<void> {
  const state = await loadProjectState(w, projectId);
  if (!state) throw new Error('This project does not exist.');
  if (!state.scoring.ready) throw new Error('Scores are made once every label set is finished.');
  await w.jobs.enqueue(w.ctx, {kind: 'report.rescore', projectId, concurrencyKey: computeKey(w), args: {contextId: state.contextId}, idempotencyKey: `rescore:${projectId}:${state.contextId}`});
  w.emitChange(projectId);
}

/** The `report.rescore` executor: works the scores out again on the basis of the moment it runs. */
export async function runRescore(w: Scope, job: Job): Promise<JobOutcome> {
  await rebuildReports(w, job.projectId!);
  return {state: 'done'};
}

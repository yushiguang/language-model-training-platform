import type {Job, JobOutcome} from '@yushiguang/sprint-contracts';
import type {Scope} from './app.ts';
import {scoreFromState} from './evaluation.ts';
import {loadProjectState} from './projects.ts';
import {computeKey} from './queue.ts';
import {withLock} from './sources.ts';

/** How many times one Rescore follows a basis that moved while it ran. */
const FOLLOW = 3;

/**
 * Rescore (Evelyn, 2026-11-12; docs/design/server.md 4.3): only when someone presses it. Nothing
 * starts it by itself, since gold edits, thresholds and samples all move scores. Every version of
 * the current label, on the project's model, with saved answers on today's samples gets a fresh
 * report on today's basis, from saved answers only: nothing is labeled. A version missing answers
 * is skipped (scoring it again labels what is missing). One Rescore of a project runs at a time in
 * every process; a second one waits for it, and one whose basis moved while it ran goes again on
 * the new one. Returns how many reports it built.
 */
export async function rebuildReports(w: Scope, projectId: string): Promise<number> {
  return withLock(
    w,
    `rescore:${projectId}`,
    async () => {
      let built = 0;
      let done: string | null = null;
      for (let i = 0; i < FOLLOW; i++) {
        const state = await loadProjectState(w, projectId);
        if (!state?.setup?.schema || !state.scoring.ready || state.contextId === done) break;
        const models = new Set(state.setup.models.map(m => m.endpoint));
        const seen = new Set<string>();
        for (const r of state.runs.filter(x => x.state === 'done' && models.has(x.endpoint))) {
          const key = `${r.promptVersionId}|${r.endpoint}`;
          const v = state.versions.find(x => x.id === r.promptVersionId && x.schemaVersion === state.setup!.schemaVersion);
          if (!v || seen.has(key)) continue;
          seen.add(key);
          if (await scoreFromState(w, state, v, r.endpoint, {replace: true})) built++;
        }
        done = state.contextId;
      }
      w.emitChange(projectId);
      return built;
    },
    'Scores are being worked out again. Try again in a minute.',
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

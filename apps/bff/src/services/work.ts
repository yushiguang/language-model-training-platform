import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {busy, getApp, once} from './app.ts';
import {buildReport, labelEvalSet} from './evaluation.ts';
import {optimiserActive, runOptimiser} from './optimiser.ts';
import {loadProjectState} from './projects.ts';

/**
 * Background work that runs from the open page. The bff decides when labeling starts (system
 * triggers: a new version is scored, optimiser candidates); the labeling app runs the tasks.
 * Every step is idempotent, so calling `tick` again after a reload picks up where it was.
 */

/** Labels the eval set with a version on every chosen model, then scores it. */
export async function scoreVersion(projectId: string, version: PromptVersion, only?: EndpointId) {
  const state = (await loadProjectState(projectId))!;
  const models = state.setup!.models.filter(m => !only || m.endpoint === only);
  await Promise.all(
    models.map(m =>
      once(`label:${version.id}:${m.endpoint}`, async () => {
        const task = await labelEvalSet(projectId, state.setup!, version, m.endpoint, state.examples);
        if (task?.state !== 'done') return;
        const fresh = (await loadProjectState(projectId))!;
        await buildReport(projectId, fresh.setup!, version, m.endpoint, fresh.examples, fresh.gold, fresh.contextId);
      }),
    ),
  );
}

export async function tick(state: ProjectState) {
  const {catalog, labeling} = getApp();
  const projectId = state.project.id;

  // An optimiser loop left "running" by a closed page shows as paused.
  for (const o of state.optimisation) {
    if (o.state !== 'running' || optimiserActive(o.id) || busy('optimiser')) continue;
    const fresh = await catalog.get('optimisation_runs', o.id);
    if (fresh?.state === 'running' && !optimiserActive(o.id)) await catalog.patch('optimisation_runs', o.id, {state: 'paused'});
  }

  // System-started labeling (scoring, optimiser candidates) resumes by itself after a reload;
  // training sets wait for the user to press Resume.
  const tasks = await labeling.listTasks(projectId);
  for (const t of tasks) {
    if (t.purpose === 'training' || !(t.state === 'queued' || (t.state === 'paused' && t.stopReason === 'closed'))) continue;
    const v = state.versions.find(x => x.id === t.promptVersionId);
    if (v && state.setup?.models.some(m => m.endpoint === t.endpoint)) void scoreVersion(projectId, v, t.endpoint);
  }

  const latest = state.versions[0];
  if (!latest || !state.setup?.schema) return;
  for (const m of state.setup.models) {
    if (!state.runs.some(r => r.promptVersionId === latest.id && r.endpoint === m.endpoint)) void scoreVersion(projectId, latest, m.endpoint);
  }
  for (const r of state.runs.filter(r => r.state === 'done')) {
    if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint && !x.archivedNow)) continue;
    const v = state.versions.find(v => v.id === r.promptVersionId);
    if (v) void once(`report:${v.id}:${r.endpoint}`, () => buildReport(projectId, state.setup!, v, r.endpoint, state.examples, state.gold, state.contextId));
  }
  if (!state.setup.thresholds) return;
  const evalSize = state.snapshot?.split?.eval ?? 0;
  if (state.facts.goldEvalDone < evalSize || busy('optimiser')) return;
  for (const m of state.setup.models) {
    const current = state.reports.filter(r => r.endpoint === m.endpoint && !r.archivedNow);
    if (current.some(r => r.passed)) continue;
    const latestReport = current.find(r => r.promptVersionId === latest.id) ?? current[0];
    if (!latestReport) continue;
    const anchor = state.versions.find(v => v.madeBy !== 'optimiser') ?? latest;
    const already = state.optimisation.some(o => o.endpoint === m.endpoint && o.startedAt >= anchor.createdAt);
    if (already || state.optimisation.some(o => o.state === 'running')) continue;
    const paused = state.optimisation.find(o => o.endpoint === m.endpoint && (o.state === 'paused' || o.state === 'failed'));
    if (paused) continue;
    void once('optimiser', () => runOptimiser(projectId, m.endpoint));
    return;
  }
}

export function startOptimiser(projectId: string, endpoint: EndpointId) {
  void once('optimiser', async () => {
    const state = await loadProjectState(projectId);
    const resumable = state?.optimisation.find(o => o.endpoint === endpoint && o.state === 'paused');
    await runOptimiser(projectId, endpoint, 6, resumable);
  });
}

export const optimiserBusy = () => busy('optimiser');

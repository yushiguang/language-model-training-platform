import type {EndpointId, PromptVersion} from '../core/types';
import {getApp} from './app';
import {buildReport, isActive, runLabeling} from './evaluation';
import {optimiserActive, runOptimiser} from './optimiser';
import {loadProjectState, type ProjectState} from './projects';
import {busy, once} from './locks';

/**
 * Background work that runs from the open page: labeling runs, reports and the optimiser.
 * Every step is idempotent, so calling `tick` again after a reload picks up where it was.
 */

/** Labels the eval set with a version on every chosen model, then scores it. */
export async function scoreVersion(projectId: string, version: PromptVersion, only?: EndpointId) {
  const state = (await loadProjectState(projectId))!;
  const models = state.setup!.models.filter(m => !only || m.endpoint === only);
  await Promise.all(
    models.map(m =>
      once(`label:${version.id}:${m.endpoint}`, async () => {
        const existing = state.runs.find(r => r.promptVersionId === version.id && r.endpoint === m.endpoint);
        await runLabeling(projectId, state.setup!, version, m.endpoint, state.examples, existing);
        const fresh = (await loadProjectState(projectId))!;
        await buildReport(projectId, fresh.setup!, version, m.endpoint, fresh.examples, fresh.gold, fresh.contextId);
      }),
    ),
  );
}

export async function tick(state: ProjectState) {
  const {repo} = getApp();
  // Runs left "running" by a closed page are paused; Rerun resumes them.
  // Re-read each row first: the state passed in can be older than a run that just finished.
  for (const r of state.runs) {
    if (r.state !== 'running' || isActive(r.id) || busy(`label:${r.promptVersionId}:${r.endpoint}`)) continue;
    const now = await repo.get<typeof r>('labeling_runs', r.id);
    if (now?.state === 'running' && !isActive(r.id)) await repo.update('labeling_runs', {...now, state: 'paused'});
  }
  for (const o of state.optimisation) {
    if (o.state !== 'running' || optimiserActive(o.id)) continue;
    const now = await repo.get<typeof o>('optimisation_runs', o.id);
    if (now?.state === 'running' && !optimiserActive(o.id)) await repo.update('optimisation_runs', {...now, state: 'paused'});
  }

  const latest = state.versions[0];
  if (!latest || !state.setup?.schema) return;
  // A version with no run yet is labeled straight away.
  for (const m of state.setup.models) {
    if (!state.runs.some(r => r.promptVersionId === latest.id && r.endpoint === m.endpoint)) void scoreVersion(state.project.id, latest, m.endpoint);
  }
  // Reports for finished runs, once the eval set has gold labels.
  for (const r of state.runs.filter(r => r.state === 'done')) {
    if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint && !x.archivedNow)) continue;
    const v = state.versions.find(v => v.id === r.promptVersionId);
    if (v) void once(`report:${v.id}:${r.endpoint}`, () => buildReport(state.project.id, state.setup!, v, r.endpoint, state.examples, state.gold, state.contextId));
  }
  // The optimiser starts by itself once the eval set is labeled and the latest version is below.
  if (!state.setup.thresholds) return;
  const evalSize = state.snapshot?.split?.eval ?? 0;
  if (state.facts.goldEvalDone < evalSize || busy('optimiser')) return;
  for (const m of state.setup.models) {
    const current = state.reports.filter(r => r.endpoint === m.endpoint && !r.archivedNow);
    if (current.some(r => r.passed)) continue;
    const latestReport = current.find(r => r.promptVersionId === latest.id) ?? current[0];
    if (!latestReport) continue;
    // Once per version a person or the prompt agent made; the optimiser's own versions don't restart it.
    const anchor = state.versions.find(v => v.madeBy !== 'optimiser') ?? latest;
    const already = state.optimisation.some(o => o.endpoint === m.endpoint && o.startedAt >= anchor.createdAt);
    if (already || state.optimisation.some(o => o.state === 'running')) continue;
    void once('optimiser', () => runOptimiser(state.project.id, m.endpoint));
    return;
  }
}

export function startOptimiser(projectId: string, endpoint: EndpointId) {
  void once('optimiser', () => runOptimiser(projectId, endpoint));
}

export const optimiserBusy = () => busy('optimiser');

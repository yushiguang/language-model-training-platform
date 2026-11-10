import type {EndpointId, PromptVersion} from '../../../../packages/contracts/src/types';
import type {ProjectState} from '../../../../packages/contracts/src/workflow';
import {getApp} from './app';
import {buildReport, isActive, runLabeling} from './evaluation';
import {busy, once} from './locks';
import {optimiserActive, runOptimiser} from './optimiser';
import {loadProjectState} from './projects';
import {isTrainingActive} from './training';

/**
 * Background work that runs from the open page: labeling runs, reports, optimiser and training set runs.
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
  for (const ts of state.trainingSets) {
    if (ts.state !== 'running' || isTrainingActive(ts.id) || busy(`training:${ts.id}`)) continue;
    const now = await repo.get<typeof ts>('training_sets', ts.id);
    if (now?.state === 'running' && !isTrainingActive(ts.id)) await repo.update('training_sets', {...now, state: 'paused'});
  }

  const latest = state.versions[0];
  if (!latest || !state.setup?.schema) return;
  for (const m of state.setup.models) {
    if (!state.runs.some(r => r.promptVersionId === latest.id && r.endpoint === m.endpoint)) void scoreVersion(state.project.id, latest, m.endpoint);
  }
  for (const r of state.runs.filter(r => r.state === 'done')) {
    if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint && !x.archivedNow)) continue;
    const v = state.versions.find(v => v.id === r.promptVersionId);
    if (v) void once(`report:${v.id}:${r.endpoint}`, () => buildReport(state.project.id, state.setup!, v, r.endpoint, state.examples, state.gold, state.contextId));
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
    void once('optimiser', () => runOptimiser(state.project.id, m.endpoint));
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

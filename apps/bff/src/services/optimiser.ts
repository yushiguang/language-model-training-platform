import type {EndpointId, OptimisationRun, PromptVersion} from '@tsp/contracts';
import {checkTemplate, newId, placeholderKeys} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';
import {buildReport, labelEvalSet, scoreOnOptimiserHalf} from './evaluation.ts';
import {loadProjectState} from './projects.ts';
import {createVersion} from './prompts.ts';

const active = new Map<string, AbortController>();
export const optimiserActive = (id: string) => active.has(id);
export const stopOptimiser = (id: string) => active.get(id)?.abort();

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A GEPA-style loop that runs from the open page: take the best version on the optimiser's
 * half of the eval set, ask the agent runtime for one targeted change, keep the placeholders
 * as they are, save it as a minor version and label it as an optimiser labeling task.
 */
export async function runOptimiser(projectId: string, endpoint: EndpointId, budgetCandidates = 6, resume?: OptimisationRun): Promise<OptimisationRun> {
  const {catalog, agents, gateway} = getApp();
  let state = (await loadProjectState(projectId))!;
  const evalCount = state.examples.filter(e => e.split === 'eval').length;
  const run: OptimisationRun = resume
    ? {...resume, state: 'running', error: null}
    : {
        id: newId('op'),
        projectId,
        endpoint,
        startVersionId: state.versions[0].id,
        state: 'running',
        budgetCalls: budgetCandidates * evalCount,
        calls: 0,
        candidates: 0,
        costUsd: 0,
        stopReason: null,
        error: null,
        startedAt: now(),
        finishedAt: null,
      };
  if (resume) await catalog.patch('optimisation_runs', run.id, {state: 'running', error: null});
  else await catalog.insert('optimisation_runs', run);
  const ctrl = new AbortController();
  active.set(run.id, ctrl);
  emitChange();
  let wasted = 0;
  try {
    while (run.calls < run.budgetCalls) {
      if (wasted >= 3) {
        run.stopReason = 'no_new_ideas';
        break;
      }
      if (ctrl.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      state = (await loadProjectState(projectId))!;
      const setup = state.setup!;
      if (state.reports.some(r => r.endpoint === endpoint && r.passed)) {
        run.stopReason = 'passes';
        break;
      }
      let parent: PromptVersion = state.versions[0];
      let parentScore = -1;
      let parentMetrics = null;
      for (const v of state.versions.filter(v => v.schemaVersion === setup.schemaVersion)) {
        const m = await scoreOnOptimiserHalf(setup, v, endpoint, state.examples, state.gold);
        if (m.n && m.lowestField.macroF1 > parentScore) [parent, parentScore, parentMetrics] = [v, m.lowestField.macroF1, m];
      }
      if (!parentMetrics) {
        // The parent is not labeled yet (or another tab is labeling it): label it, then look again.
        const t = await labelEvalSet(projectId, setup, parent, endpoint, state.examples, 'optimiser');
        if (!t) await wait(1000);
        else if (t.state !== 'done') throw new Error(t.error ?? 'Labeling stopped');
        continue;
      }
      const out = await agents.reflectPrompt(
        {
          template: parent.template,
          schema: setup.schema!,
          triedChanges: state.versions.filter(v => v.parentId === parent.id).map(v => v.change),
          mixUps: parentMetrics.mixUps,
          lowestField: parentMetrics.lowestField,
          lowestValue: parentMetrics.lowestValue,
          signal: ctrl.signal,
        },
        gateway.agentModel(),
      );
      const same = [...placeholderKeys(out.template)].sort().join() === [...placeholderKeys(parent.template)].sort().join();
      if (!same || checkTemplate(out.template, parent.features).errors.length || state.versions.some(v => v.template === out.template)) {
        run.candidates++;
        wasted++;
        continue;
      }
      const cand = await createVersion(projectId, {
        template: out.template,
        features: parent.features,
        images: parent.images,
        parent,
        madeBy: 'optimiser',
        change: out.change,
        kind: 'minor',
        schema: setup.schema!,
        schemaVersion: setup.schemaVersion,
      });
      run.candidates++;
      const task = await labelEvalSet(projectId, setup, cand, endpoint, state.examples, 'optimiser');
      if (!task) throw new Error('Another tab is labeling this candidate.');
      run.calls += task.total;
      run.costUsd += task.costUsd;
      await catalog.patch('optimisation_runs', run.id, {calls: run.calls, candidates: run.candidates, costUsd: run.costUsd});
      emitChange();
      if (task.state !== 'done') throw new Error(task.error ?? 'Labeling stopped');
      const fresh = (await loadProjectState(projectId))!;
      await buildReport(projectId, setup, cand, endpoint, fresh.examples, fresh.gold, fresh.contextId);
    }
    run.state = 'done';
    run.stopReason ??= 'budget';
  } catch (e) {
    const stopped = (e as Error).name === 'AbortError';
    run.state = stopped ? 'stopped' : 'failed';
    run.stopReason = stopped ? 'user' : null;
    run.error = stopped ? null : `Last error: ${(e as Error).message}. Versions kept so far are saved.`;
  } finally {
    run.finishedAt = now();
    const {id: _id, ...rest} = run;
    await catalog.patch('optimisation_runs', run.id, rest);
    active.delete(run.id);
    emitChange();
  }
  return run;
}

import {placeholderKeys, checkTemplate} from '../core/template';
import type {EndpointId, OptimisationRun, PromptVersion} from '../core/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {buildReport, runLabeling, scoreOnOptimiserHalf} from './evaluation';
import {loadProjectState} from './projects';
import {createVersion} from './prompts';
import {systemPrompt} from './agentPresets';
import {once} from './locks';

const active = new Map<string, AbortController>();
export const optimiserActive = (id: string) => active.has(id);
export const stopOptimiser = (id: string) => active.get(id)?.abort();

/**
 * A GEPA-style loop that runs from the open page: take the best version on the optimiser's
 * half of the eval set, ask the reflection model for one targeted change, keep the
 * placeholders as they are, save it as a minor version and score it. Stops when a version
 * passes, when the budget is spent, or when the user presses Stop.
 */
export async function runOptimiser(projectId: string, endpoint: EndpointId, budgetCandidates = 6, resume?: OptimisationRun): Promise<OptimisationRun> {
  const {repo, platform} = getApp();
  let state = (await loadProjectState(projectId))!;
  const evalCount = state.examples.filter(e => e.split === 'eval').length;
  const run: OptimisationRun = resume
    ? {...resume, state: 'running', error: null}
    : {id: newId('op'), projectId, endpoint, startVersionId: state.versions[0].id, state: 'running', budgetCalls: budgetCandidates * evalCount, calls: 0, candidates: 0, costUsd: 0, stopReason: null, error: null, startedAt: now(), finishedAt: null};
  if (resume) await repo.update('optimisation_runs', run);
  else await repo.insert('optimisation_runs', run);
  const ctrl = new AbortController();
  active.set(run.id, ctrl);
  emitChange();
  // Ideas the reflection model returned that gave no new prompt; bounds the loop when it runs dry.
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
      // Parent = best version on the optimiser half (the held-out half is never looked at here).
      let parent: PromptVersion = state.versions[0];
      let parentScore = -1;
      let parentMetrics = null;
      for (const v of state.versions.filter(v => v.schemaVersion === setup.schemaVersion)) {
        const m = await scoreOnOptimiserHalf(setup, v, endpoint, state.examples, state.gold);
        if (m.n && m.lowestField.macroF1 > parentScore) [parent, parentScore, parentMetrics] = [v, m.lowestField.macroF1, m];
      }
      if (!parentMetrics) {
        const r = await once(`label:${parent.id}:${endpoint}`, () => runLabeling(projectId, setup, parent, endpoint, state.examples, state.runs.find(x => x.promptVersionId === parent.id && x.endpoint === endpoint)));
        if (!r) await new Promise(res => setTimeout(res, 1000));
        continue;
      }
      const raw = await platform.agent.chat(
        [
          {role: 'system', content: systemPrompt('optimiser')},
          {role: 'user', content: JSON.stringify({preset: 'optimiser', intent: 'reflect', context: {template: parent.template, schema: setup.schema, tried: state.versions.filter(v => v.parentId === parent.id).map(v => v.change), mixUps: parentMetrics.mixUps.slice(0, 6), lowestField: parentMetrics.lowestField, lowestValue: parentMetrics.lowestValue}})},
        ],
        {json: true, signal: ctrl.signal},
      );
      const out = JSON.parse(raw) as {template: string; change: string};
      const same = [...placeholderKeys(out.template)].sort().join() === [...placeholderKeys(parent.template)].sort().join();
      const all = (await loadProjectState(projectId))!.versions;
      // A changed placeholder set, a broken template or a prompt we already have is not a new candidate.
      if (!same || checkTemplate(out.template, parent.features).errors.length || all.some(v => v.template === out.template)) {
        run.candidates++;
        wasted++;
        continue;
      }
      const cand = await createVersion(projectId, all, {
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
      const lr = (await once(`label:${cand.id}:${endpoint}`, () => runLabeling(projectId, setup, cand, endpoint, state.examples)))!;
      run.calls += lr.total;
      run.costUsd += lr.costUsd;
      await repo.update('optimisation_runs', run);
      emitChange();
      if (lr.state !== 'done') throw new Error(lr.error ?? 'Labeling stopped');
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
    // Save the end state before dropping the run from `active`, so `tick` never sees it as a closed page's run.
    await repo.update('optimisation_runs', run);
    active.delete(run.id);
    emitChange();
  }
  return run;
}

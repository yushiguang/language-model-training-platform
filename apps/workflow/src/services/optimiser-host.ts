import type {OptimiserHost, ProjectState, PromptVersion, RequestContext} from '@yushiguang/sprint-contracts';
import {visibleToAgents} from '@yushiguang/sprint-domain';
import type {Instance, Scope} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, confirmScore, labelEvalSet, labelExamples, scoreOnOptimiserHalf} from './evaluation.ts';
import {labelComments} from './mismatches.ts';

import {exampleFeatures} from './features.ts';
import {loadProjectState} from './projects.ts';
import {createVersion} from './prompts.ts';

/**
 * What the workflow does for the Optimiser service (`OptimiserHost`): the Optimiser decides what
 * to try; labeling, scoring and saving a version go through the same code as every other path.
 * Every call runs in the scope of the context it carries: the run's, which is the `optimiser.run`
 * job's caller (the person who started the run). The scope reads the instance when called, so the
 * Optimiser can be connected after.
 */
export function optimiserHost(inst: Instance): OptimiserHost {
  const at = (ctx: RequestContext): Scope => inst.scope(ctx);
  const loaded = async (w: Scope, projectId: string) => {
    const state = await loadProjectState(w, projectId);
    if (!state?.setup) throw new Error('The project or its setup was not found.');
    return {state, setup: state.setup};
  };
  const version = (state: ProjectState, id: string): PromptVersion => {
    const v = state.versions.find(x => x.id === id);
    if (!v) throw new Error('The version was not found.');
    return v;
  };
  return {
    loadState: (ctx, projectId) => loadProjectState(at(ctx), projectId),
    async label(ctx, {projectId, promptVersionId, endpoint, exampleIds, pass}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      const v = version(state, promptVersionId);
      return exampleIds ? labelExamples(w, projectId, setup, v, endpoint, exampleIds, 'optimiser', {pass}) : labelEvalSet(w, projectId, setup, v, endpoint, state.examples, 'optimiser', {});
    },
    async score(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      const report = await buildReport(w, projectId, setup, version(state, promptVersionId), endpoint, state.examples, state.gold, state.contextId);
      if (!report) return null;
      const after = (await loadProjectState(w, projectId))!;
      return {report, passed: after.reports.some(r => r.id === report.id && r.passed)};
    },
    async confirmScore(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      return confirmScore(w, setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
    },
    async halfScore(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      const m = await scoreOnOptimiserHalf(w, setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
      return {mixUps: m.mixUps, macroF1: m.macroF1, lowestValue: m.lowestValue};
    },
    async createVersion(ctx, {projectId, structured, parentId, change, inMajor}) {
      const w = at(ctx);
      const {state} = await loaded(w, projectId);
      return createVersion(w, projectId, {structured, parent: version(state, parentId), madeBy: 'optimiser', change, kind: 'minor', inMajor});
    },
    async labelComments(ctx, projectId) {
      const w = at(ctx);
      const {state} = await loaded(w, projectId);
      return Object.fromEntries(await labelComments(w, projectId, state));
    },
    async exampleFeatures(ctx, projectId, exampleIds) {
      // The Optimiser learns from the optimiser half only: held-out examples are never read here.
      const w = at(ctx);
      const {state} = await loaded(w, projectId);
      const ok = new Set(state.examples.filter(visibleToAgents).map(e => e.id));
      return exampleFeatures(w, projectId, exampleIds.filter(id => ok.has(id)));
    },
    postEvent: (ctx, {projectId, event, actor, what, link}) => postEvent(at(ctx), projectId, event, actor, what, link),
  };
}

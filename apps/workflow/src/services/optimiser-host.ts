import type {OptimiserHost, ProjectState, PromptVersion} from '@sprint/contracts';
import type {Scope} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, confirmScore, labelEvalSet, labelExamples, scoreOnOptimiserHalf} from './evaluation.ts';
import {labelComments} from './mismatches.ts';

import {loadProjectState} from './projects.ts';
import {createVersion} from './prompts.ts';

/**
 * What the workflow does for the Optimiser service (`OptimiserHost`): the Optimiser decides what
 * to try; labeling, scoring and saving a version go through the same code as every other path.
 * `createWorkflow` builds it with a system scope (caller `optimiser`), and the composition root
 * passes it to `createOptimiser`; the scope reads the instance when called, so the Optimiser can
 * be connected after.
 */
export function optimiserHost(w: Scope): OptimiserHost {
  const loaded = async (projectId: string) => {
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
    loadState: projectId => loadProjectState(w, projectId),
    async label({projectId, promptVersionId, endpoint, exampleIds, pass}) {
      const {state, setup} = await loaded(projectId);
      const v = version(state, promptVersionId);
      return exampleIds ? labelExamples(w, projectId, setup, v, endpoint, exampleIds, 'optimiser', {pass}) : labelEvalSet(w, projectId, setup, v, endpoint, state.examples, 'optimiser', {});
    },
    async score({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      const report = await buildReport(w, projectId, setup, version(state, promptVersionId), endpoint, state.examples, state.gold, state.contextId);
      if (!report) return null;
      const after = (await loadProjectState(w, projectId))!;
      return {report, passed: after.reports.some(r => r.id === report.id && r.passed)};
    },
    async confirmScore({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      return confirmScore(w, setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
    },
    async halfScore({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      const m = await scoreOnOptimiserHalf(w, setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
      return {mixUps: m.mixUps, macroF1: m.macroF1, lowestValue: m.lowestValue};
    },
    async createVersion({projectId, structured, parentId, change, inMajor}) {
      const {state} = await loaded(projectId);
      return createVersion(w, projectId, {structured, parent: version(state, parentId), madeBy: 'optimiser', change, kind: 'minor', inMajor});
    },
    async labelComments(projectId) {
      const {state} = await loaded(projectId);
      return Object.fromEntries(await labelComments(w, projectId, state));
    },
    postEvent: ({projectId, event, actor, what, link}) => postEvent(w, projectId, event, actor, what, link),
  };
}

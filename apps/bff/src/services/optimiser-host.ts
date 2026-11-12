import type {OptimisationRun, OptimiserHost, ProjectState, PromptVersion} from '@tsp/contracts';
import {versionLabel} from '@tsp/domain';
import {emitChange, getApp, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, confirmScore, labelEvalSet, labelExamples, scoreOnOptimiserHalf} from './evaluation.ts';
import {labelerNotes} from './mismatches.ts';
import {agentTools} from './page-views.ts';
import {approveNode, loadProjectState} from './projects.ts';
import {createVersion} from './prompts.ts';
import {startTrainingSet} from './training.ts';

/**
 * What the bff does for the Optimiser service (`OptimiserHost`): the Optimiser decides what to
 * try; labeling, scoring and saving a version go through the same code as every other path.
 * The composition root passes this to `createOptimiser`; it reads the bff's own dependencies
 * when called, so it can be built before `configureBff` runs.
 */
export function optimiserHost(): OptimiserHost {
  const loaded = async (projectId: string) => {
    const state = await loadProjectState(projectId);
    if (!state?.setup) throw new Error('The project or its setup was not found.');
    return {state, setup: state.setup};
  };
  const version = (state: ProjectState, id: string): PromptVersion => {
    const v = state.versions.find(x => x.id === id);
    if (!v) throw new Error('The version was not found.');
    return v;
  };
  return {
    loadState: loadProjectState,
    async label({projectId, promptVersionId, endpoint, exampleIds, pass}) {
      const {state, setup} = await loaded(projectId);
      const v = version(state, promptVersionId);
      return exampleIds ? labelExamples(projectId, setup, v, endpoint, exampleIds, 'optimiser', {pass}) : labelEvalSet(projectId, setup, v, endpoint, state.examples, 'optimiser', {});
    },
    async score({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      const report = await buildReport(projectId, setup, version(state, promptVersionId), endpoint, state.examples, state.gold, state.contextId);
      if (!report) return null;
      const after = (await loadProjectState(projectId))!;
      return {report, passed: after.reports.some(r => r.id === report.id && r.passed)};
    },
    async confirmScore({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      return confirmScore(setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
    },
    async halfScore({projectId, promptVersionId, endpoint}) {
      const {state, setup} = await loaded(projectId);
      const m = await scoreOnOptimiserHalf(setup, version(state, promptVersionId), endpoint, state.examples, state.gold);
      return {mixUps: m.mixUps, lowestField: m.lowestField, lowestValue: m.lowestValue};
    },
    async createVersion({projectId, template, features, images, parentId, change, inMajor}) {
      const {state, setup} = await loaded(projectId);
      return createVersion(projectId, {template, features, images, parent: version(state, parentId), madeBy: 'optimiser', change, kind: 'minor', inMajor, schema: setup.schema!, schemaVersion: setup.schemaVersion});
    },
    async labelerNotes(projectId) {
      const {state} = await loaded(projectId);
      return Object.fromEntries(await labelerNotes(projectId, state));
    },
    tools: agentTools,
    postEvent: ({projectId, event, actor, what, link}) => postEvent(projectId, event, actor, what, link),
    async versionPassed({projectId, runId, promptVersionId, endpoint}) {
      const {state} = await loaded(projectId);
      const run = state.optimisation.find(o => o.id === runId);
      if (run) await afterPass({...run, projectId, endpoint}, version(state, promptVersionId));
    },
  };
}

/**
 * A version passed: the Prompt step is approved and the training and test sets start with it
 * (test examples without a gold label get the model's answers too). Said in Ask AI.
 */
async function afterPass(run: OptimisationRun, v: PromptVersion): Promise<void> {
  const {catalog} = getApp();
  const state: ProjectState | null = await loadProjectState(run.projectId);
  if (!state) return;
  const report = state.reports.find(r => r.promptVersionId === v.id && r.endpoint === run.endpoint && !r.archivedNow) ?? null;
  try {
    if (!state.project.approvedNodes.includes('prompt')) await approveNode(run.projectId, 'prompt');
    const ts = await startTrainingSet(run.projectId, v, run.endpoint, report, 0, {labelTest: true});
    await catalog.patch('optimisation_runs', run.id, {trainingSetId: ts.id});
    emitChange();
    tm().counter('tsp_auto_starts_total', {what: 'training_after_pass', decision: 'started'});
    await postEvent(run.projectId, 'auto', 'workflow', `started the training and test sets with ${versionLabel(v)}`, {path: '/training-set'});
  } catch (e) {
    await postEvent(run.projectId, 'auto', 'workflow', `could not start the training set: ${(e as Error).message}`, {path: '/training-set'});
  }
}

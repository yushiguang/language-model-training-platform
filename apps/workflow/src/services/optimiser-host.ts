import type {OptimiserHost, PermissionPoint, ProjectState, PromptVersion, RequestContext} from '@yushiguang/sprint-contracts';
import {scoredExamples, visibleToAgents} from '@yushiguang/sprint-domain';
import type {Instance, Scope} from './app.ts';
import {authorize} from './access.ts';
import {postEvent} from './chat-events.ts';
import {confirmScore, labelEvalSet, labelExamples, scoreFromState, scoreOnOptimiserHalf} from './evaluation.ts';
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
  return guardHost(inst, hostCalls(inst));
}

/**
 * What each host call needs: project write for all of them. Only a run calls the host, and a run
 * edits the project and spends money, so a caller who lost project write is stopped at the first
 * call of a round, before its paid helper call, not only once it saves a version.
 */
const HOST_PERMISSIONS: {[K in keyof OptimiserHost]: PermissionPoint} = {
  loadState: 'project_write',
  exampleFeatures: 'project_write',
  labelComments: 'project_write',
  halfScore: 'project_write',
  label: 'project_write',
  score: 'project_write',
  confirmScore: 'project_write',
  createVersion: 'project_write',
  postEvent: 'project_write',
};

/** Each call checked as the run's caller, like every other call (docs/design/server.md, 2.2). */
function guardHost(inst: Instance, raw: OptimiserHost): OptimiserHost {
  const out = {} as Record<string, unknown>;
  for (const name of Object.keys(raw) as (keyof OptimiserHost)[]) {
    const fn = raw[name] as (ctx: RequestContext, ...a: unknown[]) => Promise<unknown>;
    out[name] = async (ctx: RequestContext, ...a: unknown[]) => {
      const first = a[0];
      const projectId = typeof first === 'string' ? first : (first as {projectId: string}).projectId;
      await authorize(inst.scope(ctx), `optimiser.${name}`, HOST_PERMISSIONS[name], projectId);
      return fn(ctx, ...a);
    };
  }
  return out as unknown as OptimiserHost;
}

function hostCalls(inst: Instance): OptimiserHost {
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
      // Until the chain lands (#79), the labeling still runs here, inside the run's job.
      const t = exampleIds ? await labelExamples(w, projectId, setup, v, endpoint, exampleIds, 'optimiser', {pass}) : await labelEvalSet(w, projectId, setup, v, endpoint, state.examples, 'optimiser', {});
      if (!t) return {state: 'unfinished', task: null, error: 'another runner is labeling this version'};
      return t.state === 'done' ? {state: 'done', task: t} : {state: 'unfinished', task: t, error: t.error ?? `labeling ended as ${t.state}`};
    },
    async score(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state} = await loaded(w, projectId);
      const report = await scoreFromState(w, state, version(state, promptVersionId), endpoint);
      if (!report) return null;
      const after = (await loadProjectState(w, projectId))!;
      return {report, passed: after.reports.some(r => r.id === report.id && r.passed)};
    },
    async confirmScore(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      return confirmScore(w, setup, version(state, promptVersionId), endpoint, scoredExamples(state), state.gold);
    },
    async halfScore(ctx, {projectId, promptVersionId, endpoint}) {
      const w = at(ctx);
      const {state, setup} = await loaded(w, projectId);
      const m = await scoreOnOptimiserHalf(w, setup, version(state, promptVersionId), endpoint, scoredExamples(state), state.gold);
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

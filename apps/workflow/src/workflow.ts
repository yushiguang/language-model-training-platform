import type {AgentProgressPort, AgentToolHost, EventStreamPort, EventTopic, JobExecutor, OptimiserHost, RequestContext, WorkflowContract} from '@yushiguang/sprint-contracts';
import {createInstance, systemContext, type Connected, type Scope, type WorkflowDeps} from './services/app.ts';
import * as agents from './services/agents.ts';
import * as dataset from './services/dataset.ts';
import * as evaluation from './services/evaluation.ts';
import * as features from './services/features.ts';
import * as mismatch from './services/mismatches.ts';
import * as governance from './services/governance.ts';
import * as projects from './services/projects.ts';
import * as prompts from './services/prompts.ts';
import * as settings from './services/settings.ts';
import * as sources from './services/sources.ts';
import * as work from './services/work.ts';
import {answerProblem} from '@yushiguang/sprint-domain';
import {agentToolHost} from './services/page-views.ts';
import {optimiserHost} from './services/optimiser-host.ts';
import {workflowExecutors} from './services/executors.ts';

/**
 * The application module (`@yushiguang/sprint-workflow`, deployment readiness spec, 2): everything a channel
 * needs, as `WorkflowContract`, with the caller's `RequestContext` first on every method. Each
 * method takes ids and the caller's input, reads the records itself, and returns plain JSON.
 *
 * A factory with no module-level state: each `createWorkflow` is its own instance, and who acts
 * comes from the context of each call. Short-lived state every instance must see sits behind
 * `deps.sharedState`, and so do the projects' revisions (review G9); what cannot be serialised (a
 * running turn's progress handlers) stays with the instance until the agent service (spec 6).
 */
export interface Workflow {
  api: WorkflowContract;
  /** `changes` and `agent_live`, data-free: a listener reads again through the contract. */
  events: EventStreamPort;
  /**
   * Some record changed outside the workflow (labeling, the Optimiser): tells the listeners and,
   * with the project, gives it a new revision.
   */
  changed(projectId?: string): void;
  /**
   * For the agent runtime: the helpers' tools. One host for every project; each call names its
   * project, turn and context, and the host enforces the guards (deployment readiness spec, 6).
   */
  toolHost: AgentToolHost;
  /** For the agent runtime: where a turn's progress goes. */
  agentProgress: AgentProgressPort;
  /** For the Optimiser: labeling, scoring and saving versions through the workflow's own code. */
  optimiserHost: OptimiserHost;
  /** Waits for the Ask AI turns this instance accepted to end (tests, and a server that drains). */
  turnsIdle(): Promise<void>;
  /** Hands over the services built after the workflow, since they call back into it. */
  connect(c: Connected): void;
  /**
   * The work the workflow owns, for the job module of the process that runs jobs:
   * `report.build`, `dataset.sample`, `source.ingest` and `project.delete`. Each runs as the job's caller.
   */
  executors: JobExecutor[];
  /**
   * A server's cron job (review G8): checks every project for work that should run and queues it,
   * as the pages' `tick` does in the browser build.
   */
  sweep(): Promise<void>;
}

export function createWorkflow(deps: WorkflowDeps): Workflow {
  const inst = createInstance(deps);
  const at = (ctx: RequestContext): Scope => inst.scope(ctx);

  /** The project's state, or an error a client can show. */
  const stateOf = async (w: Scope, projectId: string) => {
    const state = await projects.loadProjectState(w, projectId);
    if (!state) throw new Error('This project does not exist.');
    return state;
  };
  const versionOf = async (w: Scope, projectId: string, promptVersionId: string) => {
    const v = await w.catalog.get('prompt_versions', promptVersionId);
    if (!v || v.projectId !== projectId) throw new Error('This version does not exist.');
    return v;
  };
  const withSchema = async (w: Scope, projectId: string) => {
    const state = await stateOf(w, projectId);
    if (!state.setup?.schema) throw new Error('Approve the prompt on Prompt Design first.');
    return {state, schema: state.setup.schema, schemaVersion: state.setup.schemaVersion};
  };

  /** A gold label a person gives must be for an example of the project's eval dataset, and an answer to its label. */
  const checkGold = async (w: Scope, projectId: string, exampleId: string, answer: string[] | undefined) => {
    const state = await stateOf(w, projectId);
    if (!state.examples.some(e => e.id === exampleId)) throw new Error('This example does not exist.');
    if (!state.setup?.schema) throw new Error('Approve the prompt on Prompt Design first.');
    const problem = answer ? answerProblem(answer, state.setup.schema) : null;
    if (problem) throw new Error(`${problem}.`);
  };

  const api: WorkflowContract = {
    async runtimeInfo(ctx) {
      const w = at(ctx);
      return {standIns: w.standIns, endpoints: w.gateway.labelingEndpoints(), hasBundledGold: dataset.hasBundledGold(w)};
    },

    listProjects: ctx => projects.listProjects(at(ctx)),
    createProject: (ctx, name) => projects.createProject(at(ctx), name),
    getProject: (ctx, id) => projects.getProject(at(ctx), id),
    loadProjectState: (ctx, projectId) => projects.loadProjectState(at(ctx), projectId),
    projectStatus: (ctx, projectId) => projects.projectStatus(at(ctx), projectId),
    approveNode: (ctx, projectId, node) => projects.approveNode(at(ctx), projectId, node),
    deleteProject: (ctx, r) => projects.deleteProject(at(ctx), r.projectId),
    renameProject: (ctx, r) => projects.renameProject(at(ctx), r.projectId, r.name),
    async tick(ctx, {projectId}) {
      const w = at(ctx);
      const state = await projects.loadProjectState(w, projectId);
      if (state) await work.tick(w, state);
    },

    saveSettings: (ctx, {projectId, ...s}) => settings.saveSettings(at(ctx), projectId, s),

    listDataSources: ctx => sources.listDataSources(at(ctx)),
    getDataSource: (ctx, sourceId) => sources.getDataSource(at(ctx), sourceId),
    createDataSource: (ctx, r) => sources.createDataSource(at(ctx), r),
    addSourceFile: (ctx, r) => sources.addSourceFile(at(ctx), r),

    exampleMedia: (ctx, projectId, exampleId) => dataset.exampleMedia(at(ctx), projectId, exampleId),
    async getExampleFeatures(ctx, projectId, exampleIds) {
      const w = at(ctx);
      if (!(await projects.getProject(w, projectId))) throw new Error('This project does not exist.');
      return features.exampleFeatures(w, projectId, exampleIds);
    },
    takeExamples: (ctx, r) => dataset.takeExamples(at(ctx), r.projectId, r.picks),
    stopSampleDataset: (ctx, projectId) => dataset.stopSampleDataset(at(ctx), projectId),
    async removeExamples(ctx, {projectId, exampleIds, reason}) {
      await governance.removeExamples(at(ctx), projectId, exampleIds, reason);
    },
    restoreExamples: (ctx, r) => governance.restoreExamples(at(ctx), r.projectId, r.removalIds),
    pruneDataset: (ctx, r) => governance.pruneDataset(at(ctx), r.projectId, r.mode, r.keep, r.value),
    addComment: (ctx, r) => governance.addComment(at(ctx), r.projectId, r.exampleId, r.text, r.promptVersionId ?? null),
    async saveGold(ctx, projectId, exampleId, schemaVersion, answer, revealed, source) {
      const w = at(ctx);
      await checkGold(w, projectId, exampleId, answer);
      return dataset.saveGold(w, projectId, exampleId, schemaVersion, answer, revealed, source);
    },
    async uploadGold(ctx, {projectId, lines}) {
      const w = at(ctx);
      const {state, schema, schemaVersion} = await withSchema(w, projectId);
      return dataset.uploadGold(w, projectId, schema, schemaVersion, state.examples, lines);
    },
    async uploadGoldText(ctx, projectId, name, text) {
      const w = at(ctx);
      const {state, schema, schemaVersion} = await withSchema(w, projectId);
      return dataset.uploadGoldText(w, projectId, schema, schemaVersion, state.examples, name, text);
    },
    async importBundledGold(ctx, projectId) {
      const w = at(ctx);
      const {state, schema, schemaVersion} = await withSchema(w, projectId);
      return dataset.importBundledGold(w, projectId, schema, schemaVersion, state.examples);
    },
    mismatches: (ctx, projectId, versionId) => mismatch.mismatches(at(ctx), projectId, versionId),
    async reviewGold(ctx, r) {
      const w = at(ctx);
      if (r.outcome === 'changed') await checkGold(w, r.projectId, r.exampleId, r.answer);
      return mismatch.reviewGold(w, r.projectId, r.exampleId, r.promptVersionId, r.outcome, r.answer, r.note);
    },
    rebuildReports: (ctx, projectId) => mismatch.rebuildReports(at(ctx), projectId),

    async createVersion(ctx, r) {
      const w = at(ctx);
      await stateOf(w, r.projectId);
      const parent = r.parentId ? await versionOf(w, r.projectId, r.parentId) : null;
      return prompts.createVersion(w, r.projectId, {structured: r.structured, parent, madeBy: r.madeBy, change: r.change, kind: r.kind});
    },
    async scoreVersion(ctx, r) {
      const w = at(ctx);
      return work.scoreVersion(w, r.projectId, await versionOf(w, r.projectId, r.promptVersionId), r.endpoint);
    },
    stopRun: (ctx, r) => evaluation.stopRun(at(ctx), r.projectId, r.runId),
    startOptimiser: (ctx, r) => work.startOptimiser(at(ctx), r.projectId, r.maxRounds, r.startVersionId),
    stopOptimiser: (ctx, r) => work.stopOptimiser(at(ctx), r.projectId, r.runId),
    retryOptimiser: (ctx, r) => work.retryOptimiser(at(ctx), r.projectId, r.runId),
    improveWithAi: (ctx, projectId, versionId, locale) => agents.improveWithAi(at(ctx), projectId, versionId, locale).then(() => undefined),
    featureInfo: (ctx, keys) => prompts.featureInfo(at(ctx), keys),
    async predictionsFor(ctx, projectId, versionId, endpoint, s) {
      const w = at(ctx);
      await versionOf(w, projectId, versionId);
      return Object.fromEntries(await evaluation.predictionsFor(w, versionId, endpoint, s));
    },

    chatHistory: (ctx, projectId) => agents.chatHistory(at(ctx), projectId),
    getAgentLive: (ctx, projectId) => agents.agentLive(at(ctx), projectId),
    getAnsweringAgent: (ctx, projectId, page) => agents.answeringAgent(at(ctx), projectId, page),
    sendUserMessage: (ctx, r) => agents.sendUserMessage(at(ctx), r.projectId, r.text, r.page, r.attachments, false, {locale: r.locale ?? ctx.locale, client: r.client}),
    openProposals: (ctx, projectId) => agents.openProposals(at(ctx), projectId),
    proposals: (ctx, projectId) => agents.proposals(at(ctx), projectId),
    async closeProposal(ctx, {projectId, proposalId, decision}) {
      const w = at(ctx);
      const p = await w.catalog.get('agent_proposals', proposalId);
      if (!p || p.projectId !== projectId) throw new Error('This suggestion does not exist.');
      await agents.closeProposal(w, p, decision);
    },
  };

  return {
    api,
    events: {
      subscribe: (topic: EventTopic, listener: () => void) => (topic === 'changes' ? inst.onChange(listener) : inst.onLive(listener)),
    },
    changed: projectId => inst.emitChange(projectId ?? null),
    toolHost: agentToolHost(inst),
    agentProgress: agents.agentProgress(inst),
    // The Optimiser's loop is not a person's call: it runs as the Optimiser.
    optimiserHost: optimiserHost(inst.scope(systemContext('optimiser'))),
    connect: c => inst.connect(c),
    turnsIdle: () => inst.turnsIdle(),
    executors: workflowExecutors(inst),
    async sweep() {
      const w = at(systemContext('sweep'));
      for (const p of await projects.listProjects(w)) {
        const state = await projects.loadProjectState(w, p.id);
        if (state) await work.drive(w, state);
      }
    },
  };
}

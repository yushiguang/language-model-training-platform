import type {BffContract, EventStreamPort, EventTopic} from '@tsp/contracts';
import {getApp, onChange} from './services/app.ts';
import * as agents from './services/agents.ts';
import * as dataset from './services/dataset.ts';
import * as evaluation from './services/evaluation.ts';
import * as mismatch from './services/mismatches.ts';
import * as governance from './services/governance.ts';
import * as projects from './services/projects.ts';
import * as prompts from './services/prompts.ts';
import * as settings from './services/settings.ts';
import * as work from './services/work.ts';

/**
 * The bff as its contract (`BffContract`): the one surface a client calls, in-process or over
 * HTTP. Every method takes ids and the user's input, reads the records itself, and returns plain
 * JSON. The services behind it keep passing records to each other.
 */

/**
 * The same idempotency key never starts the same work twice: a repeat gets the first call's
 * result (or its error). Kept in memory for this process; a split deployment keeps it in a store.
 */
const KEPT_KEYS = 500;
const seen = new Map<string, Promise<unknown>>();
function idempotent<T>(method: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const k = `${method}:${key}`;
  const earlier = seen.get(k);
  if (earlier) return earlier as Promise<T>;
  const p = fn();
  seen.set(k, p);
  // A failed call may be retried with the same key: only a success is kept.
  p.catch(() => seen.delete(k));
  if (seen.size > KEPT_KEYS) seen.delete(seen.keys().next().value!);
  return p;
}

/** The project's state, or an error a client can show. */
async function stateOf(projectId: string) {
  const state = await projects.loadProjectState(projectId);
  if (!state) throw new Error('This project does not exist.');
  return state;
}

async function versionOf(projectId: string, promptVersionId: string) {
  const v = await getApp().catalog.get('prompt_versions', promptVersionId);
  if (!v || v.projectId !== projectId) throw new Error('This version does not exist.');
  return v;
}

export function createBffApi(): BffContract {
  return {
    async getRuntimeInfo() {
      const {identity, standIns, gateway} = getApp();
      return {user: await identity.currentUser(), standIns, endpoints: gateway.labelingEndpoints(), hasBundledGold: dataset.hasBundledGold()};
    },

    listProjects: projects.listProjects,
    createProject: projects.createProject,
    getProject: projects.getProject,
    loadProjectState: projects.loadProjectState,
    approveNode: projects.approveNode,
    deleteProject: r => projects.deleteProject(r.projectId),
    async tick({projectId}) {
      const state = await projects.loadProjectState(projectId);
      if (state) await work.tick(state);
    },

    saveSettings: ({projectId, ...s}) => settings.saveSettings(projectId, s),

    getSamplePoolSize: dataset.getSamplePoolSize,
    exampleMedia: dataset.exampleMedia,
    startSampleDataset: dataset.startSampleDataset,
    stopSampleDataset: async projectId => dataset.stopSampleDataset(projectId),
    uploadDatasetText: (projectId, name, text) => dataset.uploadDatasetText(projectId, name, text),
    appendSample: r => dataset.appendSample(r.projectId, r.count),
    appendUpload: (projectId, name, text) => dataset.uploadDatasetText(projectId, name, text, true),
    async removeExamples({projectId, exampleIds, reason}) {
      await governance.removeExamples(projectId, exampleIds, reason);
    },
    restoreExamples: r => governance.restoreExamples(r.projectId, r.removalIds),
    pruneDataset: r => governance.pruneDataset(r.projectId, r.mode, r.keep, r.field, r.value),
    addComment: r => governance.addComment(r.projectId, r.exampleId, r.text, r.promptVersionId ?? null),
    saveGold: dataset.saveGold,
    async uploadGold({projectId, lines}) {
      const state = await stateOf(projectId);
      if (!state.setup?.schema) throw new Error('Approve the prompt on Prompt Design first.');
      return dataset.uploadGold(projectId, state.setup.schema, state.setup.schemaVersion, state.examples, lines);
    },
    async importBundledGold(projectId) {
      const state = await stateOf(projectId);
      if (!state.setup?.schema) throw new Error('Approve the prompt on Prompt Design first.');
      return dataset.importBundledGold(projectId, state.setup.schema, state.setup.schemaVersion, state.examples);
    },
    mismatches: mismatch.mismatches,
    reviewGold: r => mismatch.reviewGold(r.projectId, r.exampleId, r.promptVersionId, r.outcome, r.answer, r.note),
    rebuildReports: mismatch.rebuildReports,

    createVersion: r =>
      idempotent('createVersion', r.idempotencyKey, async () => {
        await stateOf(r.projectId);
        const parent = r.parentId ? await versionOf(r.projectId, r.parentId) : null;
        return prompts.createVersion(r.projectId, {structured: r.structured, parent, madeBy: r.madeBy, change: r.change, kind: r.kind});
      }),
    scoreVersion: r => idempotent('scoreVersion', r.idempotencyKey, async () => work.scoreVersion(r.projectId, await versionOf(r.projectId, r.promptVersionId), r.endpoint)),
    stopRun: async runId => evaluation.stopRun(runId),
    startOptimiser: r => idempotent('startOptimiser', r.idempotencyKey, () => work.startOptimiser(r.projectId, r.maxRounds, r.startVersionId)),
    stopOptimiser: async runId => work.stopOptimiser(runId),
    retryOptimiser: work.retryOptimiser,
    improveWithAi: agents.improveWithAi,
    featureInfo: prompts.featureInfo,
    predictionsFor: async (promptVersionId, endpoint, settings) => Object.fromEntries(await evaluation.predictionsFor(promptVersionId, endpoint, settings)),

    chatHistory: agents.chatHistory,
    getAgentLive: async projectId => agents.agentLive(projectId),
    getAnsweringAgent: async (projectId, page) => agents.answeringAgent(projectId, page),
    sendUserMessage: r => agents.sendUserMessage(r.projectId, r.text, r.page, r.attachments),
    openProposals: agents.openProposals,
    proposals: agents.proposals,
    async closeProposal({projectId, proposalId, decision}) {
      const p = await getApp().catalog.get('agent_proposals', proposalId);
      if (!p || p.projectId !== projectId) throw new Error('This suggestion does not exist.');
      await agents.closeProposal(p, decision);
    },
  };
}

/** The services' event bus as the port a client listens on. */
export function bffEvents(): EventStreamPort {
  return {
    subscribe(topic: EventTopic, listener: () => void) {
      return topic === 'changes' ? onChange(listener) : agents.subscribeAgentLive(listener);
    },
  };
}

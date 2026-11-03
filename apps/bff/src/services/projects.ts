import {gate, type WorkflowFacts} from '../../../../packages/contracts/src/gates';
import {judge} from '../../../../packages/contracts/src/metrics';
import type {DatasetSnapshot, EvalReport, Example, GateApproval, LabelingRun, NodeId, OptimisationRun, Project, PromptVersion, SetupVersion, TrainingSet} from '../../../../packages/contracts/src/types';
import {compareVersions} from '../../../../packages/contracts/src/versions';
import type {ProjectState} from '../../../../packages/contracts/src/workflow';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {getSamplingTask} from './dataset';
import {contextIdFor, latestGold} from './evaluation';

export type {ProjectState};

export async function listProjects(): Promise<Project[]> {
  return getApp().repo.find<Project>('projects', {}, 'created_at desc');
}

export async function createProject(name: string): Promise<Project> {
  const {repo, user} = getApp();
  const u = await user();
  const p: Project = {id: newId('pr'), name, createdAt: now(), createdBy: u.name, setupVersionId: null, snapshotId: null, approvedNodes: []};
  await repo.insert('projects', p);
  await repo.audit(p.id, u.name, 'project.create', {name});
  return p;
}

export async function getProject(id: string): Promise<Project | null> {
  return getApp().repo.get<Project>('projects', id);
}

export async function updateProject(p: Project): Promise<Project> {
  await getApp().repo.update('projects', p);
  emitChange();
  return p;
}

export async function loadProjectState(projectId: string): Promise<ProjectState | null> {
  const {repo, platform} = getApp();
  const project = await getProject(projectId);
  if (!project) return null;
  const [setup, snapshot] = await Promise.all([
    project.setupVersionId ? repo.get<SetupVersion>('setup_versions', project.setupVersionId) : null,
    project.snapshotId ? repo.get<DatasetSnapshot>('dataset_snapshots', project.snapshotId) : null,
  ]);
  const examples = snapshot ? await repo.find<Example>('examples', {snapshot_id: snapshot.id}, 'external_id') : [];
  const schemaVersion = setup?.schemaVersion ?? 0;
  const {current: gold, stale: staleGold} = await latestGold(projectId, schemaVersion);
  const versions = (await repo.find<PromptVersion>('prompt_versions', {project_id: projectId})).sort((a, b) => compareVersions(b, a));
  const evalExamples = examples.filter(e => e.split === 'eval');
  const contextId = contextIdFor(schemaVersion, evalExamples, gold);
  const rawReports = await repo.find<EvalReport>('eval_reports', {project_id: projectId}, 'created_at desc');
  const t = setup?.thresholds;
  const reports = rawReports.map(r => ({
    ...r,
    archivedNow: r.contextId !== contextId,
    passed: !!t && r.contextId === contextId && judge(r.metrics, t, evalExamples.length).passed,
  }));
  const runs = await repo.find<LabelingRun>('labeling_runs', {project_id: projectId}, 'started_at desc');
  const optimisation = await repo.find<OptimisationRun>('optimisation_runs', {project_id: projectId}, 'started_at desc');
  const trainingSets = await repo.find<TrainingSet>('training_sets', {project_id: projectId}, 'started_at desc');
  const facts: WorkflowFacts = {
    setup,
    snapshot,
    goldEvalDone: evalExamples.filter(e => gold.has(e.id)).length,
    goldTestDone: examples.filter(e => e.split === 'test' && gold.has(e.id)).length,
    versions: versions.length,
    passing: reports.filter(r => r.passed && setup?.models.some(m => m.endpoint === r.endpoint)).map(r => ({promptVersionId: r.promptVersionId, endpoint: r.endpoint})),
    trainingSet: trainingSets[0] ?? null,
    approved: project.approvedNodes,
  };
  return {
    project,
    setup,
    snapshot,
    examples,
    gold,
    staleGold,
    versions,
    reports,
    runs,
    optimisation,
    trainingSets,
    facts,
    contextId,
    endpoints: platform.models.endpoints(),
    samplingTask: getSamplingTask(projectId),
  };
}

/** Next step: checks the gate on the server side of the app, then records who approved it. */
export async function approveNode(projectId: string, node: NodeId): Promise<void> {
  const {repo, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('Project not found');
  const g = gate(node, state.facts);
  if (!g.ready) throw new Error(g.reason ?? 'Not ready');
  const u = await user();
  const approval: GateApproval = {id: newId('ga'), projectId, node, status: 'ready', createdAt: now(), createdBy: u.name};
  await repo.insert('gate_approvals', approval);
  if (!state.project.approvedNodes.includes(node)) await updateProject({...state.project, approvedNodes: [...state.project.approvedNodes, node]});
  await repo.audit(projectId, u.name, 'gate.approve', {node});
}

export async function skipGold(projectId: string): Promise<void> {
  const state = await loadProjectState(projectId);
  if (state && !state.project.approvedNodes.includes('gold')) await updateProject({...state.project, approvedNodes: [...state.project.approvedNodes, 'gold']});
}

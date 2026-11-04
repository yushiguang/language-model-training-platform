import {DocFieldValue, type GateApproval, type NodeId, type Project, type ProjectState, type WorkflowFacts} from '@tsp/contracts';
import {compareVersions, contextIdFor, gate, judge, newId} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';
import {getSamplingTask} from './dataset.ts';
import {latestGold} from './evaluation.ts';
import {runView, trainingView} from './views.ts';

export type {ProjectState};

export async function listProjects(): Promise<Project[]> {
  return getApp().catalog.find('projects', {}, 'createdAt desc');
}

export async function createProject(name: string): Promise<Project> {
  const {catalog, user} = getApp();
  const u = await user();
  const p: Project = {id: newId('pr'), name, createdAt: now(), createdBy: u.name, setupVersionId: null, snapshotId: null, approvedNodes: []};
  await catalog.insert('projects', p);
  await catalog.audit(p.id, u.name, 'project.create', {name});
  emitChange();
  return p;
}

export async function getProject(id: string): Promise<Project | null> {
  return getApp().catalog.get('projects', id);
}

export async function loadProjectState(projectId: string): Promise<ProjectState | null> {
  const {catalog, labeling, gateway} = getApp();
  const project = await getProject(projectId);
  if (!project) return null;
  const [setup, snapshot] = await Promise.all([
    project.setupVersionId ? catalog.get('setup_versions', project.setupVersionId) : null,
    project.snapshotId ? catalog.get('dataset_snapshots', project.snapshotId) : null,
  ]);
  const schemaVersion = setup?.schemaVersion ?? 0;
  const [examples, {current: gold, stale: staleGold}, rawVersions, rawReports, tasks, optimisation, rawTrainingSets] = await Promise.all([
    snapshot ? catalog.find('examples', {snapshotId: snapshot.id}, 'externalId') : [],
    latestGold(projectId, schemaVersion),
    catalog.find('prompt_versions', {projectId}),
    catalog.find('eval_reports', {projectId}, 'createdAt desc'),
    labeling.listTasks(projectId),
    catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    catalog.find('training_sets', {projectId}, 'startedAt desc'),
  ]);
  const versions = rawVersions.sort((a, b) => compareVersions(b, a));
  const evalExamples = examples.filter(e => e.split === 'eval');
  const contextId = contextIdFor(schemaVersion, evalExamples, gold);
  const t = setup?.thresholds;
  const reports = rawReports.map(r => ({
    ...r,
    archivedNow: r.contextId !== contextId,
    passed: !!t && r.contextId === contextId && judge(r.metrics, t, evalExamples.length).passed,
  }));
  const runs = tasks.filter(x => x.purpose === 'eval' || x.purpose === 'optimiser').map(runView);
  const testRuns = tasks.filter(x => x.purpose === 'test').map(runView);
  const byTask = new Map(tasks.map(x => [x.id, x]));
  const trainingSets = rawTrainingSets.map(ts => trainingView(ts, byTask.get(ts.taskId)));
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
    testRuns,
    optimisation,
    trainingSets,
    facts,
    contextId,
    endpoints: gateway.labelingEndpoints(),
    samplingTask: getSamplingTask(projectId),
  };
}

/** Next step: checks the gate, then records who approved it. */
export async function approveNode(projectId: string, node: NodeId): Promise<void> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('Project not found');
  const g = gate(node, state.facts);
  if (!g.ready) throw new Error(g.reason ?? 'Not ready');
  const u = await user();
  const approval: GateApproval = {id: newId('ga'), projectId, node, status: 'ready', createdAt: now(), createdBy: u.name};
  await catalog.insert('gate_approvals', approval);
  await catalog.patch('projects', projectId, {approvedNodes: DocFieldValue.arrayUnion(node)});
  await catalog.audit(projectId, u.name, 'gate.approve', {node});
  emitChange();
}

/** Gold labels are optional: skipping is recorded like any other approval. */
export async function skipGold(projectId: string): Promise<void> {
  const {catalog, user} = getApp();
  const u = await user();
  await catalog.insert('gate_approvals', {id: newId('ga'), projectId, node: 'gold', status: 'skipped', createdAt: now(), createdBy: u.name});
  await catalog.patch('projects', projectId, {approvedNodes: DocFieldValue.arrayUnion('gold')});
  await catalog.audit(projectId, u.name, 'gate.skip', {node: 'gold'});
  emitChange();
}

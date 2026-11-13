import {DocFieldValue, type GateApproval, type NodeId, type Project, type ProjectState, type WorkflowFacts} from '@tsp/contracts';
import {compareVersions, contextIdFor, gate, judge, newId, scoresUpdating} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {getSamplingTask} from './dataset.ts';
import {cannotBuild, latestGold} from './evaluation.ts';
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
  tm().setContext({projectId: p.id});
  tm().event('project_created', {});
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
  const [examples, {current: gold, stale: staleGold}, rawVersions, rawReports, tasks, optimisation, rawTrainingSets, autoSpend] = await Promise.all([
    snapshot ? catalog.find('examples', {snapshotId: snapshot.id}, 'externalId') : [],
    latestGold(projectId, schemaVersion),
    catalog.find('prompt_versions', {projectId}),
    catalog.find('eval_reports', {projectId}, 'createdAt desc'),
    labeling.listTasks(projectId),
    catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    catalog.find('training_sets', {projectId}, 'startedAt desc'),
    catalog.find('audit_log', {projectId, action: 'auto_spend'}),
  ]);
  const versions = rawVersions.sort((a, b) => compareVersions(b, a));
  const evalExamples = examples.filter(e => e.split === 'eval');
  const contextId = contextIdFor(schemaVersion, evalExamples, gold);
  const t = setup?.thresholds;
  // A report replaced by Rebuild scores is kept for the record but never shown.
  const reports = rawReports.filter(r => !r.archived).map(r => ({
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
  const out = {
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
    otherAutoSpendUsd: autoSpend.reduce((n, a) => n + Number((a.data as {costUsd?: number}).costUsd ?? 0), 0),
  };
  return {...out, scoresUpdating: scoresUpdating(out, cannotBuild)};
}

/** Next step: checks the gate, then records who approved it. */
export async function approveNode(projectId: string, node: NodeId): Promise<void> {
  const {catalog, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('Project not found');
  const g = gate(node, state.facts);
  if (!g.ready) {
    tm().counter('tsp_gate_actions_total', {node, action: 'refused'});
    throw new Error(g.reason ?? 'Not ready');
  }
  const u = await user();
  const approval: GateApproval = {id: newId('ga'), projectId, node, status: 'ready', createdAt: now(), createdBy: u.name};
  await catalog.insert('gate_approvals', approval);
  await catalog.patch('projects', projectId, {approvedNodes: DocFieldValue.arrayUnion(node)});
  await catalog.audit(projectId, u.name, 'gate.approve', {node});
  tm().counter('tsp_gate_actions_total', {node, action: 'approve'});
  const project = await catalog.get('projects', projectId);
  if (project) tm().event('step_reached', {node, minutes_since_project_created: Math.round((Date.now() - Date.parse(project.createdAt)) / 60000)});
  if (project && node === 'training') {
    const ts = state.trainingSets[0];
    tm().event('project_finished', {minutes_since_created: Math.round((Date.now() - Date.parse(project.createdAt)) / 60000), total_cost_usd: Number((state.runs.reduce((n, r) => n + r.costUsd, 0) + state.testRuns.reduce((n, r) => n + r.costUsd, 0) + (ts?.costUsd ?? 0)).toFixed(4)), versions: state.versions.length, gold_labels: state.gold.size});
  }
  emitChange();
}


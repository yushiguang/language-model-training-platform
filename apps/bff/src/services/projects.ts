import {DocFieldValue, type GateApproval, type LabelComment, type NodeId, type Project, type ProjectState, type WorkflowFacts} from '@tsp/contracts';
import {compareVersions, contextIdFor, gate, judge, newId, scoresUpdating, systemConfig} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {getSamplingTask, stopSampleDataset} from './dataset.ts';
import {cannotBuild, latestGold} from './evaluation.ts';
import {runView} from './views.ts';
import {initSettings} from './settings.ts';
import {balanceHalves} from './governance.ts';

export type {ProjectState};

export async function listProjects(): Promise<Project[]> {
  return getApp().catalog.find('projects', {}, 'createdAt desc');
}

export async function createProject(name: string): Promise<Project> {
  const {catalog, user} = getApp();
  const u = await user();
  const p: Project = {id: newId('pr'), name: cleanName(name), createdAt: now(), createdBy: u.name, createdById: u.id, kind: 'prompt_tuning', settingsConfirmed: false, setupVersionId: null, snapshotId: null, approvedNodes: []};
  await catalog.insert('projects', p);
  // Project Settings start from defaults (the first active model, the default pass rule); the
  // user confirms them once, before the first paid run.
  p.setupVersionId = (await initSettings(p.id)).id;
  await catalog.audit(p.id, u.name, 'project.create', {name});
  tm().setContext({projectId: p.id});
  tm().event('project_created', {});
  emitChange();
  return p;
}

/** A project name as saved: one line, trimmed, cut at `project.nameMaxChars` (spec 1.1.0, 1.2). */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, systemConfig().project.nameMaxChars).trim();
}

/** Renames a project (Project Settings). Names need not be unique; the id never changes. */
export async function renameProject(projectId: string, name: string): Promise<string> {
  const {catalog, user} = getApp();
  const next = cleanName(name);
  if (!next) throw new Error('Give the project a name.');
  const p = await getProject(projectId);
  if (!p) throw new Error('This project does not exist.');
  if (p.name === next) return next;
  await catalog.patch('projects', projectId, {name: next});
  await catalog.audit(projectId, (await user()).name, 'project.rename', {from: p.name, to: next});
  tm().event('project_renamed', {});
  emitChange();
  return next;
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
  const [allExamples, {current: gold, stale: staleGold}, rawVersions, rawReports, tasks, optimisation, autoSpend, rawRemovals, rawComments] = await Promise.all([
    snapshot ? catalog.find('examples', {snapshotId: snapshot.id}, 'externalId') : [],
    latestGold(projectId, schemaVersion),
    catalog.find('prompt_versions', {projectId}),
    catalog.find('eval_reports', {projectId}, 'createdAt desc'),
    labeling.listTasks(projectId),
    catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    catalog.find('audit_log', {projectId, action: 'auto_spend'}),
    catalog.find('dataset_removals', {projectId}, 'removedAt desc'),
    catalog.find('label_comments', {projectId}, 'createdAt'),
  ]);
  // Removed examples stay in the store with their trail (spec 1.0.0, 4.4) and leave every count.
  const examples = allExamples.filter(e => !e.removed);
  const removals = rawRemovals.filter(r => !r.restoredAt);
  const comments: Record<string, LabelComment[]> = {};
  for (const c of rawComments) (comments[c.exampleId] ??= []).push(c);
  const versions = rawVersions.sort((a, b) => compareVersions(b, a));
  const evalExamples = examples.filter(e => e.split === 'eval');
  const contextId = contextIdFor(schemaVersion, evalExamples, gold);
  const t = setup?.thresholds;
  const labeled = evalExamples.filter(e => !!gold[e.id]);
  // A report replaced by Rebuild scores is kept for the record but never shown.
  const reports = rawReports.filter(r => !r.archived).map(r => ({
    ...r,
    archivedNow: r.contextId !== contextId,
    passed: !!t && r.contextId === contextId && judge(r.metrics, t, labeled.length).passed,
    rough: !t || judge(r.metrics, t, labeled.length).rough,
  }));
  const runs = tasks.filter(x => x.purpose === 'eval' || x.purpose === 'optimiser').map(runView);
  const facts: WorkflowFacts = {
    setup,
    snapshot,
    examples: evalExamples.length,
    goldEvalDone: labeled.length,
    goldHalves: {optimiser: labeled.filter(e => e.optimiserHalf).length, heldOut: labeled.filter(e => !e.optimiserHalf).length},
    versions: versions.length,
    passing: reports.filter(r => r.passed && setup?.models.some(m => m.endpoint === r.endpoint)).map(r => ({promptVersionId: r.promptVersionId, endpoint: r.endpoint})),
    settingsConfirmed: !!project.settingsConfirmed,
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
    optimisation,
    facts,
    contextId,
    endpoints: gateway.labelingEndpoints(),
    samplingTask: getSamplingTask(projectId),
    removals,
    comments,
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
  // Leaving Gold Labels: while no helper has read an example, the halves are balanced again by
  // gold label, so rare values are scored on in both halves (spec 1.0.0, 4.2).
  if (node === 'gold') await balanceHalves(projectId);
  // Finish on Prompt Tuning ends the project.
  if (project && node === 'prompt') {
    tm().event('project_finished', {minutes_since_created: Math.round((Date.now() - Date.parse(project.createdAt)) / 60000), total_cost_usd: Number(state.runs.reduce((n, r) => n + r.costUsd, 0).toFixed(4)), versions: state.versions.length, gold_labels: Object.keys(state.gold).length});
  }
  emitChange();
}


/**
 * Deletes a project for good (spec 1.0.0, 2.4): its sampling, Optimiser runs and labeling tasks
 * stop first, then labeling drops its tasks and answers and the catalog drops every record.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const {catalog, labeling, optimiser, user} = getApp();
  const state = await loadProjectState(projectId);
  if (!state) throw new Error('This project does not exist.');
  stopSampleDataset(projectId);
  await optimiser?.deleteProject(projectId);
  await labeling.deleteProject(projectId);
  await catalog.deleteProject(projectId);
  await catalog.audit(null, (await user()).name, 'project.deleted', {projectId});
  tm().event('project_deleted', {versions: state.versions.length, examples: state.examples.length, gold_labels: Object.keys(state.gold).length});
  emitChange();
}

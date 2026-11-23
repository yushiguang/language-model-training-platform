import {DEFAULT_TENANT, DocFieldValue, type GateApproval, type Job, type JobOutcome, type LabelComment, type NodeId, type Project, type ProjectState, type ProjectStatus, type ScoringState, type WorkflowFacts} from '@yushiguang/sprint-contracts';
import {asAnswerOrNull, compareVersions, gate, inRanges, judge, labelSetProgress, newId, scoreBasis, staleScores, systemConfig} from '@yushiguang/sprint-domain';
import {now, type Instance, type Scope} from './app.ts';
import {withRetries} from './access.ts';
import {getSamplingTask} from './dataset.ts';
import {datasetSources, retireCuts, tenantOf} from './sources.ts';
import {cannotBuildOn, latestGold, rescoresLeft} from './evaluation.ts';
import {runView} from './views.ts';
import {initSettings} from './settings.ts';
import {indexOnly} from './features.ts';
import {balanceHalves} from './governance.ts';
import {computeKey} from './queue.ts';
import {ensureNumbered} from './samples.ts';

export type {ProjectState};

/**
 * Projects saved before `Project.tenantId` existed belong to `DEFAULT_TENANT` (the tenant of a
 * caller with none, as data sources use): written once per instance, before the first read of
 * projects. Safe to run again and from two instances at once: both write the same value.
 */
export function backfillTenants(w: Scope): Promise<void> {
  w.local.tenantsBackfilled ??= (async () => {
    const old = (await w.catalog.find('projects', {})).filter(p => !p.tenantId);
    for (const p of old) await w.catalog.patch('projects', p.id, {tenantId: DEFAULT_TENANT});
  })();
  // A failed write is tried again by the next read.
  w.local.tenantsBackfilled.catch(() => (w.local.tenantsBackfilled = undefined));
  return w.local.tenantsBackfilled;
}

/** The caller's tenant's projects, newest first; one whose deletion was accepted is gone at once. */
export async function listProjects(w: Scope): Promise<Project[]> {
  await backfillTenants(w);
  return (await w.catalog.find('projects', {tenantId: tenantOf(w)}, 'createdAt desc')).filter(p => !p.deleting);
}

/** Every tenant's projects, for Sprint's own sweep; never for a caller. */
export async function allProjects(inst: Instance): Promise<Project[]> {
  const w = inst.scope({requestId: 'rq_sweep', user: {id: 'system', name: 'system'}});
  await backfillTenants(w);
  return (await w.catalog.find('projects', {})).filter(p => !p.deleting);
}

export async function createProject(w: Scope, name: string): Promise<Project> {
  const {catalog, user} = w;
  const u = await user();
  const p: Project = {id: newId('pr'), tenantId: tenantOf(w), name: cleanName(name), createdAt: now(), createdBy: u.name, createdById: u.id, kind: 'prompt_tuning', settingsConfirmed: false, setupVersionId: null, snapshotId: null, approvedNodes: []};
  await catalog.insert('projects', p);
  // Project Settings start from defaults (the first active model, the default pass rule); the
  // user confirms them once, before the first paid run.
  p.setupVersionId = (await initSettings(w, p.id)).id;
  // The creator gets project write on the permission platform. Without it the creator could not
  // open their own project, so a grant that still fails after its retries removes the project.
  if (w.permissionAdmin) {
    const admin = w.permissionAdmin;
    try {
      await withRetries(() => admin.grantProjectWrite(w.ctx, p.tenantId, p.id, u.id), 3, w.grantRetryMs ?? 200);
    } catch {
      await catalog.deleteProject(p.id);
      throw new Error('The project could not be created: edit access for you could not be saved. Try again.');
    }
  }
  await catalog.audit(p.id, u.name, 'project.create', {name});
  w.tm.setContext({projectId: p.id});
  w.tm.event('project_created', {});
  w.emitChange(p.id);
  return p;
}

/** A project name as saved: one line, trimmed, cut at `project.nameMaxChars` (spec 1.1.0, 1.2). */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, systemConfig().project.nameMaxChars).trim();
}

/** Renames a project (Project Settings). Names need not be unique; the id never changes. */
export async function renameProject(w: Scope, projectId: string, name: string): Promise<string> {
  const {catalog, user} = w;
  const next = cleanName(name);
  if (!next) throw new Error('Give the project a name.');
  const p = await getProject(w, projectId);
  if (!p) throw new Error('This project does not exist.');
  if (p.name === next) return next;
  await catalog.patch('projects', projectId, {name: next});
  await catalog.audit(projectId, (await user()).name, 'project.rename', {from: p.name, to: next});
  w.tm.event('project_renamed', {});
  w.emitChange(projectId);
  return next;
}

export async function getProject(w: Scope, id: string): Promise<Project | null> {
  await backfillTenants(w);
  const p = await w.catalog.get('projects', id);
  return p && !p.deleting ? p : null;
}

/**
 * The models a project's pages list: the tenant's own, then the platform's defaults
 * (docs/design/server.md, 9); only the defaults if the tenant's models cannot be read, so the page
 * still opens. A model the settings use that the gateway's cache lacks (added in another process
 * within its cache time) makes it read again once, so the page always knows the project's model.
 */
async function modelsFor(w: Scope, tenantId: string, used: string[]) {
  const {gateway, catalog} = w;
  let eps;
  try {
    eps = await gateway.labelingEndpointsFor(tenantId);
  } catch {
    // The store is failing: keep the gateway's cache as it is for the tenant's other work.
    return gateway.labelingEndpoints();
  }
  const missing = used.filter(id => !eps.some(e => e.id === id));
  // Only a model the tenant really has (not a platform model taken away) makes it read again.
  const found = await Promise.all(missing.map(id => catalog.get('tenant_models', id).catch(() => null)));
  if (!found.some(m => m?.tenantId === tenantId)) return eps;
  gateway.forgetTenant(tenantId);
  return gateway.labelingEndpointsFor(tenantId).catch(() => eps);
}

export async function loadProjectState(w: Scope, projectId: string): Promise<ProjectState | null> {
  const {catalog, labeling, gateway} = w;
  // First: a write during this read gives a newer revision, so the client reads again.
  const revision = await w.revisionOf(projectId);
  const project = await getProject(w, projectId);
  if (!project) return null;
  const [setup, snapshot] = await Promise.all([
    project.setupVersionId ? catalog.get('setup_versions', project.setupVersionId) : null,
    project.snapshotId ? catalog.get('dataset_snapshots', project.snapshotId) : null,
  ]);
  // A dataset made before sample numbers gets them on its first read (docs/design/server.md 4.2).
  if (snapshot && !snapshot.numbered) await ensureNumbered(w, snapshot);
  const schemaVersion = setup?.schemaVersion ?? 0;
  const [allExamples, {current: gold, stale: staleGold}, rawVersions, rawReports, tasks, optimisation, autoSpend, rawRemovals, rawComments, labelSets, rescoreJobs] = await Promise.all([
    snapshot ? catalog.find('examples', {snapshotId: snapshot.id}, 'externalId') : [],
    latestGold(w, projectId, schemaVersion),
    catalog.find('prompt_versions', {projectId}),
    catalog.find('eval_reports', {projectId}, 'createdAt desc'),
    labeling.listTasks(projectId),
    catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    catalog.find('audit_log', {projectId, action: 'auto_spend'}),
    catalog.find('dataset_removals', {projectId}, 'removedAt desc'),
    catalog.find('label_comments', {projectId}, 'createdAt'),
    snapshot ? catalog.find('label_sets', {projectId, snapshotId: snapshot.id}) : [],
    w.jobs.list(w.ctx, {projectId, kinds: ['report.rescore'], states: ['queued', 'running']}),
  ]);
  // Removed examples stay in the store with their trail (spec 1.0.0, 4.4) and leave every count.
  // Project state carries the index only: features kept on records saved before #32 are left out.
  const examples = allExamples.filter(e => !e.removed).map(indexOnly);
  const removals = rawRemovals.filter(r => !r.restoredAt).map(r => (r.gold == null ? r : {...r, gold: asAnswerOrNull(r.gold)}));
  const comments: Record<string, LabelComment[]> = {};
  for (const c of rawComments) (comments[c.exampleId] ??= []).push(c);
  const versions = rawVersions.sort((a, b) => compareVersions(b, a));
  const evalExamples = examples.filter(e => e.split === 'eval');
  // Scores rest on the eval samples inside label sets, once every set is finished (server.md 4.3).
  const progress = labelSetProgress(evalExamples, gold, labelSets);
  const inSets = evalExamples.filter(e => inRanges(e, progress.ranges));
  const labeled = inSets.filter(e => !!gold[e.id]);
  const t = setup?.thresholds;
  const {basis, contextId} = scoreBasis(schemaVersion, progress.ready ? labeled : [], gold, t);
  // A report replaced by Rescore is kept for the record but never shown; one on an older basis is
  // out of date (`archivedNow`) and never passes.
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
    scoringReady: progress.ready,
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
    endpoints: await modelsFor(w, project.tenantId, setup?.models.map(m => m.endpoint) ?? []),
    samplingTask: await getSamplingTask(w, projectId),
    datasetSources: await datasetSources(w, projectId, examples),
    removals,
    comments,
    otherAutoSpendUsd: autoSpend.reduce((n, a) => n + Number((a.data as {costUsd?: number}).costUsd ?? 0), 0),
    revision,
  };
  // A score needs 2 gold-labeled samples in each half: below that a Rescore could build nothing.
  const scorable = progress.ready && facts.goldHalves.optimiser >= 2 && facts.goldHalves.heldOut >= 2;
  const stale = staleScores({...out, ready: scorable, basis}, scorable ? await cannotBuildOn(w, projectId, contextId) : new Set());
  const scoring: ScoringState = {
    ready: progress.ready,
    ranges: progress.ranges,
    labelSets: progress.labelSets,
    labelSetsDone: progress.labelSetsDone,
    samples: progress.samples,
    labeled: progress.labeled,
    basis,
    ...stale,
    rescoring: (await rescoresLeft(w, rescoreJobs.map(j => j.id))) > 0,
  };
  return {...out, scoring, scoresUpdating: stale.staleVersionIds.length > 0};
}

/**
 * The light read (review G9): the revision and the running work only, so a client polls this and
 * reads the whole state again when the revision moved. Never reads examples, gold labels or reports.
 */
export async function projectStatus(w: Scope, projectId: string): Promise<ProjectStatus | null> {
  const revision = await w.revisionOf(projectId);
  if (!(await getProject(w, projectId))) return null;
  const [tasks, optimisation, samplingTask] = await Promise.all([
    w.labeling.listTasks(projectId),
    w.catalog.find('optimisation_runs', {projectId}, 'startedAt desc'),
    getSamplingTask(w, projectId),
  ]);
  return {
    projectId,
    revision,
    samplingTask,
    runs: tasks.filter(x => x.purpose === 'eval' || x.purpose === 'optimiser').map(runView),
    optimisation: optimisation.map(({history: _history, ...o}) => o),
  };
}

/** Next step: checks the gate, then records who approved it. */
export async function approveNode(w: Scope, projectId: string, node: NodeId): Promise<void> {
  const {catalog, user} = w;
  const state = await loadProjectState(w, projectId);
  if (!state) throw new Error('Project not found');
  const g = gate(node, state.facts);
  if (!g.ready) {
    w.tm.counter('sprint_gate_actions_total', {node, action: 'refused'});
    throw new Error(g.reason ?? 'Not ready');
  }
  const u = await user();
  const approval: GateApproval = {id: newId('ga'), projectId, node, status: 'ready', createdAt: now(), createdBy: u.name};
  await catalog.insert('gate_approvals', approval);
  await catalog.patch('projects', projectId, {approvedNodes: DocFieldValue.arrayUnion(node)});
  await catalog.audit(projectId, u.name, 'gate.approve', {node});
  w.tm.counter('sprint_gate_actions_total', {node, action: 'approve'});
  const project = await catalog.get('projects', projectId);
  if (project) w.tm.event('step_reached', {node, minutes_since_project_created: Math.round((Date.now() - Date.parse(project.createdAt)) / 60000)});
  // Leaving Gold Labels: while no helper has read an example, the halves are balanced again by
  // gold label, so rare values are scored on in both halves (spec 1.0.0, 4.2).
  if (node === 'gold') await balanceHalves(w, projectId);
  // Finish on Prompt Tuning ends the project.
  if (project && node === 'prompt') {
    w.tm.event('project_finished', {minutes_since_created: Math.round((Date.now() - Date.parse(project.createdAt)) / 60000), total_cost_usd: Number(state.runs.reduce((n, r) => n + r.costUsd, 0).toFixed(4)), versions: state.versions.length, gold_labels: Object.keys(state.gold).length});
  }
  w.emitChange(projectId);
}


/**
 * Deletes a project for good (spec 1.0.0, 2.4). Accept and queue (deployment readiness spec, 3):
 * the project is marked as being deleted, so no read returns it any more, and a `project.delete`
 * job stops its work and removes its records in bulk.
 */
export async function deleteProject(w: Scope, projectId: string): Promise<void> {
  const {catalog, user} = w;
  const state = await loadProjectState(w, projectId);
  if (!state) throw new Error('This project does not exist.');
  await catalog.patch('projects', projectId, {deleting: true});
  await catalog.audit(null, (await user()).name, 'project.deleted', {projectId});
  w.tm.event('project_deleted', {versions: state.versions.length, examples: state.examples.length, gold_labels: Object.keys(state.gold).length});
  await w.jobs.enqueue(w.ctx, {kind: 'project.delete', projectId, concurrencyKey: computeKey(w), args: {}, idempotencyKey: `delete:${projectId}`});
  w.emitChange(projectId);
}

/** How long deleting waits for the project's cancelled jobs to end (two default job leases). */
const STOP_WAIT_MS = 60_000;

/**
 * The `project.delete` executor: cancels the project's other jobs, stops its Optimiser runs and
 * labeling, then labeling drops its tasks and answers and the catalog every record, in batches.
 * Safe to run again: what was deleted stays deleted.
 */
export async function runDelete(w: Scope, job: Job, waitMs = STOP_WAIT_MS): Promise<JobOutcome> {
  const projectId = job.projectId!;
  const others = (await w.jobs.list(w.ctx, {projectId, states: ['queued', 'running']})).filter(j => j.id !== job.id);
  for (const other of others) await w.jobs.cancel(w.ctx, other.id);
  // A cancelled job on another instance sees the cancel at its next heartbeat and may still save
  // an answer before it ends: delete only once every one of them has ended. Still running after
  // the wait: this try fails and the job runs again later.
  const until = Date.now() + waitMs;
  for (;;) {
    const left = [];
    for (const o of others) {
      const j = await w.jobs.get(w.ctx, o.id);
      if (j && (j.state === 'queued' || j.state === 'running')) left.push(j.id);
    }
    if (!left.length) break;
    if (Date.now() >= until) throw new Error(`${left.length} job${left.length === 1 ? '' : 's'} of the project did not stop in time.`);
    await new Promise(r => setTimeout(r, 50));
  }
  await w.optimiser?.deleteProject(projectId);
  await w.labeling.deleteProject(projectId);
  // Its segments of data sources stay taken, retired (#30): never handed out again.
  await retireCuts(w, projectId);
  await w.catalog.deleteProject(projectId);
  w.emitChange(projectId);
  return {state: 'done'};
}

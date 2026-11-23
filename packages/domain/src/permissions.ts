import type {PermissionPoint, WorkflowContract} from '@yushiguang/sprint-contracts';

/**
 * What each `WorkflowContract` method needs (docs/design/server.md, 2.3): its permission point,
 * and where its project id is. The workflow checks every call against it, and a gateway can be
 * configured from the same table, so the two never disagree. `permission: null`: any signed-in
 * caller (the runtime info the site needs before it knows a tenant). `project`: `arg` when the
 * first argument is the project id, `request` when it is a request object with `projectId`, null
 * when the method is not about one project.
 */
export interface ActionRule {
  permission: PermissionPoint | null;
  project: 'arg' | 'request' | null;
}

const read = (project: ActionRule['project'] = null): ActionRule => ({permission: 'read', project});
const write = (project: ActionRule['project']): ActionRule => ({permission: 'project_write', project});
const admin: ActionRule = {permission: 'tenant_write', project: null};

/** Every method of `WorkflowContract`: the type makes a new method name its rule here. */
export const WORKFLOW_PERMISSIONS: {readonly [K in keyof WorkflowContract]: ActionRule} = {
  runtimeInfo: {permission: null, project: null},

  listProjects: read(),
  // Any member of the tenant creates projects, and becomes the project's first writer.
  createProject: read(),
  getProject: read('arg'),
  loadProjectState: read('arg'),
  projectStatus: read('arg'),
  approveNode: write('arg'),
  deleteProject: write('request'),
  renameProject: write('request'),
  // The pages' check of what should run: the work it queues runs as Sprint itself.
  tick: read('request'),
  saveSettings: write('request'),

  listDataSources: read(),
  getDataSource: read(),
  createDataSource: admin,
  addSourceFile: admin,

  // Every member sees the tenant's models; only admins change them.
  listModels: read(),
  addModel: admin,
  updateModel: admin,
  removeModel: admin,
  setDefaultModel: admin,

  exampleMedia: read('arg'),
  getExampleFeatures: read('arg'),
  takeExamples: write('request'),
  stopSampleDataset: write('arg'),
  removeExamples: write('request'),
  listSamples: read('request'),
  restoreExamples: write('request'),
  pruneDataset: write('request'),
  addComment: write('request'),
  saveGold: write('arg'),
  uploadGold: write('request'),
  uploadGoldText: write('arg'),
  importBundledGold: write('arg'),
  mismatches: read('arg'),
  reviewGold: write('request'),
  rebuildReports: write('arg'),

  createVersion: write('request'),
  scoreVersion: write('request'),
  stopRun: write('request'),
  startOptimiser: write('request'),
  stopOptimiser: write('request'),
  retryOptimiser: write('request'),
  improveWithAi: write('arg'),
  featureInfo: read(),
  predictionsFor: read('arg'),

  chatHistory: read('arg'),
  getAgentLive: read('arg'),
  getAnsweringAgent: read('arg'),
  // Asking Ask AI is reading; a helper's tools that start work check project write themselves.
  sendUserMessage: read('request'),
  openProposals: read('arg'),
  proposals: read('arg'),
  closeProposal: write('request'),
};

/** The project id a call names, by its rule; undefined when it names none. */
export function projectIdOf(rule: ActionRule, args: unknown[]): string | undefined {
  const first = args[0];
  if (rule.project === 'arg') return typeof first === 'string' ? first : undefined;
  if (rule.project === 'request' && first && typeof first === 'object') {
    const id = (first as {projectId?: unknown}).projectId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

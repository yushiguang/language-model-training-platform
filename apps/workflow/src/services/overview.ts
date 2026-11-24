import {SYSTEM_CALLER, type AuditEntry, type DocFilterExpression, type Project, type ProjectActivity, type ProjectActivityKind, type ProjectOverview, type ProjectOverviewRequest} from '@yushiguang/sprint-contracts';
import type {Scope} from './app.ts';
import {getProject} from './projects.ts';
import {listTenantMembers} from './tenants.ts';

/**
 * The project Overview (#123): whether the caller can edit the project, and what happened in it.
 * Activity comes from the project's audit records, the helpers' suggestions, and the gold labels
 * people saved (one line per person per day). Records Sprint keeps for itself (spend, tool calls,
 * the halves) are left out.
 */

/** Audit actions shown, and the activity kind each becomes. */
const SHOWN: Record<string, ProjectActivityKind> = {
  'project.create': 'project_created',
  'project.rename': 'project_renamed',
  'settings.save': 'settings_saved',
  'dataset.create': 'examples_added',
  'dataset.append': 'examples_added',
  'dataset.remove': 'examples_removed',
  'dataset.restore': 'examples_restored',
  'gold_labels.uploaded': 'gold_uploaded',
  'label_sets.create': 'label_sets_created',
  'prompt.create': 'version_saved',
  'gate.approve': 'step_finished',
  'project.editor_added': 'editor_added',
  'project.editor_removed': 'editor_removed',
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Who an audit actor is: Sprint's own work, the helpers and the Optimiser, or a person by name. */
function actor(name: string): ProjectActivity['by'] {
  if (name === 'system' || name === SYSTEM_CALLER) return {kind: 'sprint', name: 'Sprint'};
  if (name === 'optimiser') return {kind: 'ai', name: 'Optimiser'};
  if (name.startsWith('agent:')) return {kind: 'ai', name: 'AI'};
  return {kind: 'person', name};
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/** One audit record as an activity line, or null when it says nothing worth showing. */
function fromAudit(a: AuditEntry, names: Map<string, string>): ProjectActivity | null {
  const kind = SHOWN[a.action];
  if (!kind) return null;
  const d = a.data as Record<string, unknown>;
  const line: ProjectActivity = {id: a.id, at: a.createdAt, by: actor(a.actor), kind};
  const count = (n: number | undefined) => {
    if (n == null || n <= 0) return null;
    return {...line, count: n};
  };
  switch (kind) {
    case 'project_renamed':
      return {...line, ...(str(d.to) ? {text: str(d.to)} : {})};
    case 'examples_added':
      // A dataset made from a file counts its rows less those not saved; an append counts what it added.
      return count(a.action === 'dataset.append' ? num(d.added) : (num(d.rows) ?? 0) - (num(d.notSaved) ?? 0));
    case 'examples_removed':
    case 'examples_restored':
    case 'label_sets_created':
      return count(num(d.count));
    case 'gold_uploaded':
      return count((num(d.saved) ?? 0) + (num(d.replaced) ?? 0));
    case 'version_saved':
    case 'step_finished':
      return {...line, ...(str(d.version ?? d.node) ? {text: str(d.version ?? d.node)} : {})};
    case 'editor_added':
    case 'editor_removed': {
      const id = str(d.userId);
      return id ? {...line, text: names.get(id) ?? id} : null;
    }
    default:
      return line;
  }
}

/** Gold labels people saved, one line per person per day (UTC), at that day's last label. */
async function labeled(w: Scope, p: Project): Promise<ProjectActivity[]> {
  const days = new Map<string, ProjectActivity>();
  for (const g of await w.catalog.find('gold_labels', {projectId: p.id, source: 'labeled'})) {
    const key = `${g.createdBy}\u0000${g.createdAt.slice(0, 10)}`;
    const line = days.get(key);
    if (!line) days.set(key, {id: `gl:${key}`, at: g.createdAt, by: {kind: 'person', name: g.createdBy}, kind: 'examples_labeled', count: 1});
    else {
      line.count = (line.count ?? 0) + 1;
      if (g.createdAt > line.at) line.at = g.createdAt;
    }
  }
  return [...days.values()];
}

/** Whether the caller may edit the project; with no permission platform, everyone may. */
async function canEdit(w: Scope, p: Project): Promise<boolean> {
  if (!w.authorization || w.ctx.caller === SYSTEM_CALLER) return true;
  return w.authorization.allowed(w.ctx, {action: 'workflow.getProjectOverview', permission: 'project_write', projectId: p.id});
}

export async function getProjectOverview(w: Scope, req: ProjectOverviewRequest): Promise<ProjectOverview> {
  const p = await getProject(w, req.projectId);
  if (!p) throw new Error('This project does not exist.');
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(req.limit ?? DEFAULT_LIMIT)));
  const shown: DocFilterExpression = {
    type: 'and',
    filters: [
      {type: 'field', field: 'projectId', op: '==', value: p.id},
      {type: 'field', field: 'action', op: 'in', value: Object.keys(SHOWN)},
    ],
  };
  const [edit, audit, proposals, labels, members] = await Promise.all([
    canEdit(w, p),
    // More than the limit: some records turn into no line (a count of 0).
    w.catalog.page('audit_log', {where: shown, order: 'createdAt desc', limit: limit * 2}),
    w.catalog.page('agent_proposals', {where: {projectId: p.id}, order: 'createdAt desc', limit}),
    labeled(w, p),
    listTenantMembers(w),
  ]);
  const names = new Map(members.map(m => [m.userId, m.name]));
  const lines: ProjectActivity[] = [
    ...audit.items.map(a => fromAudit(a, names)).filter((x): x is ProjectActivity => x != null),
    ...proposals.items.map((x): ProjectActivity => ({id: x.id, at: x.createdAt, by: {kind: 'ai', name: 'AI'}, kind: 'ai_suggested', ...(x.brief ? {text: x.brief} : {})})),
    ...labels,
  ];
  lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
  return {canEdit: edit, activity: lines.slice(0, limit)};
}

import type {AddProjectEditorsRequest, MemberChangeResult, Project, ProjectEditor, ProjectEditorsRequest, RemoveProjectEditorRequest} from '@yushiguang/sprint-contracts';
import type {Scope} from './app.ts';
import {withRetries} from './access.ts';
import {getProject} from './projects.ts';
import {withLock} from './sources.ts';
import {listTenantMembers} from './tenants.ts';

/**
 * Who can edit a project (#118). Edit access lives on the permission platform (project write);
 * the creator always has it. When someone was added comes from the project's audit records.
 */

const ADDED = 'project.editor_added';

async function project(w: Scope, projectId: string): Promise<Project> {
  const p = await getProject(w, projectId);
  if (!p) throw new Error('This project does not exist.');
  return p;
}

/** The creator first, then everyone else by name. Without a permission platform: the creator alone. */
export async function listProjectEditors(w: Scope, req: ProjectEditorsRequest): Promise<ProjectEditor[]> {
  const p = await project(w, req.projectId);
  const ids = w.permissionAdmin ? await w.permissionAdmin.listProjectWriters(p.tenantId, p.id) : [];
  const members = new Map((await listTenantMembers(w)).map(m => [m.userId, m]));
  const added = new Map<string, string>();
  for (const a of await w.catalog.find('audit_log', {projectId: p.id, action: ADDED})) {
    const id = (a.data as {userId?: string}).userId;
    if (id && a.createdAt > (added.get(id) ?? '')) added.set(id, a.createdAt);
  }
  const creatorId = p.createdById;
  const person = (userId: string, creator: boolean): ProjectEditor => {
    const m = members.get(userId);
    // A member the platform could not name is named by the project for its creator.
    const known = m && m.name !== userId ? m.name : null;
    return {userId, name: known ?? (creator ? p.createdBy : userId), ...(m?.email ? {email: m.email} : {}), creator, addedAt: creator ? null : (added.get(userId) ?? null)};
  };
  const others = [...new Set(ids)].filter(id => id !== creatorId).map(id => person(id, false));
  others.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  return creatorId ? [person(creatorId, true), ...others] : others;
}

/** Adds tenant members as editors; those who already edit stay as they are. At most 50 at once. */
export async function addProjectEditors(w: Scope, req: AddProjectEditorsRequest): Promise<MemberChangeResult> {
  const admin = w.permissionAdmin;
  if (!admin) return {error: 'Editors cannot be changed here.'};
  const p = await project(w, req.projectId);
  const ids = [...new Set((req.userIds ?? []).map(x => String(x).trim()).filter(Boolean))].slice(0, 50);
  if (!ids.length) return {error: 'Pick someone to add.'};
  const members = new Set((await admin.listTenantMembers(p.tenantId)).map(m => m.userId));
  if (ids.some(id => !members.has(id))) return {error: 'Only members of this tenant can edit its projects.'};
  const has = new Set(await admin.listProjectWriters(p.tenantId, p.id));
  const fresh = ids.filter(id => !has.has(id));
  const actor = (await w.user()).name;
  for (const userId of fresh) {
    try {
      await withRetries(() => admin.grantProjectWrite(w.ctx, p.tenantId, p.id, userId), 3, w.grantRetryMs ?? 200);
    } catch {
      return {error: 'Edit access could not be saved. Try again.'};
    }
    await w.catalog.audit(p.id, actor, ADDED, {userId});
  }
  if (fresh.length) w.emitChange(p.id);
  return {};
}

/** Takes edit access away. The creator always keeps it. */
export async function removeProjectEditor(w: Scope, req: RemoveProjectEditorRequest): Promise<MemberChangeResult> {
  const admin = w.permissionAdmin;
  if (!admin) return {error: 'Editors cannot be changed here.'};
  const p = await project(w, req.projectId);
  if (req.userId === p.createdById) return {error: 'The creator can always edit the project.'};
  // One change at a time per project, so a removal never races an add of the same person.
  const out = await withLock(
    w,
    `editors:${p.id}`,
    async (): Promise<MemberChangeResult> => {
      if (!(await admin.listProjectWriters(p.tenantId, p.id)).includes(req.userId)) return {error: 'This person cannot edit the project.'};
      await admin.revokeProjectWrite(w.ctx, p.tenantId, p.id, req.userId);
      return {};
    },
    'Editors are being changed. Try again in a minute.',
  );
  if (out.error) return out;
  await w.catalog.audit(p.id, (await w.user()).name, 'project.editor_removed', {userId: req.userId});
  w.emitChange(p.id);
  return {};
}

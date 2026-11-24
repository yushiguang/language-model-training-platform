import type {AddTenantMembersRequest, CreateTenantRequest, CreateTenantResult, DeleteTenantRequest, MemberChangeResult, Person, RemoveTenantMemberRequest, RenameTenantRequest, RenameTenantResult, SearchPeopleRequest, SetTenantRoleRequest, Tenant, TenantDetail, TenantMemberView, TenantRole, TenantSummary} from '@yushiguang/sprint-contracts';
import {newId, systemConfig} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {tenantRole, withRetries} from './access.ts';
import {listModels, withModelsLock} from './models.ts';
import {backfillTenants, deleteProject} from './projects.ts';
import {deleteDataSource, listDataSources, tenantOf, withLock} from './sources.ts';

/**
 * Tenants (#94): a record per tenant made in Sprint (name, creator), with who is in it kept on the
 * permission platform (`PermissionAdminPort`). Tenants used before records existed
 * (`DEFAULT_TENANT`, an identity's organization) have none and keep working; the bff names them
 * from the identity.
 */

export const NAME_TAKEN = 'A tenant with this name already exists. Pick another name.';
export const NAME_BLANK = 'Enter a name. Spaces alone are not a name.';

/** A tenant name as saved: one line, runs of spaces made one, trimmed, cut at the project name limit. */
export function cleanTenantName(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, systemConfig().project.nameMaxChars).trim();
}

const projectCounts = async (w: Scope, ids: string[]) => {
  await backfillTenants(w);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (await w.catalog.find('projects', {tenantId: id})).filter(p => !p.deleting).length);
  return counts;
};

/**
 * The tenants the caller is in, by name: from the permission platform when it is wired, else the
 * caller's current tenant alone (every signed-in user is then in it, as an admin).
 */
export async function listTenants(w: Scope): Promise<TenantSummary[]> {
  const u = await w.user();
  const mine: {tenantId: string; role: TenantRole}[] = w.permissionAdmin ? await w.permissionAdmin.listUserTenants(u.id) : [{tenantId: tenantOf(w), role: 'admin'}];
  const ids = [...new Set(mine.map(m => m.tenantId))];
  const [records, counts] = await Promise.all([w.catalog.findByIds('tenants', ids), projectCounts(w, ids)]);
  const names = new Map(records.map(t => [t.id, t.name]));
  return ids
    .map(id => ({id, name: names.get(id) ?? id, role: mine.find(m => m.tenantId === id)!.role, projects: counts.get(id) ?? 0}))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The members of the caller's current tenant, by name (#107): from the permission platform when it
 * is wired, else the caller alone, as an admin. A member the platform gives no name is named by
 * the identity when it is the caller, else by their user id.
 */
export async function listTenantMembers(w: Scope): Promise<TenantMemberView[]> {
  const u = await w.user();
  const list = w.permissionAdmin ? await w.permissionAdmin.listTenantMembers(tenantOf(w)) : [{userId: u.id, role: 'admin' as const}];
  return list
    .map((m): TenantMemberView => {
      const email = m.email?.trim() || (m.userId === u.id ? u.email : undefined);
      return {userId: m.userId, name: m.name?.trim() || (m.userId === u.id ? u.name : m.userId), ...(email ? {email} : {}), role: m.role};
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
}

/** The name of the caller's current tenant, when it has a record. */
export async function tenantName(w: Scope): Promise<string | undefined> {
  return (await w.catalog.get('tenants', tenantOf(w)))?.name;
}

/** Whether the caller is in its current tenant (always, without a permission platform). */
export async function inTenant(w: Scope): Promise<boolean> {
  if (!w.permissionAdmin) return true;
  const u = await w.user();
  return (await w.permissionAdmin.listUserTenants(u.id)).some(t => t.tenantId === tenantOf(w));
}

const minTenantAdmins = (): number => Math.min(50, Math.max(1, Math.floor(systemConfig().tenant.minAdmins)));

/**
 * Creates a tenant and makes the caller (plus any requested co-admins) its admin. Names are unique
 * across Sprint (without case), checked under one lock. When writing the admins fails after retries,
 * any written members/resources and the tenant record are removed again, so no tenant is left half-made.
 */
export async function createTenant(w: Scope, req: CreateTenantRequest): Promise<CreateTenantResult> {
  const admin = w.permissionAdmin;
  if (!admin) throw new Error('Tenants cannot be created here.');
  const name = cleanTenantName(req.name);
  if (!name) return {error: NAME_BLANK};
  const u = await w.user();
  const extra = (req.adminIds ?? []).map(x => String(x).trim()).filter(Boolean);
  const adminIds = [...new Set([u.id, ...extra])].slice(0, 50);
  const min = minTenantAdmins();
  if (adminIds.length < min) return {error: min === 2 ? 'Pick at least one other admin.' : `Pick at least ${min - 1} other admins.`};
  const tenant = await withLock(
    w,
    'tenants:names',
    async (): Promise<Tenant | null> => {
      const taken = (await w.catalog.find('tenants', {})).some(t => t.name.toLowerCase() === name.toLowerCase());
      if (taken) return null;
      const t: Tenant = {id: newId('tn'), name, createdAt: now(), createdBy: u.name, createdById: u.id};
      await w.catalog.insert('tenants', t);
      return t;
    },
    'Tenants are being created. Try again in a minute.',
  );
  if (!tenant) return {error: NAME_TAKEN};
  try {
    if (admin.createTenant) {
      await withRetries(() => admin.createTenant!(w.ctx, {tenantId: tenant.id, name: tenant.name, adminIds}), 3, w.grantRetryMs ?? 200);
    } else {
      for (const id of adminIds) {
        await withRetries(() => admin.addTenantMember(w.ctx, tenant.id, id, 'admin'), 3, w.grantRetryMs ?? 200);
      }
    }
  } catch {
    if (admin.deleteTenant) {
      await withRetries(() => admin.deleteTenant!(w.ctx, tenant.id), 1, w.grantRetryMs ?? 200).catch(() => undefined);
    } else {
      for (const id of adminIds) await withRetries(() => admin.removeTenantMember(w.ctx, tenant.id, id), 1, w.grantRetryMs ?? 200).catch(() => undefined);
    }
    await w.catalog.remove('tenants', tenant.id);
    throw new Error('The tenant could not be created: you could not be made its admin. Try again.');
  }
  await w.catalog.audit(null, u.name, 'tenant.create', {tenantId: tenant.id});
  w.emitChange(null);
  return {tenant: {id: tenant.id, name: tenant.name, role: 'admin', projects: 0}};
}

/**
 * The page's tenant (#103) with what its Admin cards count: data sources (as the data sources page
 * lists them), the tenant's own models, and its members (null without a permission platform). The
 * bff names a tenant without a record.
 */
export async function getTenant(w: Scope): Promise<TenantDetail> {
  const id = tenantOf(w);
  const [name, role, counts, sources, models, members] = await Promise.all([
    tenantName(w),
    tenantRole(w),
    projectCounts(w, [id]),
    listDataSources(w),
    listModels(w),
    w.permissionAdmin ? w.permissionAdmin.listTenantMembers(id) : null,
  ]);
  return {id, name: name ?? id, role, projects: counts.get(id) ?? 0, dataSources: sources.length, models: models.length, members: members ? members.length : null};
}

const nameTaken = async (w: Scope, name: string, except?: string) => (await w.catalog.find('tenants', {})).some(t => t.id !== except && t.name.toLowerCase() === name.toLowerCase());

/**
 * Renames the page's tenant (#111), checked as a new name is. A tenant without a record (from an
 * organization, or `default`) gets one now, under the same id, so the name sticks.
 */
export async function renameTenant(w: Scope, req: RenameTenantRequest): Promise<RenameTenantResult> {
  const name = cleanTenantName(req.name);
  if (!name) return {error: NAME_BLANK};
  const id = tenantOf(w);
  const u = await w.user();
  const done = await withLock(
    w,
    'tenants:names',
    async () => {
      if (await nameTaken(w, name, id)) return false;
      const rec = await w.catalog.get('tenants', id);
      if (rec) await w.catalog.patch('tenants', id, {name});
      else await w.catalog.insert('tenants', {id, name, createdAt: now(), createdBy: u.name, createdById: u.id});
      return true;
    },
    'Tenants are being created. Try again in a minute.',
  );
  if (!done) return {error: NAME_TAKEN};
  await w.catalog.audit(null, u.name, 'tenant.rename', {tenantId: id});
  w.emitChange(null);
  return {name};
}

export const LAST_ADMIN = "The last admin can't be changed. Make someone else an admin first.";
const NO_MEMBERS = 'Members cannot be changed here.';

/**
 * Deletes the page's tenant (#111) once its name is typed: its projects go through their own delete
 * jobs, its data sources and models go, then everyone is taken out of it and its record removed,
 * so it leaves every list at once. Safe to run again after a failure part way.
 */
export async function deleteTenant(w: Scope, req: DeleteTenantRequest): Promise<{error?: string}> {
  const id = tenantOf(w);
  const rec = await w.catalog.get('tenants', id);
  if (!rec) return {error: "This tenant comes with your organization. It can't be deleted."};
  if (String(req.name ?? '').trim() !== rec.name) return {error: 'Type the tenant name to confirm.'};
  const u = await w.user();
  await backfillTenants(w);
  const projects = await w.catalog.find('projects', {tenantId: id});
  // Queue cleanup as the system caller so jobs still finish after members/roles are removed below
  // and even when the admin did not hold `project_write` on every member's project.
  for (const p of projects) if (!p.deleting) await deleteProject(w, p.id, {asSystem: true});
  for (const s of await listDataSources(w)) if (!s.builtIn) await deleteDataSource(w, {sourceId: s.id});
  await withModelsLock(w, async () => {
    for (const m of await w.catalog.find('tenant_models', {tenantId: id})) await w.catalog.remove('tenant_models', m.id);
  });
  w.gateway.forgetTenant(id);
  if (w.permissionAdmin) {
    if (w.permissionAdmin.deleteProject) {
      for (const p of projects) await withRetries(() => w.permissionAdmin!.deleteProject!(w.ctx, id, p.id), 3, w.grantRetryMs ?? 200);
    }
    if (w.permissionAdmin.deleteTenant) await withRetries(() => w.permissionAdmin!.deleteTenant!(w.ctx, id), 3, w.grantRetryMs ?? 200);
    else for (const m of await w.permissionAdmin.listTenantMembers(id)) await w.permissionAdmin.removeTenantMember(w.ctx, id, m.userId);
  }
  await w.catalog.remove('tenants', id);
  await w.catalog.audit(null, u.name, 'tenant.delete', {tenantId: id});
  w.emitChange(null);
  return {};
}

/** Adds people to the page's tenant (#111) with one role; those already in it keep theirs. */
export async function addTenantMembers(w: Scope, req: AddTenantMembersRequest): Promise<MemberChangeResult> {
  const admin = w.permissionAdmin;
  if (!admin) return {error: NO_MEMBERS};
  const ids = [...new Set((req.userIds ?? []).map(x => String(x).trim()).filter(Boolean))].slice(0, 50);
  if (!ids.length) return {error: 'Pick someone to add.'};
  const role: TenantRole = req.role === 'admin' ? 'admin' : 'member';
  const id = tenantOf(w);
  const inIt = new Set((await admin.listTenantMembers(id)).map(m => m.userId));
  for (const userId of ids) if (!inIt.has(userId)) await admin.addTenantMember(w.ctx, id, userId, role);
  await w.catalog.audit(null, (await w.user()).name, 'tenant.members_added', {tenantId: id, count: ids.filter(x => !inIt.has(x)).length});
  w.emitChange(null);
  return {};
}

/** Changes a member's role (#111). The tenant always keeps an admin. */
export async function setTenantRole(w: Scope, req: SetTenantRoleRequest): Promise<MemberChangeResult> {
  return changeMember(w, req.userId, req.role === 'admin' ? 'admin' : 'member');
}

/** Takes someone out of the page's tenant (#111). The tenant always keeps an admin. */
export async function removeTenantMember(w: Scope, req: RemoveTenantMemberRequest): Promise<MemberChangeResult> {
  return changeMember(w, req.userId, null);
}

/** One member's role changed (`role`) or the member removed (null), under the tenant's members lock. */
async function changeMember(w: Scope, userId: string, role: TenantRole | null): Promise<MemberChangeResult> {
  const admin = w.permissionAdmin;
  if (!admin) return {error: NO_MEMBERS};
  const id = tenantOf(w);
  const out = await withLock(
    w,
    `members:${id}`,
    async (): Promise<MemberChangeResult> => {
      const members = await admin.listTenantMembers(id);
      const m = members.find(x => x.userId === userId);
      if (!m) return {error: 'This person is not in the tenant.'};
      if (m.role === role) return {};
      const min = minTenantAdmins();
      if (m.role === 'admin' && members.filter(x => x.role === 'admin').length <= min) {
        return {error: min <= 1 ? LAST_ADMIN : `A tenant must keep at least ${min} admins. Make someone else an admin first.`};
      }
      if (role) await admin.setTenantRole(w.ctx, id, userId, role);
      else await admin.removeTenantMember(w.ctx, id, userId);
      return {};
    },
    'Members are being changed. Try again in a minute.',
  );
  if (out.error) return out;
  await w.catalog.audit(null, (await w.user()).name, role ? 'tenant.role' : 'tenant.member_removed', {tenantId: id, role});
  w.emitChange(null);
  return {};
}

/** People to add, from the company directory (#111): 20 at most; none for a blank query or without a directory. */
export async function searchPeople(w: Scope, req: SearchPeopleRequest): Promise<Person[]> {
  const q = String(req.query ?? '').trim().slice(0, 100);
  if (!q || !w.people) return [];
  return (await w.people.search(q, 20)).slice(0, 20);
}

import type {CreateTenantRequest, CreateTenantResult, Tenant, TenantRole, TenantSummary} from '@yushiguang/sprint-contracts';
import {newId, systemConfig} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {withRetries} from './access.ts';
import {backfillTenants} from './projects.ts';
import {tenantOf, withLock} from './sources.ts';

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

/**
 * Creates a tenant and makes the caller its admin. Names are unique across Sprint (without case),
 * checked under one lock. When the admin cannot be written after its retries, the record is
 * removed again, so no tenant is left that nobody is in.
 */
export async function createTenant(w: Scope, req: CreateTenantRequest): Promise<CreateTenantResult> {
  const admin = w.permissionAdmin;
  if (!admin) throw new Error('Tenants cannot be created here.');
  const name = cleanTenantName(req.name);
  if (!name) return {error: NAME_BLANK};
  const u = await w.user();
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
    await withRetries(() => admin.addTenantMember(w.ctx, tenant.id, u.id, 'admin'), 3, w.grantRetryMs ?? 200);
  } catch {
    await w.catalog.remove('tenants', tenant.id);
    throw new Error('The tenant could not be created: you could not be made its admin. Try again.');
  }
  await w.catalog.audit(null, u.name, 'tenant.create', {tenantId: tenant.id});
  w.emitChange(null);
  return {tenant: {id: tenant.id, name: tenant.name, role: 'admin', projects: 0}};
}

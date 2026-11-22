import type {AuthorizationPort, PermissionAdminPort, TenantMember, TenantRole} from '@yushiguang/sprint-contracts';

/**
 * Single-tenant stand-in for the permission port: every action allowed. (The job store's
 * stand-in is `memoryJobStore`, the configuration platform's `memoryConfig`.)
 */
export const allowAll = (): AuthorizationPort => ({allowed: async () => true});

/**
 * Stand-in for the external permission platform's write side (`PermissionAdminPort`): tenant
 * members and project writers kept in this process. Every method is idempotent, as the port asks.
 */
export function memoryPermissionAdmin(): PermissionAdminPort & {
  /** What the store holds, for a checking `AuthorizationPort` in tests. */
  roleOf(tenantId: string, userId: string): TenantRole | null;
  canWrite(tenantId: string, projectId: string, userId: string): boolean;
} {
  const members = new Map<string, Map<string, TenantRole>>();
  const writers = new Map<string, Set<string>>();
  const tenant = (id: string) => members.get(id) ?? members.set(id, new Map()).get(id)!;
  const project = (tenantId: string, projectId: string) => {
    const k = `${tenantId}/${projectId}`;
    return writers.get(k) ?? writers.set(k, new Set()).get(k)!;
  };
  return {
    listTenantMembers: async tenantId => [...tenant(tenantId)].map(([userId, role]): TenantMember => ({userId, role})),
    async addTenantMember(_ctx, tenantId, userId, role) {
      tenant(tenantId).set(userId, role);
    },
    async removeTenantMember(_ctx, tenantId, userId) {
      tenant(tenantId).delete(userId);
    },
    async setTenantRole(_ctx, tenantId, userId, role) {
      if (tenant(tenantId).has(userId)) tenant(tenantId).set(userId, role);
    },
    listProjectWriters: async (tenantId, projectId) => [...project(tenantId, projectId)],
    async grantProjectWrite(_ctx, tenantId, projectId, userId) {
      project(tenantId, projectId).add(userId);
    },
    async revokeProjectWrite(_ctx, tenantId, projectId, userId) {
      project(tenantId, projectId).delete(userId);
    },
    roleOf: (tenantId, userId) => members.get(tenantId)?.get(userId) ?? null,
    canWrite: (tenantId, projectId, userId) => writers.get(`${tenantId}/${projectId}`)?.has(userId) ?? false,
  };
}

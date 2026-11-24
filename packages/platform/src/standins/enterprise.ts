import type {AccessRequest, AccessRequestPort, AuthorizationPort, PermissionAdminPort, Person, TenantMember, TenantRole, UserTenant} from '@yushiguang/sprint-contracts';

/**
 * Single-tenant stand-in for the permission port: every action allowed. (The job store's
 * stand-in is `memoryJobStore`, the configuration platform's `memoryConfig`.)
 */
export const allowAll = (): AuthorizationPort => ({allowed: async () => true});

/**
 * The browser stand-in for the permission check: allows everything, unless this browser holds
 * `sprint-standin-access` = `viewer` in its local storage. Then only reading is allowed, so the
 * member's view and the "insufficient access" dialog can be tried without a permission platform.
 */
export const standInAuthorization = (): AuthorizationPort => ({
  allowed: async (_ctx, request) => {
    if (request.permission === 'read') return true;
    try {
      return globalThis.localStorage?.getItem('sprint-standin-access') !== 'viewer';
    } catch {
      return true;
    }
  },
});

/** What `memoryPermissionAdmin` starts from, and where a browser keeps it. */
export interface MemoryPermissionOptions {
  /**
   * Members it holds before anything is kept (the local user as an admin of `default`). Their
   * names and emails are always known, even when what was kept says who is in which tenant.
   */
  seed?: (TenantMember & {tenantId: string})[];
  /** A local-storage key: what is written is kept there, so a reload keeps new tenants and members. */
  storageKey?: string;
  /** Names and emails of people who may be added later (the stand-in directory, #111). */
  people?: Person[];
}

/**
 * Stand-in for the external permission platform's write side (`PermissionAdminPort`): tenant
 * members and project writers kept in this process (and in local storage with `storageKey`).
 * Every method is idempotent, as the port asks.
 */
export function memoryPermissionAdmin(opts: MemoryPermissionOptions = {}): PermissionAdminPort & {
  /** What the store holds, for a checking `AuthorizationPort` in tests. */
  roleOf(tenantId: string, userId: string): TenantRole | null;
  canWrite(tenantId: string, projectId: string, userId: string): boolean;
} {
  const members = new Map<string, Map<string, TenantRole>>();
  const writers = new Map<string, Set<string>>();
  const tenant = (id: string) => members.get(id) ?? members.set(id, new Map()).get(id)!;
  const known = [...(opts.people ?? []).map(p => ({userId: p.id, name: p.name, email: p.email})), ...(opts.seed ?? [])];
  const profiles = new Map(known.filter(m => m.name || m.email).map(m => [m.userId, {...(m.name ? {name: m.name} : {}), ...(m.email ? {email: m.email} : {})}]));
  const project = (tenantId: string, projectId: string) => {
    const k = `${tenantId}/${projectId}`;
    return writers.get(k) ?? writers.set(k, new Set()).get(k)!;
  };
  const {storageKey} = opts;
  let kept: {members: [string, [string, TenantRole][]][]; writers: [string, string[]][]} | null = null;
  try {
    kept = storageKey ? JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? 'null') : null;
  } catch {
    // Unreadable or blocked storage: start from the seed.
  }
  // What was kept wins over the seed, so a member removed stays removed after a reload.
  if (kept) {
    for (const [t, list] of kept.members ?? []) for (const [u, r] of list) tenant(t).set(u, r);
    for (const [k, list] of kept.writers ?? []) writers.set(k, new Set(list));
  } else for (const m of opts.seed ?? []) tenant(m.tenantId).set(m.userId, m.role);
  const save = () => {
    if (!storageKey) return;
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify({members: [...members].map(([t, m]) => [t, [...m]]), writers: [...writers].map(([k, w]) => [k, [...w]])}));
    } catch {
      // Storage full or blocked: this page keeps the change.
    }
  };
  const admin: PermissionAdminPort & {
    roleOf(tenantId: string, userId: string): TenantRole | null;
    canWrite(tenantId: string, projectId: string, userId: string): boolean;
  } = {
    listTenantMembers: async tenantId => [...tenant(tenantId)].map(([userId, role]): TenantMember => ({userId, role, ...profiles.get(userId)})),
    listUserTenants: async userId => [...members].flatMap(([tenantId, m]): UserTenant[] => (m.has(userId) ? [{tenantId, role: m.get(userId)!}] : [])),
    async addTenantMember(_ctx, tenantId, userId, role) {
      tenant(tenantId).set(userId, role);
      save();
    },
    async removeTenantMember(_ctx, tenantId, userId) {
      tenant(tenantId).delete(userId);
      save();
    },
    async setTenantRole(_ctx, tenantId, userId, role) {
      if (tenant(tenantId).has(userId)) tenant(tenantId).set(userId, role);
      save();
    },
    listProjectWriters: async (tenantId, projectId) => [...project(tenantId, projectId)],
    async grantProjectWrite(_ctx, tenantId, projectId, userId) {
      project(tenantId, projectId).add(userId);
      save();
    },
    async revokeProjectWrite(_ctx, tenantId, projectId, userId) {
      project(tenantId, projectId).delete(userId);
      save();
    },
    async createTenant(this: PermissionAdminPort | undefined, ctx, {tenantId, adminIds}) {
      const target = this ?? admin;
      for (const userId of adminIds) await target.addTenantMember(ctx, tenantId, userId, 'admin');
    },
    async deleteTenant(_ctx, tenantId) {
      members.delete(tenantId);
      for (const k of [...writers.keys()]) if (k.startsWith(`${tenantId}/`)) writers.delete(k);
      save();
    },
    async createProject(this: PermissionAdminPort | undefined, ctx, {tenantId, projectId, creatorId}) {
      await (this ?? admin).grantProjectWrite(ctx, tenantId, projectId, creatorId);
    },
    async deleteProject(_ctx, tenantId, projectId) {
      writers.delete(`${tenantId}/${projectId}`);
      save();
    },
    roleOf: (tenantId, userId) => members.get(tenantId)?.get(userId) ?? null,
    canWrite: (tenantId, projectId, userId) => writers.get(`${tenantId}/${projectId}`)?.has(userId) ?? false,
  };
  return admin;
}

export interface MemoryAccessRequestOptions {
  mode?: 'submit' | 'redirect';
  applyUrl?: (request: AccessRequest) => string;
}

/**
 * Stand-in for the permission platform's request side (`AccessRequestPort`): requests are kept in
 * this process, with who asked, and there is no page to follow them on unless `applyUrl` is given.
 */
export function memoryAccessRequests(opts: MemoryAccessRequestOptions = {}): AccessRequestPort & {sent: (AccessRequest & {userId: string})[]} {
  const sent: (AccessRequest & {userId: string})[] = [];
  return {
    sent,
    ...(opts.mode ? {mode: opts.mode} : {}),
    async request(ctx, request) {
      sent.push({...request, userId: ctx.user.id});
      return opts.applyUrl ? {applyUrl: opts.applyUrl(request)} : {};
    },
  };
}

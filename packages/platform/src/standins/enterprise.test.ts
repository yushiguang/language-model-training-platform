import assert from 'node:assert/strict';
import test from 'node:test';
import {memoryPermissionAdmin, standInAuthorization} from './enterprise.ts';

const ctx = {requestId: 'rq_1', user: {id: 'u_admin', name: 'Admin'}};

test('memoryPermissionAdmin: members, roles and project writers per tenant; every write is idempotent', async () => {
  const p = memoryPermissionAdmin();
  await p.addTenantMember(ctx, 't1', 'u_1', 'member');
  await p.addTenantMember(ctx, 't1', 'u_1', 'member');
  await p.setTenantRole(ctx, 't1', 'u_1', 'admin');
  await p.setTenantRole(ctx, 't1', 'u_2', 'admin');
  assert.deepEqual(await p.listTenantMembers('t1'), [{userId: 'u_1', role: 'admin'}], 'a role is set only on a member');
  assert.deepEqual(await p.listTenantMembers('t2'), []);
  await p.grantProjectWrite(ctx, 't1', 'pr_1', 'u_1');
  await p.grantProjectWrite(ctx, 't1', 'pr_1', 'u_1');
  assert.deepEqual(await p.listProjectWriters('t1', 'pr_1'), ['u_1']);
  assert.equal(p.canWrite('t2', 'pr_1', 'u_1'), false, 'a grant is per tenant');
  await p.revokeProjectWrite(ctx, 't1', 'pr_1', 'u_1');
  await p.revokeProjectWrite(ctx, 't1', 'pr_1', 'u_1');
  await p.removeTenantMember(ctx, 't1', 'u_1');
  await p.removeTenantMember(ctx, 't1', 'u_1');
  assert.deepEqual(await p.listProjectWriters('t1', 'pr_1'), []);
  assert.equal(p.roleOf('t1', 'u_1'), null);
});

test('memoryPermissionAdmin (#94): lists a user\'s tenants, starts from a seed, and keeps what is written under a storage key', async () => {
  const kept = new Map<string, string>();
  const g = globalThis as {localStorage?: unknown};
  const before = g.localStorage;
  g.localStorage = {getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v)};
  try {
    const p = memoryPermissionAdmin({seed: [{tenantId: 'default', userId: 'u_1', role: 'admin'}], storageKey: 'perm'});
    await p.addTenantMember(ctx, 't2', 'u_1', 'member');
    await p.grantProjectWrite(ctx, 't2', 'pr_1', 'u_1');
    assert.deepEqual(await p.listUserTenants('u_1'), [{tenantId: 'default', role: 'admin'}, {tenantId: 't2', role: 'member'}]);
    assert.deepEqual(await p.listUserTenants('u_2'), []);
    const again = memoryPermissionAdmin({storageKey: 'perm'});
    assert.deepEqual(await again.listUserTenants('u_1'), [{tenantId: 'default', role: 'admin'}, {tenantId: 't2', role: 'member'}], 'a reload keeps them');
    assert.equal(again.canWrite('t2', 'pr_1', 'u_1'), true);
    assert.deepEqual(await memoryPermissionAdmin().listUserTenants('u_1'), [], 'without a key nothing is read');
  } finally {
    g.localStorage = before;
  }
});

test('standInAuthorization: allows everything, or only reading when the browser asks for a viewer (#91)', async () => {
  const auth = standInAuthorization();
  const ask = (permission: 'read' | 'project_write' | 'tenant_write') => auth.allowed(ctx, {action: 'workflow.x', permission, tenantId: 't1'} as never);
  assert.equal(await ask('tenant_write'), true);
  const store = new Map<string, string>([['sprint-standin-access', 'viewer']]);
  const g = globalThis as {localStorage?: unknown};
  const before = g.localStorage;
  g.localStorage = {getItem: (k: string) => store.get(k) ?? null};
  try {
    assert.equal(await ask('read'), true);
    assert.equal(await ask('project_write'), false);
    assert.equal(await ask('tenant_write'), false);
  } finally {
    g.localStorage = before;
  }
});

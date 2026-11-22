import assert from 'node:assert/strict';
import test from 'node:test';
import {memoryPermissionAdmin} from './enterprise.ts';

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

import {AccessDeniedError, SYSTEM_CALLER, type PermissionPoint, type Project, type RequestAccessRequest, type RequestAccessResult, type RequestContext, type TenantRole} from '@yushiguang/sprint-contracts';
import {newId} from '@yushiguang/sprint-domain';
import type {Instance, Scope} from './app.ts';
import {backfillTenants} from './projects.ts';
import {tenantOf} from './sources.ts';

/**
 * Permission checks and tenant isolation (docs/design/server.md, 2). The gateway checks each
 * interface, but agent tools, jobs and the Optimiser never pass it, so the workflow checks every
 * call again here, reads included.
 */

/** A project of another tenant reads exactly like one that does not exist. */
export const NO_PROJECT = 'This project does not exist.';

/**
 * Checks one action. First, unless the caller is Sprint itself (`SYSTEM_CALLER`), that the caller
 * holds `permission` (`AuthorizationPort`; none wired: everyone may), before any record is read:
 * a caller without it gets `AccessDeniedError` for every id alike, so it learns nothing about
 * which ids exist. Then, when the action names a project, that the project is the caller's
 * tenant's: another tenant's project fails exactly as a missing one would. A project that does
 * not exist is left to the action, which says so in its own words. Returns the project's record
 * (deleting or not) when there is one.
 */
export async function authorize(w: Scope, action: string, permission: PermissionPoint | null, projectId?: string): Promise<Project | null> {
  if (permission && w.ctx.caller !== SYSTEM_CALLER && w.authorization) {
    const ok = await w.authorization.allowed(w.ctx, {action, permission, ...(projectId ? {projectId} : {})});
    if (!ok) throw new AccessDeniedError(permission);
  }
  if (!projectId) return null;
  await backfillTenants(w);
  const project = await w.catalog.get('projects', projectId);
  if (project && project.tenantId !== tenantOf(w)) throw new Error(NO_PROJECT);
  return project;
}

/**
 * The caller's role in its tenant: `admin` when it holds `tenant_write`. With no `AuthorizationPort`
 * every signed-in user may do everything, so everyone is an admin.
 */
export async function tenantRole(w: Scope): Promise<TenantRole> {
  if (!w.authorization) return 'admin';
  return (await w.authorization.allowed(w.ctx, {action: 'workflow.runtimeInfo', permission: 'tenant_write'})) ? 'admin' : 'member';
}

const POINTS: PermissionPoint[] = ['read', 'project_write', 'tenant_write'];

/**
 * Passes a request for a permission point to the external permission platform
 * (docs/design/server.md, 2.2). Nothing is checked or stored here: approvers decide there.
 */
export async function requestAccess(w: Scope, req: RequestAccessRequest): Promise<RequestAccessResult> {
  if (!w.accessRequests) throw new Error('Requests for access are not set up here.');
  if (!POINTS.includes(req.permission)) throw new Error('There is no such permission.');
  const projectId = req.projectId?.trim();
  // Edit access is for one project, so the request must name it.
  if (req.permission === 'project_write' && !projectId) throw new Error('Name the project to ask for edit access to.');
  const reason = req.reason?.trim().slice(0, 1000);
  const r = await w.accessRequests.request(w.ctx, {tenantId: tenantOf(w), permission: req.permission, ...(projectId ? {projectId} : {}), ...(reason ? {reason} : {})});
  return r.trackUrl ? {trackUrl: r.trackUrl} : {};
}

/**
 * Sprint's own context in a tenant: work no person started by this call (the sweep, the work a
 * page's check queues). It cannot come from outside, since the bff sets its own caller.
 */
export function systemScope(inst: Instance, tenantId: string, from?: RequestContext): Scope {
  return inst.scope({requestId: newId('rq'), user: {id: SYSTEM_CALLER, name: SYSTEM_CALLER}, tenantId, caller: SYSTEM_CALLER, ...(from?.locale ? {locale: from.locale} : {}), ...(from?.appVersion ? {appVersion: from.appVersion} : {})});
}

/**
 * Calls the external permission platform, trying again up to `retries` more times with a growing
 * wait (docs/design/server.md, 2.3). The last error is thrown.
 */
export async function withRetries<T>(fn: () => Promise<T>, retries = 3, waitMs = 200): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= retries) throw e;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs * 2 ** i));
    }
  }
}

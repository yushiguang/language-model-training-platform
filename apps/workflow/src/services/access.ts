import {AccessDeniedError, SYSTEM_CALLER, type PermissionPoint, type Project, type RequestContext} from '@yushiguang/sprint-contracts';
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
 * Checks one action: when it names a project, that the project is the caller's tenant's; then,
 * unless the caller is Sprint itself (`SYSTEM_CALLER`, only the tenant is checked), that the
 * caller holds `permission` (`AuthorizationPort`; none wired: everyone may). A project that does
 * not exist is left to the action, which says so in its own words. Returns the project's record
 * (deleting or not) when there is one.
 */
export async function authorize(w: Scope, action: string, permission: PermissionPoint | null, projectId?: string): Promise<Project | null> {
  let project: Project | null = null;
  if (projectId) {
    await backfillTenants(w);
    project = await w.catalog.get('projects', projectId);
    if (project && project.tenantId !== tenantOf(w)) throw new Error(NO_PROJECT);
  }
  if (!permission || w.ctx.caller === SYSTEM_CALLER || !w.authorization) return project;
  const ok = await w.authorization.allowed(w.ctx, {action, permission, ...(projectId ? {projectId} : {})});
  if (!ok) throw new AccessDeniedError(permission);
  return project;
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

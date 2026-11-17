import type {AuthorizationPort, JobQueuePort, TenantConfigPort} from '@tsp/contracts';

/**
 * Single-tenant stand-ins for the enterprise ports: one tenant with no overrides, every action
 * allowed, and no job queue (jobs are refused, so callers keep running work in the page).
 */
export const singleTenantConfig = (): TenantConfigPort => ({configFor: async () => ({})});

export const allowAll = (): AuthorizationPort => ({allowed: async () => true});

export const noJobQueue = (): JobQueuePort => ({
  enqueue: async (_ctx, job) => {
    throw new Error(`No job queue here: "${job.kind}" runs in the open page.`);
  },
  cancel: async () => {},
});

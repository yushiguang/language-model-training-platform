import type {AuthorizationPort, TenantConfigPort} from '@sprint/contracts';

/**
 * Single-tenant stand-ins for the enterprise ports: one tenant with no overrides, and every action
 * allowed. (The job store's stand-in is `memoryJobStore`.)
 */
export const singleTenantConfig = (): TenantConfigPort => ({configFor: async () => ({})});

export const allowAll = (): AuthorizationPort => ({allowed: async () => true});

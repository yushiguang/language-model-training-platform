import type {AuthorizationPort} from '@yushiguang/sprint-contracts';

/**
 * Single-tenant stand-in for the permission port: every action allowed. (The job store's
 * stand-in is `memoryJobStore`, the configuration platform's `memoryConfig`.)
 */
export const allowAll = (): AuthorizationPort => ({allowed: async () => true});

import type {ConcurrencyKey, EndpointId} from '@yushiguang/sprint-contracts';
import {jobConcurrencyKey} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';
import {tenantOf} from './sources.ts';

/**
 * The concurrency key of a job this scope enqueues (docs/design/server.md, 5.1), in the caller's
 * tenant: by the time a project's job is queued, `authorize` has checked that it is the
 * project's tenant. Work that calls a model waits for its endpoint; all other work for compute.
 */
export const modelKey = (w: Scope, endpoint: EndpointId): ConcurrencyKey => jobConcurrencyKey(tenantOf(w), {kind: 'model', endpointId: endpoint});
export const computeKey = (w: Scope): ConcurrencyKey => jobConcurrencyKey(tenantOf(w), {kind: 'compute'});

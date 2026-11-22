import type {ConcurrencyKey, JobLimitTarget} from '@yushiguang/sprint-contracts';

/**
 * Job concurrency keys (docs/design/server.md, 5.1): `model:<tenantId>:<endpointId>` and
 * `compute:<tenantId>`. The tenant id is the system's own and never holds `:`; the endpoint id
 * is everything after the second `:`, so it may.
 */

/** The key a job of this tenant and target waits on. Throws on an id that would break the key. */
export function jobConcurrencyKey(tenantId: string, target: JobLimitTarget): ConcurrencyKey {
  if (!tenantId || tenantId.includes(':')) throw new Error(`A job's tenant id must be non-empty and hold no ':' (got "${tenantId}").`);
  if (target.kind === 'compute') return `compute:${tenantId}`;
  if (!target.endpointId) throw new Error("A model job's endpoint id must be non-empty.");
  return `model:${tenantId}:${target.endpointId}`;
}

/** The tenant and target of a key, or null when it is not one `jobConcurrencyKey` builds. */
export function parseConcurrencyKey(key: ConcurrencyKey): {tenantId: string; target: JobLimitTarget} | null {
  const [type, tenantId, ...rest] = key.split(':');
  if (!tenantId) return null;
  if (type === 'compute' && !rest.length) return {tenantId, target: {kind: 'compute'}};
  const endpointId = rest.join(':');
  if (type === 'model' && endpointId) return {tenantId, target: {kind: 'model', endpointId}};
  return null;
}

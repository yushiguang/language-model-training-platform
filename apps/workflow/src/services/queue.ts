import type {ConcurrencyKey, EndpointId, JobQueuePlace, LabelingRun, OptimisationRun} from '@yushiguang/sprint-contracts';
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

/**
 * Marks the labeling tasks and Optimiser runs whose job is still waiting with their place in the
 * queue (`queue.ahead`), for pages ("Queued · 2 ahead"). Only page views get it: the records and
 * the workflow's own rules never see it.
 */
export async function withQueue<T extends {runs: LabelingRun[]; optimisation: Pick<OptimisationRun, 'id' | 'queue'>[]}>(w: Scope, projectId: string, view: T | null): Promise<T | null> {
  if (!view) return view;
  const waiting = await w.jobs.list(w.ctx, {projectId, kinds: ['labeling.runTask', 'optimiser.run'], states: ['queued']});
  if (!waiting.length) return view;
  const places = new Map<string, JobQueuePlace>();
  for (const j of waiting) {
    const ahead = await w.jobs.ahead(w.ctx, j.id);
    if (ahead !== null) places.set(String(j.kind === 'labeling.runTask' ? j.args.taskId : j.args.runId), {ahead});
  }
  const mark = <R extends {id: string}>(r: R): R => (places.has(r.id) ? {...r, queue: places.get(r.id)} : r);
  return {...view, runs: view.runs.map(mark), optimisation: view.optimisation.map(mark)};
}

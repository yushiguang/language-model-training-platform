import {canScore} from '@tsp/domain';
import type {NodeId} from '@tsp/contracts';
import type {ProjectState} from '@/backend-api';

export type StepState = 'todo' | 'running' | 'done' | 'attention';

/**
 * The step bar (design: "Workflow steps"): Finished, In progress while a task runs in the step,
 * otherwise Not started. Finished steps stay usable.
 */
export function stepStates(s: ProjectState): Record<NodeId, StepState> {
  const ok = (n: NodeId) => s.facts.approved.includes(n);
  const promptRunning = s.runs.some(r => r.state === 'running') || s.optimisation.some(o => o.state === 'running');
  const total = s.facts.examples;
  return {
    prompt_design: s.versions.length ? 'done' : 'todo',
    dataset: s.samplingTask?.state === 'running' ? 'running' : s.snapshot || ok('dataset') ? 'done' : 'todo',
    gold: total > 0 && s.facts.goldEvalDone >= total ? 'done' : s.facts.goldEvalDone > 0 ? (canScore(s.facts) && ok('gold') ? 'done' : 'running') : 'todo',
    prompt: promptRunning ? 'running' : ok('prompt') ? 'done' : 'todo',
  };
}

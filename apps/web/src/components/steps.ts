import type {NodeId} from '@tsp/contracts';
import type {ProjectState} from '@/backend-api';

export type StepState = 'todo' | 'running' | 'done' | 'attention';

/** The newest run of each output set (Training Set page tabs). */
export const trainRun = (s: ProjectState) => s.trainingSets[0] ?? null;
export const testRun = (s: ProjectState) => s.testRuns[0] ?? null;

/**
 * The step bar (design: "Workflow steps"): Finished, In progress while a task runs in the step,
 * Needs attention when a run failed, otherwise Not started. Finished steps stay usable.
 */
export function stepStates(s: ProjectState): Record<NodeId, StepState> {
  const ok = (n: NodeId) => s.facts.approved.includes(n);
  const promptRunning = s.runs.some(r => r.state === 'running') || s.optimisation.some(o => o.state === 'running');
  const tr = trainRun(s);
  const te = testRun(s);
  const evalSize = s.snapshot?.split?.eval ?? 0;
  return {
    setup: ok('setup') ? 'done' : 'todo',
    dataset: s.samplingTask?.state === 'running' ? 'running' : s.snapshot?.split || ok('dataset') ? 'done' : 'todo',
    gold: evalSize > 0 && s.facts.goldEvalDone >= evalSize ? 'done' : s.gold.size > 0 ? 'running' : ok('gold') ? 'done' : 'todo',
    prompt: promptRunning ? 'running' : s.facts.passing.length || ok('prompt') ? 'done' : 'todo',
    training:
      tr?.state === 'failed' || te?.state === 'failed'
        ? 'attention'
        : tr?.state === 'done' && te?.state === 'done'
          ? 'done'
          : tr || te
            ? 'running'
            : 'todo',
  };
}

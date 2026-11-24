import type {Msg, NodeId, ProjectState, WorkflowFacts} from '@yushiguang/sprint-contracts';
import {systemConfig} from './config.ts';
import {msg, msgText} from './i18n.ts';

/** The four steps of a Prompt Tuning project (spec 1.0.0, 2.1), in order. */
export const NODES: {id: NodeId; label: string; path: string}[] = [
  {id: 'prompt_design', label: 'Prompt Design', path: '/prompt-design'},
  {id: 'dataset', label: 'Dataset', path: '/dataset'},
  {id: 'gold', label: 'Gold Labels', path: '/gold'},
  {id: 'prompt', label: 'Prompt Tuning', path: '/prompt'},
];

export interface Gate {
  ready: boolean;
  /** One line under the button when it is blocked (English). */
  reason: string | null;
  /** The same line as a catalog key and params (spec 1.1.0, 2.3). */
  msg: Msg | null;
}

/**
 * Enough gold labels to score at all: the hard minimum, with 2 in each half (the Optimiser learns
 * from one half, scores come from the other), once every label set is finished.
 */
export function canScore(f: Pick<WorkflowFacts, 'examples' | 'goldEvalDone' | 'goldHalves' | 'scoringReady'>): boolean {
  const {minEvalHard} = systemConfig().dataset;
  // Scores are made only once every label set is finished (docs/design/server.md 4.3).
  return f.scoringReady && f.examples >= minEvalHard && f.goldEvalDone >= minEvalHard && f.goldHalves.optimiser >= 2 && f.goldHalves.heldOut >= 2;
}

const READY: Gate = {ready: true, reason: null, msg: null};
const blocked = (m: Msg): Gate => ({ready: false, reason: msgText(m), msg: m});

export function gate(node: NodeId, f: WorkflowFacts): Gate {
  const {minEvalHard} = systemConfig().dataset;
  switch (node) {
    case 'prompt_design':
      return f.versions ? READY : blocked(msg('Save the first prompt to continue.'));
    case 'dataset':
      if (!f.snapshot) return blocked(msg('Add examples to continue.'));
      if (f.examples < minEvalHard) return blocked(msg('The eval dataset needs at least {n} examples.', {n: minEvalHard}));
      return READY;
    case 'gold':
      if (f.goldEvalDone >= minEvalHard && !f.scoringReady) return blocked(msg('Finish every label set to continue.'));
      if (!canScore(f)) return blocked(msg('Label at least {n} examples to continue ({done} so far).', {n: minEvalHard, done: f.goldEvalDone}));
      return READY;
    case 'prompt':
      if (!f.versions) return blocked(msg('Create the first prompt version.'));
      if (!f.passing.length) return blocked(msg('No version passes the threshold yet.'));
      return READY;
  }
}

export type StepState = 'todo' | 'running' | 'done' | 'attention';

/**
 * The step bar (design: "Workflow steps"): Finished, In progress while a task runs in the step,
 * otherwise Not started. Finished steps stay usable.
 */
export function stepStates(s: Pick<ProjectState, 'facts' | 'runs' | 'optimisation' | 'versions' | 'samplingTask' | 'snapshot'>): Record<NodeId, StepState> {
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

/** The step a project is at (the Overview's Next, the projects list): the first not finished; the last once all are. */
export function currentStep(s: Parameters<typeof stepStates>[0]): NodeId {
  const st = stepStates(s);
  return NODES.find(n => st[n.id] !== 'done')?.id ?? NODES[NODES.length - 1].id;
}

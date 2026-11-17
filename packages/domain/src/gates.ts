import type {Msg, NodeId, WorkflowFacts} from '@tsp/contracts';
import {systemConfig} from './config.ts';
import {msg, msgText} from './i18n.ts';

/** The four steps of a Prompt Tuning project (spec 1.0.0, 2.1), in order. */
export const NODES: {id: NodeId; label: string; path: string}[] = [
  {id: 'prompt_design', label: 'Prompt Design', path: '/prompt-design'},
  {id: 'dataset', label: 'Eval Dataset', path: '/dataset'},
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
 * from one half, scores come from the other). Scoring never waits for every example.
 */
export function canScore(f: Pick<WorkflowFacts, 'examples' | 'goldEvalDone' | 'goldHalves'>): boolean {
  const {minEvalHard} = systemConfig().dataset;
  return f.examples >= minEvalHard && f.goldEvalDone >= minEvalHard && f.goldHalves.optimiser >= 2 && f.goldHalves.heldOut >= 2;
}

const READY: Gate = {ready: true, reason: null, msg: null};
const blocked = (m: Msg): Gate => ({ready: false, reason: msgText(m), msg: m});

export function gate(node: NodeId, f: WorkflowFacts): Gate {
  const {minEvalHard} = systemConfig().dataset;
  switch (node) {
    case 'prompt_design':
      return f.versions ? READY : blocked(msg('Approve the first prompt to continue.'));
    case 'dataset':
      if (!f.snapshot) return blocked(msg('Add examples to continue.'));
      if (f.examples < minEvalHard) return blocked(msg('The eval dataset needs at least {n} examples.', {n: minEvalHard}));
      return READY;
    case 'gold':
      if (!canScore(f)) return blocked(msg('Label at least {n} examples to continue ({done} so far).', {n: minEvalHard, done: f.goldEvalDone}));
      return READY;
    case 'prompt':
      if (!f.versions) return blocked(msg('Create the first prompt version.'));
      if (!f.passing.length) return blocked(msg('No version passes the threshold yet.'));
      return READY;
  }
}

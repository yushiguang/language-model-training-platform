import type {NodeId, WorkflowFacts} from '@tsp/contracts';
import {systemConfig} from './config.ts';

/** The four steps of a Prompt Tuning project (spec 1.0.0, 2.1), in order. */
export const NODES: {id: NodeId; label: string; path: string}[] = [
  {id: 'prompt_design', label: 'Prompt Design', path: '/prompt-design'},
  {id: 'dataset', label: 'Eval Dataset', path: '/dataset'},
  {id: 'gold', label: 'Gold Labels', path: '/gold'},
  {id: 'prompt', label: 'Prompt Tuning', path: '/prompt'},
];

export interface Gate {
  ready: boolean;
  /** One line under the button when it is blocked. */
  reason: string | null;
}

/**
 * Enough gold labels to score at all: the hard minimum, with 2 in each half (the Optimiser learns
 * from one half, scores come from the other). Scoring never waits for every example.
 */
export function canScore(f: Pick<WorkflowFacts, 'examples' | 'goldEvalDone' | 'goldHalves'>): boolean {
  const {minEvalHard} = systemConfig().dataset;
  return f.examples >= minEvalHard && f.goldEvalDone >= minEvalHard && f.goldHalves.optimiser >= 2 && f.goldHalves.heldOut >= 2;
}

export function gate(node: NodeId, f: WorkflowFacts): Gate {
  const {minEvalHard} = systemConfig().dataset;
  switch (node) {
    case 'prompt_design':
      return f.versions ? {ready: true, reason: null} : {ready: false, reason: 'Approve the first prompt to continue.'};
    case 'dataset':
      if (!f.snapshot) return {ready: false, reason: 'Add examples to continue.'};
      if (f.examples < minEvalHard) return {ready: false, reason: `The eval dataset needs at least ${minEvalHard} examples.`};
      return {ready: true, reason: null};
    case 'gold':
      if (!canScore(f)) return {ready: false, reason: `Label at least ${minEvalHard} examples to continue (${f.goldEvalDone} so far).`};
      return {ready: true, reason: null};
    case 'prompt':
      if (!f.versions) return {ready: false, reason: 'Create the first prompt version.'};
      if (!f.passing.length) return {ready: false, reason: 'No version passes the threshold yet.'};
      return {ready: true, reason: null};
  }
}

export type NodeStatus = 'done' | 'current' | 'todo' | 'attention' | 'running';

/** The first node not yet approved is current. */
export function nodeStatuses(f: WorkflowFacts): Record<NodeId, NodeStatus> {
  const out = {} as Record<NodeId, NodeStatus>;
  let foundCurrent = false;
  for (const n of NODES) {
    if (f.approved.includes(n.id)) out[n.id] = 'done';
    else if (!foundCurrent) {
      out[n.id] = 'current';
      foundCurrent = true;
    } else out[n.id] = 'todo';
  }
  return out;
}

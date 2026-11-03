import type {DatasetSnapshot, EndpointId, NodeId, SetupVersion, TrainingSet} from './types.ts';

/**
 * Gate checks are pure functions of the current versions, so every screen agrees on whether
 * Next step is enabled. Pressing Next step writes a Gate approval; nothing else moves the workflow.
 */
export interface WorkflowFacts {
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  goldEvalDone: number;
  goldTestDone: number;
  versions: number;
  /** Versions with a report that passes the current thresholds, per model. */
  passing: {promptVersionId: string; endpoint: EndpointId}[];
  trainingSet: TrainingSet | null;
  approved: NodeId[];
}

export const NODES: {id: NodeId; label: string; optional?: boolean; path: string}[] = [
  {id: 'setup', label: 'Setup', path: '/setup'},
  {id: 'dataset', label: 'Dataset', path: '/dataset'},
  {id: 'gold', label: 'Gold Labels', optional: true, path: '/gold'},
  {id: 'prompt', label: 'Prompt Engineering', path: '/prompt'},
  {id: 'training', label: 'Training Set', path: '/training-set'},
];

export interface Gate {
  ready: boolean;
  /** One line under the button when it is blocked. */
  reason: string | null;
}

export function evaluationOn(f: WorkflowFacts): boolean {
  return !!f.setup?.thresholds;
}

export function gate(node: NodeId, f: WorkflowFacts): Gate {
  switch (node) {
    case 'setup': {
      const s = f.setup;
      if (!s?.steps.schema) return {ready: false, reason: 'Approve the labels first.'};
      if (!s.steps.evaluation) return {ready: false, reason: 'Choose how good the labels must be.'};
      if (!s.steps.models || !s.models.length) return {ready: false, reason: 'Pick at least one model.'};
      return {ready: true, reason: null};
    }
    case 'dataset': {
      const snap = f.snapshot;
      if (!snap) return {ready: false, reason: 'Add examples to continue.'};
      if (!snap.split) return {ready: false, reason: 'Set the split sizes to continue.'};
      const min = f.setup?.thresholds?.minEval ?? 0;
      if (evaluationOn(f) && snap.split.eval < min) return {ready: false, reason: `The eval set needs at least ${min} examples.`};
      if (snap.split.train <= 0) return {ready: false, reason: 'Leave some examples for train.'};
      return {ready: true, reason: null};
    }
    case 'gold':
      // Optional node: no gate. Scores start once the eval set is labeled.
      return {ready: true, reason: null};
    case 'prompt': {
      if (!f.versions) return {ready: false, reason: 'Create the first prompt version.'};
      if (!evaluationOn(f)) return {ready: true, reason: null};
      const evalSize = f.snapshot?.split?.eval ?? 0;
      if (f.goldEvalDone < evalSize) return {ready: false, reason: `Scores start when the eval set is labeled (${f.goldEvalDone} of ${evalSize}).`};
      if (!f.passing.length) return {ready: false, reason: 'No version passes the threshold yet.'};
      return {ready: true, reason: null};
    }
    case 'training':
      return f.trainingSet?.state === 'done' ? {ready: true, reason: null} : {ready: false, reason: 'Generate the training set first.'};
  }
}

export type NodeStatus = 'done' | 'current' | 'todo' | 'attention' | 'running';

/** The first node not yet approved is current; a failed long job marks its node. */
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
  if (f.trainingSet?.state === 'failed') out.training = 'attention';
  else if (f.trainingSet?.state === 'running') out.training = 'running';
  return out;
}

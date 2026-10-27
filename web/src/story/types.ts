import type {T} from '@/i18n/text';
import type {FieldId} from '@/mock/fields';

/** Every page the agent can create or update. Each opens in the modal over the chat. */
export type PanelId =
  | 'schema'
  | 'samples'
  | 'labeling'
  | 'adjudication'
  | 'evalReport'
  | 'promptDiff'
  | 'trainingSet'
  | 'runs'
  | 'gate'
  | 'efficiency';

export interface Option {
  id: string;
  label: T;
}

export interface Stat {
  label: T;
  value: string | T;
}

export interface Check {
  label: T;
  value: string | T;
  pass: boolean;
}

/** Cards the agent posts in the chat. Every card that waits for the user resolves to a choice id. */
export type Card =
  | {
      type: 'question';
      id: string;
      title: T;
      body?: T;
      postId?: string;
      options: Option[];
      recommended: string;
      reason: T;
    }
  | {
      type: 'approval';
      id: string;
      title: T;
      rows?: Stat[];
      checks?: Check[];
      approve: T;
      panel?: PanelId;
    }
  | {
      type: 'progress';
      id: string;
      title: T;
      total: number;
      unit: T;
      durationMs: number;
      /** For read-only conversations: a frozen fraction instead of a live run. */
      frozenAt?: number;
    }
  | {
      type: 'result';
      id: string;
      title: T;
      stats: Stat[];
      note?: T;
      panel?: PanelId;
    }
  | {
      type: 'advice';
      id: string;
      title: T;
      diagnosis: T;
      removed: string[];
      added: string[];
      from: 'v1' | 'v2';
      to: 'v2' | 'v3';
      /** What the agent measured on the eval split before proposing the change. */
      measures: Measure[];
    }
  | {
      type: 'link';
      id: string;
      title: T;
      description: T;
      panel: PanelId;
      cta: T;
      skip: T;
      /** How the user's answer reads in the chat once the task is done. */
      doneLabel: T;
    };

export type Measure =
  | {kind: 'macro'; field: FieldId}
  | {kind: 'value'; field: FieldId; value: string}
  | {kind: 'invalid'};

export interface ToolCall {
  name: string;
  target: T;
  duration: string;
}

export type Item =
  | {kind: 'user'; text: T}
  | {kind: 'agent'; text: T; tools?: ToolCall[]}
  | {kind: 'system'; text: T}
  | {kind: 'card'; card: Card}
  /** A write the agent made: a page it created or updated, shown as an artifact card. */
  | {kind: 'artifact'; panel: PanelId; action: 'created' | 'updated'; title: T; detail: T}
  /** The user's answer to a card, echoed as a user message. */
  | {kind: 'choice'; cardId: string}
  /** The agent's reply, which depends on the answer the user picked. */
  | {kind: 'reply'; cardId: string; replies: Record<string, T>};

export interface Step {
  /** Index into STAGES; STAGES.length means released. */
  stage: number;
  items: Item[];
  /** The card that must resolve before the next step. Absent on the last step. */
  waitFor?: string;
}

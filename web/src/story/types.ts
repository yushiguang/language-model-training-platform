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
      type: 'settings';
      id: string;
      title: T;
      fields: Setting[];
      submit: T;
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

/** One editable setting on a settings card. The card resolves to its values as JSON. */
export type Setting =
  | {id: string; label: T; kind: 'number'; value: number; min: number; max: number; step: number; units?: T}
  | {id: string; label: T; kind: 'select'; value: string; options: Option[]}
  /** Worked out from the other settings, shown but not editable. */
  | {id: string; label: T; kind: 'computed'; compute: (values: Record<string, string | number>) => string};

export type SettingValues = Record<string, string | number>;

/** Where one split stands: how many posts, how many have labels, and where the labels came from. */
export interface SplitStatus {
  total: number;
  labeled: number;
  source?: T;
}

export interface Datasets {
  train: SplitStatus;
  eval: SplitStatus;
  test: SplitStatus;
}

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
  | {kind: 'artifact'; panel: PanelId; action: 'created' | 'updated'; title: T; version?: string; detail: T}
  /** The user's answer to a card, echoed as a user message. */
  | {kind: 'choice'; cardId: string}
  /** The agent's reply, which depends on the answer the user picked. */
  | {kind: 'reply'; cardId: string; replies: Record<string, T>};

export interface Step {
  /** Index into STAGES; STAGES.length means released. */
  stage: number;
  items: Item[];
  /** The datasets from this step on; absent means unchanged. */
  datasets?: Datasets;
  /** The card that must resolve before the next step. Absent on the last step. */
  waitFor?: string;
}

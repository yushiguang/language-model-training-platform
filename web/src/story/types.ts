import type {T} from '@/i18n/text';
import type {FieldId} from '@/mock/fields';
import type {PromptId} from '@/mock/prompt';

/** Every page the agent can create or update. Each opens in the modal over the chat. */
export type PanelId = 'schema' | 'samples' | 'labeling' | 'adjudication' | 'evalReport' | 'promptDiff' | 'trainingSet' | 'runs' | 'gate' | 'efficiency';

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
      /** Which artifact of that kind to open, such as the eval report of one prompt. */
      panelRef?: string;
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
      panelRef?: string;
    }
  | {
      type: 'advice';
      id: string;
      title: T;
      diagnosis: T;
      from: PromptId;
      /** One change to adopt, or several to run side by side from the same base version. */
      variants: PromptVariant[];
      /** What the agent measured on the eval split before proposing a single change. */
      measures?: Measure[];
    }
  /**
   * Next steps the agent suggests, kept out of the conversation: chips above the composer and the
   * first one as a hint inside it. Sending a suggestion's text answers the card.
   */
  | {
      type: 'next';
      id: string;
      suggestions: Suggestion[];
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

export interface PromptVariant {
  to: PromptId;
  /** What this variant tries, in a few words. */
  note: T;
  removed: string[];
  added: string[];
}

export interface Suggestion {
  id: string;
  /** The chip's words. */
  label: T;
  /** What the composer sends. */
  text: T;
  /** For read-only conversations: the agent's answer when the suggestion is sent. */
  reply?: T;
}

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

export type Measure = {kind: 'macro'; field: FieldId} | {kind: 'value'; field: FieldId; value: string} | {kind: 'invalid'};

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
  /** A file the user attached to a message. */
  | {kind: 'file'; name: string; size: string; detail?: T}
  /**
   * A write the agent made: a page it created or updated, shown as an artifact card. `ref` tells
   * apart artifacts of the same kind, such as one eval report per prompt; `gate` says whether that run passed.
   */
  | {kind: 'artifact'; panel: PanelId; action: 'created' | 'updated'; title: T; version?: string; detail: T; ref?: string; gate?: boolean}
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
  /** Only on this path: the step is skipped unless the card was answered with this choice. */
  when?: {cardId: string; choice: string};
}

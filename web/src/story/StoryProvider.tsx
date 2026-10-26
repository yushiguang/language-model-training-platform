'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode} from 'react';
import {t, type T} from '@/i18n/text';
import {CONTENT_VALUE_STEPS, RELEASED_STAGE} from './contentValue';
import {MODELS, type ModelStatus} from './models';
import type {Card, Item, PanelId} from './types';

const STEPS = CONTENT_VALUE_STEPS;

interface State {
  /** Index of the step whose items are being revealed or whose card is awaited. */
  cursor: number;
  log: Item[];
  pending: Item[];
  choices: Record<string, string>;
  progressStart: Record<string, number>;
  selectedModel: string;
  panel: PanelId | null;
  isPanelExpanded: boolean;
}

type Action =
  | {type: 'reveal'; now: number}
  | {type: 'resolve'; cardId: string; choice: string}
  | {type: 'say'; text: string}
  | {type: 'selectModel'; id: string}
  | {type: 'openPanel'; panel: PanelId}
  | {type: 'closePanel'}
  | {type: 'toggleExpanded'}
  | {type: 'restart'};

function initialState(): State {
  return {
    cursor: 0,
    log: [],
    pending: STEPS[0].items,
    choices: {},
    progressStart: {},
    selectedModel: MODELS[0].id,
    panel: null,
    isPanelExpanded: false,
  };
}

const CANNED_REPLY = t(
  'This demo follows a script. To continue, use the buttons on the latest card.',
  '这个演示按脚本进行。请使用最新卡片上的按钮继续。',
);

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reveal': {
      if (state.pending.length === 0) return state;
      const [next, ...rest] = state.pending;
      const progressStart =
        next.kind === 'card' && next.card.type === 'progress'
          ? {...state.progressStart, [next.card.id]: action.now}
          : state.progressStart;
      return {...state, log: [...state.log, next], pending: rest, progressStart};
    }
    case 'resolve': {
      const step = STEPS[state.cursor];
      if (step.waitFor !== action.cardId || state.pending.length > 0 || state.cursor >= STEPS.length - 1) return state;
      const cursor = state.cursor + 1;
      return {
        ...state,
        cursor,
        pending: STEPS[cursor].items,
        choices: {...state.choices, [action.cardId]: action.choice},
      };
    }
    case 'say': {
      const text = {en: action.text, zh: action.text};
      return {...state, log: [...state.log, {kind: 'user', text}, {kind: 'agent', text: CANNED_REPLY}]};
    }
    case 'selectModel':
      return {...state, selectedModel: action.id, panel: null, isPanelExpanded: false};
    case 'openPanel':
      return {...state, panel: action.panel};
    case 'closePanel':
      return {...state, panel: null, isPanelExpanded: false};
    case 'toggleExpanded':
      return {...state, isPanelExpanded: !state.isPanelExpanded};
    case 'restart':
      return {...initialState(), selectedModel: state.selectedModel};
  }
}

/** Pause before each item appears, so the agent reads as working rather than dumping text. */
function revealDelay(item: Item): number {
  switch (item.kind) {
    case 'user':
    case 'choice':
      return 150;
    case 'system':
      return 250;
    case 'agent':
    case 'reply':
      return 750;
    case 'card':
      return 450;
  }
}

/** Which story card must resolve before each panel has something to show. */
const PANEL_UNLOCKED_BY: Record<PanelId, string | null> = {
  schema: null,
  samples: 'a-schema',
  labeling: 'a-sampling',
  evalReport: 'pr-v1',
  promptDiff: 'adv-1',
  trainingSet: 'pr-batch',
  runs: 'pr-train',
  gate: 'q-more',
  efficiency: 'a-release',
};

export const CARDS: Record<string, Card> = Object.fromEntries(
  [...STEPS.flatMap(s => s.items), ...MODELS.flatMap(m => m.items ?? [])]
    .filter((item): item is Extract<Item, {kind: 'card'}> => item.kind === 'card')
    .map(item => [item.card.id, item.card]),
);

const LINK_DONE = t('I labeled my 5 posts', '我标完了 5 条');
const ADOPT = t('Adopt', '采纳');

/** The words Lin's answer to a card shows as, echoed in the chat. */
export function choiceLabel(card: Card, choice: string): T | null {
  switch (card.type) {
    case 'question':
      return card.options.find(o => o.id === choice)?.label ?? null;
    case 'approval':
      return card.approve;
    case 'advice':
      return ADOPT;
    case 'link':
      return choice === 'skip' ? card.skip : LINK_DONE;
    default:
      return null;
  }
}

interface StoryContextValue {
  state: State;
  stage: number;
  status: ModelStatus;
  /** The card waiting on Lin, if any. */
  awaitedCardId: string | null;
  resolve: (cardId: string, choice: string) => void;
  say: (text: string) => void;
  selectModel: (id: string) => void;
  openPanel: (panel: PanelId) => void;
  closePanel: () => void;
  toggleExpanded: () => void;
  restart: () => void;
  isPanelAvailable: (panel: PanelId) => boolean;
  isResolved: (cardId: string) => boolean;
}

const StoryContext = createContext<StoryContextValue | null>(null);

export function StoryProvider({children}: {children: ReactNode}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    if (state.pending.length === 0) return;
    const timer = setTimeout(() => dispatch({type: 'reveal', now: Date.now()}), revealDelay(state.pending[0]));
    return () => clearTimeout(timer);
  }, [state.pending]);

  // A running job resolves its own card when its time is up.
  const step = STEPS[state.cursor];
  const awaited = step.waitFor && state.pending.length === 0 && !(step.waitFor in state.choices) ? step.waitFor : null;
  const awaitedStart = awaited ? state.progressStart[awaited] : undefined;
  useEffect(() => {
    if (!awaited || awaitedStart === undefined) return;
    const card = CARDS[awaited];
    if (card.type !== 'progress') return;
    const remaining = Math.max(0, awaitedStart + card.durationMs - Date.now());
    const timer = setTimeout(() => dispatch({type: 'resolve', cardId: awaited, choice: 'done'}), remaining);
    return () => clearTimeout(timer);
  }, [awaited, awaitedStart]);

  const resolve = useCallback((cardId: string, choice: string) => dispatch({type: 'resolve', cardId, choice}), []);
  const say = useCallback((text: string) => dispatch({type: 'say', text}), []);
  const selectModel = useCallback((id: string) => dispatch({type: 'selectModel', id}), []);
  const openPanel = useCallback((panel: PanelId) => dispatch({type: 'openPanel', panel}), []);
  const closePanel = useCallback(() => dispatch({type: 'closePanel'}), []);
  const toggleExpanded = useCallback(() => dispatch({type: 'toggleExpanded'}), []);
  const restart = useCallback(() => dispatch({type: 'restart'}), []);

  const value = useMemo<StoryContextValue>(() => {
    const isResolved = (cardId: string) => cardId in state.choices;
    let status: ModelStatus;
    if (state.pending.length > 0) status = 'running';
    else if (!awaited) status = 'idle';
    else status = CARDS[awaited].type === 'progress' ? 'running' : 'waiting';
    return {
      state,
      stage: step.stage,
      status,
      awaitedCardId: awaited,
      resolve,
      say,
      selectModel,
      openPanel,
      closePanel,
      toggleExpanded,
      restart,
      isResolved,
      isPanelAvailable: panel => {
        const key = PANEL_UNLOCKED_BY[panel];
        return key === null || isResolved(key);
      },
    };
  }, [state, step.stage, awaited, resolve, say, selectModel, openPanel, closePanel, toggleExpanded, restart]);

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}

export function useStory(): StoryContextValue {
  const value = useContext(StoryContext);
  if (!value) throw new Error('useStory must be used inside StoryProvider');
  return value;
}

export {RELEASED_STAGE};

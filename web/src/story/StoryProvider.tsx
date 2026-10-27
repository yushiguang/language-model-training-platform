'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode} from 'react';
import {t, type T} from '@/i18n/text';
import type {Labels} from '@/mock/posts';
import {CONFLICTS} from '@/mock/posts';
import {MODELS, type ModelStatus} from './models';
import type {Card, Item, PanelId} from './types';
import {RELEASED_STAGE, VIDEO_TAGS_STEPS} from './videoTags';

const STEPS = VIDEO_TAGS_STEPS;

interface State {
  /** Index of the step whose items are being revealed or whose card is awaited. */
  cursor: number;
  log: Item[];
  pending: Item[];
  choices: Record<string, string>;
  progressStart: Record<string, number>;
  selectedModel: string;
  /** The artifact open in the modal over the chat. */
  panel: PanelId | null;
  /** The user's own labels, kept here so closing the modal doesn't lose them. */
  myLabels: Record<string, Labels>;
  /** Prompt edits the user saved on the prompt page; none of them is scored or adopted in the demo. */
  promptDrafts: string[];
  /** The user's decision on each sample disagreement shown on the page. */
  rulings: Record<string, string[]>;
  /** The user accepted the agent's suggestion for every disagreement they didn't decide. */
  hasAcceptedRest: boolean;
}

type Action =
  | {type: 'reveal'; now: number}
  | {type: 'resolve'; cardId: string; choice: string}
  | {type: 'say'; text: string}
  | {type: 'selectModel'; id: string}
  | {type: 'openPanel'; panel: PanelId}
  | {type: 'closePanel'}
  | {type: 'saveLabels'; postId: string; labels: Labels}
  | {type: 'savePromptDraft'; text: string}
  | {type: 'rule'; conflictId: string; values: string[]}
  | {type: 'acceptRest'}
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
    myLabels: {},
    promptDrafts: [],
    rulings: {},
    hasAcceptedRest: false,
  };
}

const CANNED_REPLY = t(
  'This demo follows a script. To continue, use the buttons on the latest card.',
  '这个演示按脚本进行。请使用最新卡片上的按钮继续。',
);

function suggestionsForRest(rulings: Record<string, string[]>): Record<string, string[]> {
  const next = {...rulings};
  for (const c of CONFLICTS) if (!(c.id in next)) next[c.id] = c.suggestion;
  return next;
}

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
      // "Accept all suggestions" from the chat settles every disagreement the same way the page's bulk action does.
      const isAcceptAll = action.cardId === 'l-adj' && action.choice === 'skip';
      return {
        ...state,
        cursor,
        pending: STEPS[cursor].items,
        choices: {...state.choices, [action.cardId]: action.choice},
        rulings: isAcceptAll ? suggestionsForRest(state.rulings) : state.rulings,
        hasAcceptedRest: state.hasAcceptedRest || isAcceptAll,
      };
    }
    case 'say': {
      const text = {en: action.text, zh: action.text};
      return {...state, log: [...state.log, {kind: 'user', text}, {kind: 'agent', text: CANNED_REPLY}]};
    }
    case 'selectModel':
      return {...state, selectedModel: action.id, panel: null};
    case 'openPanel':
      return {...state, panel: action.panel};
    case 'closePanel':
      return {...state, panel: null};
    case 'savePromptDraft':
      return {...state, promptDrafts: [...state.promptDrafts, action.text]};
    case 'saveLabels':
      return {...state, myLabels: {...state.myLabels, [action.postId]: action.labels}};
    case 'rule':
      return {...state, rulings: {...state.rulings, [action.conflictId]: action.values}};
    case 'acceptRest':
      return {...state, rulings: suggestionsForRest(state.rulings), hasAcceptedRest: true};
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
    case 'artifact':
      return 550;
    case 'card':
      return 450;
  }
}

export const CARDS: Record<string, Card> = Object.fromEntries(
  [...STEPS.flatMap(s => s.items), ...MODELS.flatMap(m => m.items ?? [])]
    .filter((item): item is Extract<Item, {kind: 'card'}> => item.kind === 'card')
    .map(item => [item.card.id, item.card]),
);

/** An artifact as it stands now: its latest title, and what it is from when it was created. */
export interface ArtifactEntry {
  panel: PanelId;
  title: T;
  detail: T;
  /** How many times the agent wrote to it; 1 means only created. */
  writes: number;
}

/** Artifacts in the order they were created, each with its latest title. */
export function artifactsIn(log: Item[]): ArtifactEntry[] {
  const byPanel = new Map<PanelId, ArtifactEntry>();
  for (const item of log) {
    if (item.kind !== 'artifact') continue;
    const prev = byPanel.get(item.panel);
    // An update's detail says what changed, so the entry keeps the detail from creation.
    byPanel.set(item.panel, {panel: item.panel, title: item.title, detail: prev?.detail ?? item.detail, writes: (prev?.writes ?? 0) + 1});
  }
  return [...byPanel.values()];
}

const ADOPT = t('Adopt', '采纳');

/** The words the user's answer to a card shows as, echoed in the chat. */
export function choiceLabel(card: Card, choice: string): T | null {
  switch (card.type) {
    case 'question':
      return card.options.find(o => o.id === choice)?.label ?? null;
    case 'approval':
      return card.approve;
    case 'advice':
      return ADOPT;
    case 'link':
      return choice === 'skip' ? card.skip : card.doneLabel;
    default:
      return null;
  }
}

interface StoryContextValue {
  state: State;
  stage: number;
  status: ModelStatus;
  /** The card waiting on the user, if any. */
  awaitedCardId: string | null;
  artifacts: ArtifactEntry[];
  resolve: (cardId: string, choice: string) => void;
  say: (text: string) => void;
  selectModel: (id: string) => void;
  openPanel: (panel: PanelId) => void;
  closePanel: () => void;
  saveLabels: (postId: string, labels: Labels) => void;
  savePromptDraft: (text: string) => void;
  rule: (conflictId: string, values: string[]) => void;
  acceptRest: () => void;
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
  const savePromptDraft = useCallback((text: string) => dispatch({type: 'savePromptDraft', text}), []);
  const saveLabels = useCallback((postId: string, labels: Labels) => dispatch({type: 'saveLabels', postId, labels}), []);
  const rule = useCallback((conflictId: string, values: string[]) => dispatch({type: 'rule', conflictId, values}), []);
  const acceptRest = useCallback(() => dispatch({type: 'acceptRest'}), []);
  const restart = useCallback(() => dispatch({type: 'restart'}), []);

  const artifacts = useMemo(() => artifactsIn(state.log), [state.log]);

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
      artifacts,
      resolve,
      say,
      selectModel,
      openPanel,
      closePanel,
      saveLabels,
      savePromptDraft,
      rule,
      acceptRest,
      restart,
      isResolved,
      isPanelAvailable: panel => artifacts.some(a => a.panel === panel),
    };
  }, [state, step.stage, awaited, artifacts, resolve, say, selectModel, openPanel, closePanel, saveLabels, savePromptDraft, rule, acceptRest, restart]);

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}

export function useStory(): StoryContextValue {
  const value = useContext(StoryContext);
  if (!value) throw new Error('useStory must be used inside StoryProvider');
  return value;
}

export {RELEASED_STAGE};

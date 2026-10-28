'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode} from 'react';
import {t, type T} from '@/i18n/text';
import type {Labels} from '@/mock/posts';
import {CONFLICTS} from '@/mock/posts';
import {MODELS, type ModelStatus} from './models';
import type {PromptId} from '@/mock/prompt';
import type {Card, Datasets, Item, PanelId, SettingValues, Step} from './types';
import {RELEASED_STAGE, VIDEO_TAGS_STEPS} from './videoTags';

const STEPS = VIDEO_TAGS_STEPS;

const isOnPath = (step: Step, choices: Record<string, string>) => !step.when || choices[step.when.cardId] === step.when.choice;

/** The next step on the path the user's answers chose, or STEPS.length when there is none. */
function nextStep(from: number, choices: Record<string, string>): number {
  let i = from + 1;
  while (i < STEPS.length && !isOnPath(STEPS[i], choices)) i++;
  return i;
}

/** An artifact open in the modal: its kind, and which one when there are several, such as one eval report per prompt. */
export interface OpenArtifact {
  panel: PanelId;
  ref?: string;
  /** What to show first inside the page, such as one prompt version. */
  focus?: string;
}

/** A prompt the user edited on the prompt page, and the version it started from. */
export interface PromptDraft {
  text: string;
  parent: PromptId;
}

interface State {
  /** Index of the step whose items are being revealed or whose card is awaited. */
  cursor: number;
  log: Item[];
  pending: Item[];
  choices: Record<string, string>;
  progressStart: Record<string, number>;
  selectedModel: string;
  /** The artifact open in the modal over the chat. */
  panel: OpenArtifact | null;
  /** The user's own labels, kept here so closing the modal doesn't lose them. */
  myLabels: Record<string, Labels>;
  /** Prompt edits the user saved on the prompt page; none of them is scored or adopted in the demo. */
  promptDrafts: PromptDraft[];
  /** The user's decision on each sample disagreement shown on the page. */
  rulings: Record<string, string[]>;
  /** The user accepted the agent's suggestion for every disagreement they didn't decide. */
  hasAcceptedRest: boolean;
  /** Schema edits the user sent to the agent from the schema page, as JSON. */
  schemaEdits: string[];
  /** Models the user started training on outside the script (the fast path). */
  trainedModels: string[];
  /** Messages added to read-only conversations, such as /train or an attached file, by model. */
  extra: Record<string, Item[]>;
}

type Action =
  | {type: 'reveal'; now: number}
  | {type: 'resolve'; cardId: string; choice: string}
  | {type: 'say'; text: string}
  | {type: 'append'; modelId: string | null; items: Item[]}
  | {type: 'selectModel'; id: string}
  | {type: 'openPanel'; panel: PanelId; ref?: string; focus?: string}
  | {type: 'closePanel'}
  | {type: 'saveLabels'; postId: string; labels: Labels}
  | {type: 'savePromptDraft'; draft: PromptDraft}
  | {type: 'rule'; conflictId: string; values: string[]}
  | {type: 'acceptRest'}
  | {type: 'sendSchemaEdit'; json: string}
  | {type: 'trainNow'; modelId: string; items: Item[]}
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
    schemaEdits: [],
    trainedModels: [],
    extra: {},
  };
}

const CANNED_REPLY = t('This demo follows a script. To continue, use the buttons on the latest card.', '这个演示按脚本进行。请使用最新卡片上的按钮继续。');

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
      const progressStart = next.kind === 'card' && next.card.type === 'progress' ? {...state.progressStart, [next.card.id]: action.now} : state.progressStart;
      return {
        ...state,
        log: [...state.log, next],
        pending: rest,
        progressStart,
      };
    }
    case 'resolve': {
      const step = STEPS[state.cursor];
      const choices = {...state.choices, [action.cardId]: action.choice};
      const cursor = nextStep(state.cursor, choices);
      if (step.waitFor !== action.cardId || state.pending.length > 0 || cursor >= STEPS.length) return state;
      // "Accept all suggestions" from the chat settles every disagreement the same way the page's bulk action does.
      const isAcceptAll = action.cardId === 'l-adj' && action.choice === 'skip';
      return {
        ...state,
        cursor,
        pending: STEPS[cursor].items,
        choices,
        rulings: isAcceptAll ? suggestionsForRest(state.rulings) : state.rulings,
        hasAcceptedRest: state.hasAcceptedRest || isAcceptAll,
      };
    }
    case 'say': {
      const text = {en: action.text, zh: action.text};
      return {
        ...state,
        log: [...state.log, {kind: 'user', text}, {kind: 'agent', text: CANNED_REPLY}],
      };
    }
    case 'append':
      if (action.modelId === null) return {...state, log: [...state.log, ...action.items]};
      return {...state, extra: {...state.extra, [action.modelId]: [...(state.extra[action.modelId] ?? []), ...action.items]}};
    case 'selectModel':
      return {...state, selectedModel: action.id, panel: null};
    case 'openPanel':
      return {...state, panel: {panel: action.panel, ref: action.ref, focus: action.focus}};
    case 'closePanel':
      return {...state, panel: null};
    case 'savePromptDraft':
      return {...state, promptDrafts: [...state.promptDrafts, action.draft]};
    case 'saveLabels':
      return {
        ...state,
        myLabels: {...state.myLabels, [action.postId]: action.labels},
      };
    case 'rule':
      return {
        ...state,
        rulings: {...state.rulings, [action.conflictId]: action.values},
      };
    case 'acceptRest':
      return {
        ...state,
        rulings: suggestionsForRest(state.rulings),
        hasAcceptedRest: true,
      };
    case 'sendSchemaEdit': {
      const n = state.schemaEdits.length + 1;
      const items: Item[] = [
        {kind: 'system', text: t('You saved the schema', '你保存了 Schema')},
        {
          kind: 'agent',
          tools: [{name: 'review_schema_change', target: t(`your edit ${n}`, `你的第 ${n} 次修改`), duration: '2s'}],
          text: t(
            'I picked up your saved schema. In the product I’d check it against the labeled posts, flag anything that breaks earlier labels, and update the teacher prompt to match. This demo keeps its script, so the story continues with the schema as drafted.',
            '我收到了你保存的 Schema。在正式产品里，我会用已标注的帖子检查它，标出会影响已有标签的地方，并同步更新教师 Prompt。演示按脚本进行，所以后面仍沿用起草的 Schema。',
          ),
        },
        {
          kind: 'artifact',
          panel: 'schema',
          action: 'updated',
          title: t('Schema', 'Schema'),
          version: 'v1',
          detail: t(`Your edit ${n}, saved`, `你的第 ${n} 次修改，已保存`),
        },
      ];
      return {
        ...state,
        schemaEdits: [...state.schemaEdits, action.json],
        log: [...state.log, ...items],
        panel: null,
      };
    }
    case 'trainNow':
      if (state.trainedModels.includes(action.modelId)) return state;
      return {
        ...state,
        trainedModels: [...state.trainedModels, action.modelId],
        extra: {...state.extra, [action.modelId]: [...(state.extra[action.modelId] ?? []), ...action.items]},
      };
    case 'restart':
      return {...initialState(), selectedModel: state.selectedModel};
  }
}

/** Pause before each item appears, so the agent reads as working rather than dumping text. */
function revealDelay(item: Item): number {
  switch (item.kind) {
    case 'user':
    case 'file':
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
  [...STEPS.flatMap(s => s.items), ...MODELS.flatMap(m => [...(m.items ?? []), ...(m.afterTrain ?? [])])]
    .filter((item): item is Extract<Item, {kind: 'card'}> => item.kind === 'card')
    .map(item => [item.card.id, item.card]),
);

/** An artifact as it stands now: its latest title, and what it is from when it was created. */
export interface ArtifactEntry {
  panel: PanelId;
  ref?: string;
  /** Whether the run it reports passed the gate, for eval reports. */
  gate?: boolean;
  title: T;
  detail: T;
  /** The latest version the agent wrote, shown as a tag beside the title. */
  version?: string;
  /** How many times the agent wrote to it; 1 means only created. */
  writes: number;
}

/** Artifacts in the order they were created, each with its latest title. */
export function artifactsIn(log: Item[]): ArtifactEntry[] {
  const byKey = new Map<string, ArtifactEntry>();
  for (const item of log) {
    if (item.kind !== 'artifact') continue;
    const key = item.ref ? `${item.panel}:${item.ref}` : item.panel;
    const prev = byKey.get(key);
    // An update's detail says what changed, so the entry keeps the detail from creation.
    byKey.set(key, {
      panel: item.panel,
      ref: item.ref,
      gate: item.gate ?? prev?.gate,
      title: item.title,
      version: item.version ?? prev?.version,
      detail: prev?.detail ?? item.detail,
      writes: (prev?.writes ?? 0) + 1,
    });
  }
  return [...byKey.values()];
}

/** The artifact to show for a kind and optional ref: that exact one, or the newest of its kind. */
export function findArtifact(artifacts: ArtifactEntry[], panel: PanelId, ref?: string): ArtifactEntry | undefined {
  const ofKind = artifacts.filter(a => a.panel === panel);
  return ref ? ofKind.find(a => a.ref === ref) : ofKind[ofKind.length - 1];
}

const ADOPT = t('Adopt', '采纳');
const RUN_ALL = t('Run both', '两个都运行');

/** The words the user's answer to a card shows as, echoed in the chat. */
export function choiceLabel(card: Card, choice: string): T | null {
  switch (card.type) {
    case 'question':
      return card.options.find(o => o.id === choice)?.label ?? null;
    case 'approval':
      return choice === 'command' ? {en: '/train', zh: '/train'} : card.approve;
    case 'advice':
      return card.variants.length > 1 ? RUN_ALL : ADOPT;
    case 'next':
      return card.suggestions.find(s => s.id === choice)?.text ?? card.suggestions[0].text;
    case 'link':
      return choice === 'skip' ? card.skip : card.doneLabel;
    case 'settings':
      return settingsSummary(card, JSON.parse(choice) as SettingValues);
    default:
      return null;
  }
}

/** Settings as the user submitted them, one value after another, as their reply in the chat. */
function settingsSummary(card: Extract<Card, {type: 'settings'}>, values: SettingValues): T {
  const line = (lang: 'en' | 'zh') =>
    card.fields
      .map(f => {
        switch (f.kind) {
          case 'number':
            return `${f.label[lang]} ${Number(values[f.id]).toLocaleString('en-US')}`;
          case 'select':
            return f.options.find(o => o.id === values[f.id])?.label[lang] ?? '';
          case 'computed':
            return `${f.label[lang]} ${f.compute(values)}`;
        }
      })
      .join(' · ');
  return {en: line('en'), zh: line('zh')};
}

/** The datasets as of the step the story is on, along the path the user's answers chose. */
function datasetsAt(cursor: number, choices: Record<string, string>): Datasets | null {
  for (let i = cursor; i >= 0; i--) if (STEPS[i].datasets && isOnPath(STEPS[i], choices)) return STEPS[i].datasets!;
  return null;
}

interface StoryContextValue {
  state: State;
  stage: number;
  status: ModelStatus;
  /** The card waiting on the user, if any. */
  awaitedCardId: string | null;
  artifacts: ArtifactEntry[];
  datasets: Datasets | null;
  resolve: (cardId: string, choice: string) => void;
  say: (text: string) => void;
  /** A message from the user and the agent's answer outside the script, such as a command it can't run yet. */
  exchange: (user: T, agent: T, modelId?: string) => void;
  /** Adds items to a conversation: the scripted one, or a read-only model's by id. */
  append: (items: Item[], modelId?: string) => void;
  selectModel: (id: string) => void;
  openPanel: (panel: PanelId, ref?: string, focus?: string) => void;
  closePanel: () => void;
  saveLabels: (postId: string, labels: Labels) => void;
  savePromptDraft: (draft: PromptDraft) => void;
  rule: (conflictId: string, values: string[]) => void;
  acceptRest: () => void;
  sendSchemaEdit: (json: string) => void;
  trainNow: (modelId: string) => void;
  restart: () => void;
  isPanelAvailable: (panel: PanelId, ref?: string) => boolean;
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
  const append = useCallback((items: Item[], modelId?: string) => dispatch({type: 'append', modelId: modelId ?? null, items}), []);
  const exchange = useCallback(
    (user: T, agent: T, modelId?: string) =>
      append(
        [
          {kind: 'user', text: user},
          {kind: 'agent', text: agent},
        ],
        modelId,
      ),
    [append],
  );
  const selectModel = useCallback((id: string) => dispatch({type: 'selectModel', id}), []);
  const openPanel = useCallback((panel: PanelId, ref?: string, focus?: string) => dispatch({type: 'openPanel', panel, ref, focus}), []);
  const closePanel = useCallback(() => dispatch({type: 'closePanel'}), []);
  const savePromptDraft = useCallback((draft: PromptDraft) => dispatch({type: 'savePromptDraft', draft}), []);
  const saveLabels = useCallback((postId: string, labels: Labels) => dispatch({type: 'saveLabels', postId, labels}), []);
  const rule = useCallback((conflictId: string, values: string[]) => dispatch({type: 'rule', conflictId, values}), []);
  const acceptRest = useCallback(() => dispatch({type: 'acceptRest'}), []);
  const sendSchemaEdit = useCallback((json: string) => dispatch({type: 'sendSchemaEdit', json}), []);
  const trainNow = useCallback((modelId: string) => dispatch({type: 'trainNow', modelId, items: MODELS.find(m => m.id === modelId)?.afterTrain ?? []}), []);
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
      datasets: datasetsAt(state.cursor, state.choices),
      resolve,
      say,
      exchange,
      append,
      selectModel,
      openPanel,
      closePanel,
      saveLabels,
      savePromptDraft,
      rule,
      acceptRest,
      sendSchemaEdit,
      trainNow,
      restart,
      isResolved,
      isPanelAvailable: (panel, ref) => findArtifact(artifacts, panel, ref) !== undefined,
    };
  }, [state, step.stage, awaited, artifacts, resolve, say, exchange, append, selectModel, openPanel, closePanel, saveLabels, savePromptDraft, rule, acceptRest, sendSchemaEdit, trainNow, restart]);

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>;
}

export function useStory(): StoryContextValue {
  const value = useContext(StoryContext);
  if (!value) throw new Error('useStory must be used inside StoryProvider');
  return value;
}

export {RELEASED_STAGE};

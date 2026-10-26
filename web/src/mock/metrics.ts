import {t, type T} from '@/i18n/text';
import {LABELS, type LabelId} from './labels';

/**
 * A confusion matrix over LABELS order: rows are the gold label, columns the prediction.
 * `invalid` counts outputs per gold label that failed schema validation; they count as wrong.
 * Every metric shown in the demo is derived from these matrices, so the screens agree.
 */
export interface EvalRun {
  id: string;
  name: T;
  split: 'eval' | 'test';
  matrix: number[][];
  invalid: number[];
}

export interface LabelScore {
  label: LabelId;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export function scores(run: EvalRun): LabelScore[] {
  const n = LABELS.length;
  return LABELS.map((label, k) => {
    const tp = run.matrix[k][k];
    let predicted = 0;
    for (let i = 0; i < n; i++) predicted += run.matrix[i][k];
    const support = run.matrix[k].reduce((a, b) => a + b, 0) + run.invalid[k];
    const precision = predicted ? tp / predicted : 0;
    const recall = tp / support;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return {label: label.id, precision, recall, f1, support};
  });
}

export function macroF1(run: EvalRun): number {
  const s = scores(run);
  return s.reduce((a, b) => a + b.f1, 0) / s.length;
}

export function total(run: EvalRun): number {
  return run.matrix.flat().reduce((a, b) => a + b, 0) + run.invalid.reduce((a, b) => a + b, 0);
}

export function invalidRate(run: EvalRun): number {
  return run.invalid.reduce((a, b) => a + b, 0) / total(run);
}

/** Teacher prompt versions on the 600-post eval split. */
export const PROMPT_RUNS: Record<'v1' | 'v2' | 'v3', EvalRun> = {
  v1: {
    id: 'v1',
    name: t('Prompt v1', 'Prompt v1'),
    split: 'eval',
    matrix: [
      [266, 24, 29, 16],
      [13, 92, 22, 0],
      [7, 11, 49, 2],
      [1, 0, 6, 39],
    ],
    invalid: [13, 5, 3, 2],
  },
  v2: {
    id: 'v2',
    name: t('Prompt v2', 'Prompt v2'),
    split: 'eval',
    matrix: [
      [277, 23, 30, 17],
      [12, 97, 23, 0],
      [7, 10, 53, 2],
      [0, 0, 5, 43],
    ],
    invalid: [1, 0, 0, 0],
  },
  v3: {
    id: 'v3',
    name: t('Prompt v3', 'Prompt v3'),
    split: 'eval',
    matrix: [
      [281, 24, 24, 18],
      [7, 102, 20, 3],
      [3, 10, 59, 0],
      [0, 0, 4, 44],
    ],
    invalid: [1, 0, 0, 0],
  },
};

/** Release gate: the sealed 400-post test split. */
export const TEST_RUNS = {
  student: {
    id: 'student-46k',
    name: t('Student 8B · 46k', '学生模型 8B · 46k'),
    split: 'test',
    matrix: [
      [185, 19, 17, 11],
      [5, 65, 15, 3],
      [4, 6, 38, 0],
      [0, 0, 5, 27],
    ],
    invalid: [0, 0, 0, 0],
  },
  teacher: {
    id: 'teacher-v3',
    name: t('Teacher · prompt v3', '教师模型 · Prompt v3'),
    split: 'test',
    matrix: [
      [189, 16, 17, 10],
      [4, 68, 15, 1],
      [1, 6, 40, 1],
      [0, 1, 3, 28],
    ],
    invalid: [0, 0, 0, 0],
  },
} satisfies Record<string, EvalRun>;

export const TEACHER_GATE = {macroF1: 0.75, labelF1: 0.6};
export const RELEASE_GATE = {macroF1: 0.72, labelF1: 0.6};

/** Student F1 on the eval split by training-set size (nested subsets, fixed seed). */
export const LEARNING_CURVE: {size: number; f1: Record<LabelId, number>}[] = [
  {size: 10_000, f1: {entertainment: 0.84, experience: 0.66, discussion: 0.55, ecosystem: 0.71}},
  {size: 30_000, f1: {entertainment: 0.87, experience: 0.73, discussion: 0.61, ecosystem: 0.75}},
  {size: 46_000, f1: {entertainment: 0.88, experience: 0.74, discussion: 0.63, ecosystem: 0.75}},
];

export const SPLITS = {pool: 50_000, train: 49_000, eval: 600, test: 400, nearDuplicateShare: 0.06, countries: 23};

/** Share of each label: the teacher's pre-scan of the pool, and the training set after balancing. */
export const LABEL_MIX: Record<'pool' | 'trainingSet', Record<LabelId, number>> = {
  pool: {entertainment: 0.58, experience: 0.22, discussion: 0.12, ecosystem: 0.08},
  trainingSet: {entertainment: 0.52, experience: 0.22, discussion: 0.14, ecosystem: 0.12},
};

export const TRAINING_SET = {
  teacherRows: 49_000,
  invalidRemoved: 147,
  decontaminated: 212,
  duplicatesRemoved: 2_641,
  finalRows: 46_000,
  pilotSize: 500,
  pilotAgreement: 0.91,
  costUsd: 410,
  etaHours: 5,
};

export const LABELING = {
  labelers: ['Lin', 'Mei', 'Ravi'],
  items: 1_000,
  overlapShare: 0.2,
  alpha: 0.71,
  disagreements: 3,
  discussionVsEntertainmentShare: 0.64,
};

/** Days and human hours per stage for this project, against the process today. */
export const EFFICIENCY = {
  today: {weeks: 4, engineerHours: 40},
  project: {
    days: 6,
    engineerHours: 0,
    humanHours: 14,
    agentActions: 212,
    stages: [
      {name: t('Requirement', '定义需求'), days: 0.5, humanHours: 1},
      {name: t('Dataset', '数据集'), days: 0.5, humanHours: 0.2},
      {name: t('Human labeling', '人工标注'), days: 2, humanHours: 12},
      {name: t('Teacher tuning', '教师调优'), days: 1, humanHours: 0.5},
      {name: t('Training set', '训练集'), days: 0.5, humanHours: 0.1},
      {name: t('Train & evaluate', '训练与评估'), days: 1, humanHours: 0.1},
      {name: t('Release gate', '发布门禁'), days: 0.5, humanHours: 0.1},
    ],
  },
};

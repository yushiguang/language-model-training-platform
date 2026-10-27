import {t, type T} from '@/i18n/text';
import {FIELD_BY_ID, type FieldId, type LabelId} from './fields';

/**
 * One evaluation of the teacher or the student on a human-labeled split.
 * Single-select fields are confusion matrices in value order (rows gold, columns prediction),
 * plus an `invalid` column for outputs that failed schema validation; those count as wrong.
 * The multi-select field is per-topic true positives, false positives and false negatives.
 * Every score shown in the demo is computed from these numbers, so the screens agree.
 */
export interface Matrix {
  matrix: number[][];
  invalid: number[];
}

export interface EvalRun {
  id: string;
  name: T;
  split: 'eval' | 'test';
  primary_value: Matrix;
  format: Matrix;
  /** [tp, fp, fn] per topic, in TOPICS order. */
  topics: [number, number, number][];
  /** Share of posts whose topic set matches gold exactly. */
  topicsExactMatch: number;
}

export interface ValueScore {
  id: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

function f1(precision: number, recall: number): number {
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export function valueScores(run: EvalRun, field: FieldId): ValueScore[] {
  const values = FIELD_BY_ID[field].values;
  if (field === 'topics') {
    return run.topics.map(([tp, fp, fn], k) => {
      const precision = tp / (tp + fp);
      const recall = tp / (tp + fn);
      return {id: values[k].id, precision, recall, f1: f1(precision, recall), support: tp + fn};
    });
  }
  const {matrix, invalid} = run[field];
  return values.map((value, k) => {
    const tp = matrix[k][k];
    let predicted = 0;
    for (const row of matrix) predicted += row[k];
    const support = matrix[k].reduce((a, b) => a + b, 0) + invalid[k];
    const precision = predicted ? tp / predicted : 0;
    const recall = tp / support;
    return {id: value.id, precision, recall, f1: f1(precision, recall), support};
  });
}

export function macroF1(run: EvalRun, field: FieldId = 'primary_value'): number {
  const s = valueScores(run, field);
  return s.reduce((a, b) => a + b.f1, 0) / s.length;
}

/** The weakest primary_value label, which gates check against a minimum. */
export function weakestLabel(run: EvalRun): {id: LabelId; f1: number} {
  const s = valueScores(run, 'primary_value');
  const min = s.reduce((a, b) => (b.f1 < a.f1 ? b : a));
  return {id: min.id as LabelId, f1: min.f1};
}

export function total(run: EvalRun): number {
  const {matrix, invalid} = run.primary_value;
  return matrix.flat().reduce((a, b) => a + b, 0) + invalid.reduce((a, b) => a + b, 0);
}

export function invalidRate(run: EvalRun): number {
  return run.primary_value.invalid.reduce((a, b) => a + b, 0) / total(run);
}

/** Teacher prompt versions on the 600-post eval split. */
export const PROMPT_RUNS: Record<'v1' | 'v2' | 'v3', EvalRun> = {
  v1: {
    id: 'v1',
    name: t('Prompt v1', 'Prompt v1'),
    split: 'eval',
    // 19 of the 23 invalid outputs wrote "Ecosystem", the value named in the output section.
    primary_value: {
      matrix: [
        [270, 25, 31, 20],
        [14, 94, 23, 0],
        [7, 12, 50, 2],
        [1, 0, 5, 23],
      ],
      invalid: [2, 1, 1, 19],
    },
    format: {
      matrix: [
        [150, 8, 6, 6, 14, 4],
        [10, 88, 6, 1, 0, 4],
        [8, 5, 66, 0, 1, 4],
        [6, 0, 0, 58, 4, 1],
        [16, 0, 1, 5, 54, 3],
        [5, 2, 3, 1, 2, 35],
      ],
      invalid: [2, 1, 6, 1, 1, 12],
    },
    topics: [
      [93, 110, 27],
      [57, 70, 13],
      [48, 51, 12],
      [67, 67, 23],
      [45, 46, 15],
      [60, 73, 20],
      [40, 34, 10],
      [45, 51, 15],
      [73, 59, 17],
      [81, 85, 19],
    ],
    topicsExactMatch: 0.38,
  },
  v2: {
    id: 'v2',
    name: t('Prompt v2', 'Prompt v2'),
    split: 'eval',
    primary_value: {
      matrix: [
        [277, 23, 30, 17],
        [12, 97, 23, 0],
        [7, 10, 53, 2],
        [0, 0, 5, 43],
      ],
      invalid: [1, 0, 0, 0],
    },
    format: {
      matrix: [
        [152, 8, 6, 6, 14, 4],
        [10, 89, 6, 1, 0, 4],
        [8, 5, 71, 0, 1, 5],
        [6, 0, 0, 59, 4, 1],
        [16, 0, 1, 5, 55, 3],
        [6, 2, 3, 1, 2, 45],
      ],
      invalid: [0, 0, 0, 0, 0, 1],
    },
    topics: [
      [105, 125, 15],
      [60, 64, 10],
      [47, 54, 13],
      [72, 59, 18],
      [47, 43, 13],
      [67, 68, 13],
      [41, 49, 9],
      [46, 51, 14],
      [76, 76, 14],
      [80, 74, 20],
    ],
    topicsExactMatch: 0.4,
  },
  v3: {
    id: 'v3',
    name: t('Prompt v3', 'Prompt v3'),
    split: 'eval',
    primary_value: {
      matrix: [
        [281, 24, 24, 18],
        [7, 102, 20, 3],
        [3, 10, 59, 0],
        [0, 0, 4, 44],
      ],
      invalid: [1, 0, 0, 0],
    },
    format: {
      matrix: [
        [158, 8, 6, 6, 8, 4],
        [10, 90, 5, 1, 0, 4],
        [8, 5, 71, 0, 1, 5],
        [5, 0, 0, 60, 4, 1],
        [9, 0, 1, 4, 63, 3],
        [6, 2, 3, 1, 2, 45],
      ],
      invalid: [0, 0, 0, 0, 0, 1],
    },
    topics: [
      [93, 35, 27],
      [57, 17, 13],
      [45, 14, 15],
      [70, 18, 20],
      [48, 18, 12],
      [67, 28, 13],
      [39, 11, 11],
      [44, 15, 16],
      [65, 19, 25],
      [81, 26, 19],
    ],
    topicsExactMatch: 0.61,
  },
};

/** Release gate: the sealed 400-post test split. */
export const TEST_RUNS: Record<'student' | 'teacher', EvalRun> = {
  student: {
    id: 'student-46k',
    name: t('Student 8B · 46k', '学生模型 8B · 46k'),
    split: 'test',
    primary_value: {
      matrix: [
        [185, 19, 17, 11],
        [5, 65, 15, 3],
        [4, 6, 38, 0],
        [0, 0, 5, 27],
      ],
      invalid: [0, 0, 0, 0],
    },
    format: {
      matrix: [
        [100, 6, 5, 5, 7, 2],
        [8, 58, 4, 1, 0, 4],
        [6, 4, 45, 0, 1, 4],
        [4, 0, 0, 37, 3, 1],
        [8, 0, 1, 3, 41, 2],
        [5, 1, 2, 1, 1, 30],
      ],
      invalid: [0, 0, 0, 0, 0, 0],
    },
    topics: [
      [54, 31, 26],
      [31, 13, 16],
      [27, 15, 13],
      [42, 16, 18],
      [27, 13, 13],
      [38, 14, 15],
      [25, 10, 8],
      [28, 14, 12],
      [42, 16, 18],
      [52, 29, 15],
    ],
    topicsExactMatch: 0.55,
  },
  teacher: {
    id: 'teacher-v3',
    name: t('Teacher · prompt v3', '教师模型 · Prompt v3'),
    split: 'test',
    primary_value: {
      matrix: [
        [189, 16, 17, 10],
        [4, 68, 15, 1],
        [1, 6, 40, 1],
        [0, 1, 3, 28],
      ],
      invalid: [0, 0, 0, 0],
    },
    format: {
      matrix: [
        [104, 5, 4, 4, 6, 2],
        [7, 61, 3, 1, 0, 3],
        [5, 3, 48, 0, 1, 3],
        [3, 0, 0, 39, 2, 1],
        [6, 0, 1, 3, 43, 2],
        [4, 1, 2, 1, 1, 31],
      ],
      invalid: [0, 0, 0, 0, 0, 0],
    },
    topics: [
      [65, 26, 15],
      [37, 12, 10],
      [31, 11, 9],
      [49, 13, 11],
      [31, 10, 9],
      [38, 12, 15],
      [26, 7, 7],
      [32, 13, 8],
      [45, 14, 15],
      [48, 17, 19],
    ],
    topicsExactMatch: 0.6,
  },
};

/** Minimum macro-F1 per field, and the minimum for every primary_value label. Arbitrary for a first model. */
export const TEACHER_GATE = {macroF1: {primary_value: 0.75, format: 0.75, topics: 0.7} as Record<FieldId, number>, labelF1: 0.6, invalid: 0.01};
export const RELEASE_GATE = {macroF1: {primary_value: 0.72, format: 0.72, topics: 0.65} as Record<FieldId, number>, labelF1: 0.6};

/** Student macro-F1 per field on the eval split by training-set size (nested subsets, fixed seed). */
export const LEARNING_CURVE: {size: number; f1: Record<FieldId, number>}[] = [
  {size: 10_000, f1: {primary_value: 0.69, format: 0.72, topics: 0.6}},
  {size: 30_000, f1: {primary_value: 0.74, format: 0.77, topics: 0.67}},
  {size: 46_000, f1: {primary_value: 0.75, format: 0.79, topics: 0.7}},
];

export const SPLITS = {pool: 50_000, train: 49_000, eval: 600, test: 400, nearDuplicateShare: 0.06, countries: 23, languages: 31};

/** Share of each primary_value label: the teacher's pre-scan of the pool, and the training set after balancing. */
export const LABEL_MIX: Record<'pool' | 'trainingSet', Record<LabelId, number>> = {
  pool: {entertainment: 0.58, practical: 0.22, discussion: 0.12, ecosystem: 0.08},
  trainingSet: {entertainment: 0.52, practical: 0.22, discussion: 0.14, ecosystem: 0.12},
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

/** Each of the 1,000 eval and test posts is labeled by two of the three labelers. */
export const LABELING = {
  labelers: ['Lin', 'Mei', 'Ravi'],
  items: 1_000,
  alpha: {primary_value: 0.71, format: 0.82, topics: 0.66} as Record<FieldId, number>,
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

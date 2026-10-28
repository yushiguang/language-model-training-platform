import {t, type T} from '@/i18n/text';
import type {Datasets, Item} from './types';

export type ModelStatus = 'running' | 'waiting' | 'idle';

export interface ModelSummary {
  id: string;
  name: T;
  task: T;
  /** Scripted models drive their status from the story; others have a fixed one. */
  isScripted?: boolean;
  status?: ModelStatus;
  stage?: number;
  /** Read-only conversation for models that aren't scripted. */
  items?: Item[];
  /** Fixed dataset status for models that aren't scripted. */
  datasets?: Datasets;
  /** Why training can't start for a model that isn't scripted; absent means the user can train it now. */
  trainOffReason?: T;
  /** One line of status per workflow step, by step index, for models that aren't scripted. */
  stepNotes?: Partial<Record<number, T>>;
  /** A model that isn't scripted but takes /train in its chat. */
  acceptsTrain?: boolean;
  /** Workflow steps this model went without, such as gold labels on the fast path. */
  skippedStages?: number[];
  /** What the agent posts once the user starts training with /train. */
  afterTrain?: Item[];
}

const UPLOADED = t('Uploaded CSV', '上传的 CSV');

const SAMPLE_EVAL = {
  id: 'sample',
  label: t('Sample 300 ads for eval and test · about 30 min of review', '抽 300 条广告做评估集和测试集 · 审核约 30 分钟'),
  text: t('Sample 300 recent ads for eval and test', '抽 300 条近期广告做评估集和测试集'),
  reply: t(
    'In the product I’d start now: two reviewers can label 300 ads in about 30 minutes, and training can run at the same time. This demo stops here for Scam ads.',
    '在正式产品里我会马上开始：两位审核员大约 30 分钟能标完 300 条，训练可以同时进行。演示中诈骗广告模型到此为止。',
  ),
};
const HUMAN = t('Human gold labels', '人工金标');

export const MODELS: ModelSummary[] = [
  {
    id: 'video-tags',
    name: t('Video tags', '视频标签'),
    task: t('Primary value, format and topics of a short video', '短视频的主要价值、形式和话题'),
    isScripted: true,
  },
  {
    id: 'scam-ads',
    name: t('Scam ads', '诈骗广告'),
    task: t('Flag scam ads in Brazil, today', '今天就要拦截巴西的诈骗广告'),
    status: 'waiting',
    stage: 5,
    acceptsTrain: true,
    skippedStages: [2, 3],
    stepNotes: {
      0: t('V1 · 1 label field: scam or not scam', 'V1 · 1 个标签字段：诈骗/非诈骗'),
      4: t('3,200 rows from your uploaded CSV', '来自你上传 CSV 的 3,200 行'),
    },
    datasets: {
      train: {total: 3_200, labeled: 3_200, source: UPLOADED},
      eval: {total: 0, labeled: 0},
      test: {total: 0, labeled: 0},
    },
    items: [
      {
        kind: 'file',
        name: 'scam-ads-br.csv',
        size: '1.4 MB',
        detail: t('3,200 rows · ad_text, label', '3,200 行 · ad_text, label'),
      },
      {
        kind: 'user',
        text: t(
          'Scam ads are spiking in Brazil and Trust & Safety needs a classifier today. Here are 3,200 ads that reviewers already labeled scam or not scam.',
          '巴西的诈骗广告激增，信任与安全团队今天就需要一个分类模型。这是 3,200 条审核员已标注“诈骗/非诈骗”的广告。',
        ),
      },
      {
        kind: 'agent',
        tools: [
          {
            name: 'read_csv',
            target: t('scam-ads-br.csv · 3,200 rows', 'scam-ads-br.csv · 3,200 行'),
            duration: '0.6s',
          },
          {
            name: 'validate_labels',
            target: t('schema v1 · 1 field', 'Schema v1 · 1 个字段'),
            duration: '1s',
          },
        ],
        text: t(
          'Your file matches the schema: 3,200 rows, 18% scam. I put every row in the training set, so there is no eval or test set yet.\n\nYou can start training now with `/train`, but without eval and test I can’t tell you how often the model is wrong, and the release gate can’t run.',
          '文件符合 Schema：3,200 行，18% 为诈骗。我把所有行都放进了训练集，所以还没有评估集和测试集。\n\n你现在就可以输入 `/train` 开始训练，但没有评估集和测试集，我无法告诉你模型错得有多频繁，发布门禁也无法运行。',
        ),
      },
      {
        kind: 'card',
        card: {type: 'next', id: 'scam-next', suggestions: [SAMPLE_EVAL, {id: 'train', label: t('Train now, without eval and test', '现在训练，不带评估集和测试集'), text: t('/train', '/train')}]},
      },
    ],
    afterTrain: [
      {kind: 'user', text: t('/train', '/train')},
      {
        kind: 'system',
        text: t('Training started without an eval or test set', '已在没有评估集和测试集的情况下开始训练'),
      },
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'scam-train',
          title: t('Training student 1B · 3,200 rows', '训练学生模型 1B · 3,200 行'),
          total: 3_200,
          unit: t('rows', '行'),
          durationMs: 0,
          frozenAt: 0.08,
        },
      },
      {
        kind: 'agent',
        text: t(
          'Training started; it takes about 40 minutes. Until there is a test set, I’d use the model to send likely scams to reviewers rather than block them outright.',
          '训练已开始，大约需要 40 分钟。在有测试集之前，建议先用它把疑似诈骗送给审核员，而不是直接拦截。',
        ),
      },
      {kind: 'card', card: {type: 'next', id: 'scam-next-2', suggestions: [SAMPLE_EVAL]}},
    ],
  },
  {
    id: 'ad-landing',
    name: t('Ad landing quality', '广告落地页质量'),
    task: t('Good, misleading or broken landing pages', '落地页：优质、误导或失效'),
    status: 'running',
    stage: 4,
    datasets: {
      train: {
        total: 120_000,
        labeled: 73_200,
        source: t('Teacher, prompt v4 (running)', '教师模型，Prompt v4（进行中）'),
      },
      eval: {total: 800, labeled: 800, source: HUMAN},
      test: {total: 500, labeled: 500, source: HUMAN},
    },
    trainOffReason: t('The teacher is still labeling the training set.', '教师模型还在标注训练集。'),
    stepNotes: {
      0: t('V2 · 1 label field, 3 values', 'V2 · 1 个标签字段，3 个取值'),
      2: t('1,300 posts with human gold labels', '1,300 条人工金标'),
      3: t('Prompt v4 in use · macro-F1 0.82 · gate passed', '使用 Prompt v4 · macro-F1 0.82 · 已过门禁'),
      4: t('Teacher labeling: 73,200 of 120,000 pages', '教师标注中：73,200 / 120,000 个页面'),
    },
    items: [
      {
        kind: 'user',
        text: t('Rate ad landing pages as good, misleading or broken.', '把广告落地页分成优质、误导或失效三类。'),
      },
      {
        kind: 'agent',
        text: t(
          'Prompt v4 passed the teacher-quality gate at macro-F1 0.82. The teacher is now labeling **120,000 landing pages** in batch mode. I’ll tell you when the training set is ready.',
          'Prompt v4 以 macro-F1 0.82 通过了教师质量门禁。教师模型正在以批量模式标注 **120,000 个落地页**，训练集准备好后我会通知你。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'ad-batch',
          title: t('Teacher batch job · prompt v4', '教师模型批量任务 · Prompt v4'),
          total: 120000,
          unit: t('pages', '个'),
          durationMs: 0,
          frozenAt: 0.61,
        },
      },
    ],
  },
  {
    id: 'comment-toxicity',
    name: t('Comment toxicity', '评论毒性'),
    task: t('Toxic, borderline or fine comments', '评论：有害、边缘或正常'),
    status: 'idle',
    stage: 7,
    datasets: {
      train: {
        total: 60_000,
        labeled: 60_000,
        source: t('Teacher, prompt v2', '教师模型，Prompt v2'),
      },
      eval: {total: 600, labeled: 600, source: HUMAN},
      test: {total: 400, labeled: 400, source: HUMAN},
    },
    trainOffReason: t('Released two weeks ago. Retraining isn’t part of this demo.', '两周前已发布。重新训练不在本演示范围内。'),
    stepNotes: {
      0: t('V1 · 1 label field, 3 values', 'V1 · 1 个标签字段，3 个取值'),
      2: t('1,000 comments with human gold labels', '1,000 条人工金标'),
      3: t('Prompt v2 · macro-F1 0.86', 'Prompt v2 · macro-F1 0.86'),
      4: t('60,000 rows · teacher, prompt v2', '60,000 行 · 教师模型，Prompt v2'),
      5: t('Student 3B · macro-F1 0.81 on test', '学生模型 3B · 测试集 macro-F1 0.81'),
      6: t('V2 released two weeks ago', 'V2 已于两周前发布'),
    },
    items: [
      {
        kind: 'system',
        text: t('Comment toxicity v2 released 2 weeks ago', '评论毒性 v2 已于两周前发布'),
      },
      {
        kind: 'agent',
        text: t(
          'Weekly check: the label mix on live traffic hasn’t drifted, and 200 freshly labeled comments score macro-F1 0.81, the same as at release. Nothing needs your attention.',
          '每周检查：线上流量的标签分布没有漂移，新标注的 200 条评论 macro-F1 为 0.81，与发布时持平。暂时不需要你处理。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'tox-weekly',
          title: t('Weekly health check', '每周健康检查'),
          stats: [
            {
              label: t('Macro-F1 on fresh labels', '新标注样本 macro-F1'),
              value: '0.81',
            },
            {label: t('Label drift', '标签分布漂移'), value: t('none', '无')},
            {label: t('Hard cases harvested', '收集到的难例'), value: '38'},
          ],
        },
      },
    ],
  },
];

import {t, type T} from '@/i18n/text';
import type {Item} from './types';

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
}

export const MODELS: ModelSummary[] = [
  {
    id: 'content-value',
    name: t('Content value', '内容价值'),
    task: t('What value a post gives its viewers', '帖子给观众带来的主要价值'),
    isScripted: true,
  },
  {
    id: 'ad-landing',
    name: t('Ad landing quality', '广告落地页质量'),
    task: t('Good, misleading or broken landing pages', '落地页：优质、误导或失效'),
    status: 'running',
    stage: 4,
    items: [
      {
        kind: 'user',
        text: t('Rate ad landing pages as good, misleading or broken.', '把广告落地页分成优质、误导或失效三类。'),
      },
      {
        kind: 'agent',
        text: t(
          'Prompt v4 passed the teacher-quality gate at macro-F1 0.82. The teacher is now labeling **120,000 landing pages** in batch mode. I’ll tell you when the training set is ready.',
          'Prompt v4 以宏平均 F1 0.82 通过了教师质量门禁。教师模型正在以批量模式标注 **120,000 个落地页**，训练集准备好后我会通知你。',
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
    items: [
      {kind: 'system', text: t('Comment toxicity v2 released 2 weeks ago', '评论毒性 v2 已于两周前发布')},
      {
        kind: 'agent',
        text: t(
          'Weekly check: the label mix on live traffic hasn’t drifted, and 200 freshly labeled comments score macro-F1 0.81, the same as at release. Nothing needs your attention.',
          '每周检查：线上流量的标签分布没有漂移，新标注的 200 条评论宏平均 F1 为 0.81，与发布时持平。暂时不需要你处理。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'tox-weekly',
          title: t('Weekly health check', '每周健康检查'),
          stats: [
            {label: t('Macro-F1 on fresh labels', '新标注样本宏平均 F1'), value: '0.81'},
            {label: t('Label drift', '标签分布漂移'), value: t('none', '无')},
            {label: t('Hard cases harvested', '收集到的难例'), value: '38'},
          ],
        },
      },
    ],
  },
];

import {BarChart3, ChartLine, Database, FileText, Gauge, GitCompare, Layers, Scale, ShieldCheck, Tags, type LucideIcon} from 'lucide-react';
import {t, type T} from '@/i18n/text';
import type {PanelId} from '@/story/types';

/** What kind of artifact each page is, shown beside its title, and its icon. */
export const PANEL_META: Record<PanelId, {kind: T; icon: LucideIcon; path: string}> = {
  schema: {kind: t('Schema', 'Schema'), icon: FileText, path: 'schema'},
  samples: {kind: t('Dataset', '数据集'), icon: Database, path: 'datasets/ds-1'},
  labeling: {kind: t('Labeling task', '标注任务'), icon: Tags, path: 'labeling'},
  adjudication: {kind: t('Disagreements', '分歧裁决'), icon: Scale, path: 'labeling/disagreements'},
  evalReport: {kind: t('Eval report', '评估报告'), icon: BarChart3, path: 'evals'},
  promptDiff: {kind: t('Prompt versions', 'Prompt 版本'), icon: GitCompare, path: 'prompts'},
  trainingSet: {kind: t('Training set', '训练集'), icon: Layers, path: 'training-sets/ts-1'},
  runs: {kind: t('Training runs', '训练记录'), icon: ChartLine, path: 'runs'},
  gate: {kind: t('Release gate', '发布门禁'), icon: ShieldCheck, path: 'release'},
  efficiency: {kind: t('Report', '报告'), icon: Gauge, path: 'report'},
};

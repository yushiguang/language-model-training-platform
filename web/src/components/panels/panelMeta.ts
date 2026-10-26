import {BarChart3, ChartLine, Database, FileText, Gauge, GitCompare, Layers, ShieldCheck, Tags, type LucideIcon} from 'lucide-react';
import {t, type T} from '@/i18n/text';
import type {PanelId} from '@/story/types';

export const PANEL_META: Record<PanelId, {title: T; icon: LucideIcon; lockedHint: T}> = {
  schema: {title: t('Schema', 'Schema'), icon: FileText, lockedHint: t('', '')},
  samples: {title: t('Samples', '样本'), icon: Database, lockedHint: t('Available once the schema is confirmed.', '确认 Schema 后可用。')},
  labeling: {title: t('Labeling', '标注'), icon: Tags, lockedHint: t('Available once the sampling plan is approved.', '批准抽样方案后可用。')},
  evalReport: {title: t('Eval report', '评估报告'), icon: BarChart3, lockedHint: t('Available after the first teacher run.', '教师模型首次运行后可用。')},
  promptDiff: {title: t('Prompt versions', 'Prompt 版本'), icon: GitCompare, lockedHint: t('Available after you adopt a prompt change.', '采纳 Prompt 修改后可用。')},
  trainingSet: {title: t('Training set', '训练集'), icon: Layers, lockedHint: t('Available once the teacher batch job finishes.', '教师批量任务完成后可用。')},
  runs: {title: t('Training runs', '训练记录'), icon: ChartLine, lockedHint: t('Available once training finishes.', '训练完成后可用。')},
  gate: {title: t('Release gate', '发布门禁'), icon: ShieldCheck, lockedHint: t('Available once a run goes to the release gate.', '选定版本进入发布门禁后可用。')},
  efficiency: {title: t('Efficiency', '效率对比'), icon: Gauge, lockedHint: t('Available once the model is released.', '模型发布后可用。')},
};

export const PANEL_ORDER: PanelId[] = ['schema', 'samples', 'labeling', 'evalReport', 'promptDiff', 'trainingSet', 'runs', 'gate', 'efficiency'];

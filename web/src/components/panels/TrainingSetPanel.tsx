'use client';

import {BarRows} from '@/components/charts/BarRows';
import {ValueList} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, LABELS} from '@/mock/fields';
import {LABEL_MIX, TRAINING_SET} from '@/mock/metrics';
import {POSTS} from '@/mock/posts';
import {PanelSection, StatGrid, pct, useNumber} from './parts';

// Two neutral steps: these series are datasets, so they stay clear of the label colors.
const POOL_COLOR = '#a7b1bd';
const SET_COLOR = '#3d4b5e';

export function TrainingSetPanel() {
  const {tr} = useLocale();
  const num = useNumber();
  const ts = TRAINING_SET;
  const funnel = [
    {label: t('Teacher outputs', '教师模型输出'), value: num(ts.teacherRows)},
    {label: t('Invalid outputs removed', '去掉无效输出'), value: `−${num(ts.invalidRemoved)}`},
    {label: t('Near-duplicates removed', '去掉近似重复'), value: `−${num(ts.duplicatesRemoved)}`},
    {label: t('Overlap with eval or test removed', '去掉与评估/测试集重叠的'), value: `−${num(ts.decontaminated)}`},
  ];

  return (
    <div className="page">
      <StatGrid
        stats={[
          {label: tr(t('Training rows', '训练数据行数')), value: num(ts.finalRows)},
          {label: tr(t('Pilot agreement with gold', 'Pilot agreement（与金标）')), value: pct(ts.pilotAgreement), note: tr(t(`${ts.pilotSize} posts`, `${ts.pilotSize} 条`))},
          {label: tr(t('Teacher cost', '教师模型费用')), value: `$${ts.costUsd}`, note: tr(t('batch mode', '批量模式'))},
          {label: tr(t('Prompt', 'Prompt')), value: 'v1.3'},
        ]}
      />
      <PanelSection title={t('From teacher outputs to training rows', '从教师输出到训练数据')}>
        <div className="table-scroll funnel-wrap">
          <table className="data-table numeric">
            <tbody>
              {funnel.map(row => (
                <tr key={row.label.en}>
                  <th scope="row">{tr(row.label)}</th>
                  <td>{row.value}</td>
                </tr>
              ))}
              <tr className="total-row">
                <th scope="row">{tr(t('Training set', '训练集'))}</th>
                <td>{num(ts.finalRows)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </PanelSection>
      <PanelSection
        title={t('Primary value mix, before and after balancing', '平衡前后的主要价值分布')}
        description={t(
          'Entertainment is capped so the student sees enough of the rarer values; Ecosystem issue is raised to a minimum share.',
          '限制娱乐的占比，让学生模型看到足够多的少数类别；生态问题提到最低占比。',
        )}>
        <BarRows
          series={[
            {name: tr(t('Sampled pool (teacher pre-scan)', '抽样池（教师预扫）')), color: POOL_COLOR},
            {name: tr(t('Training set', '训练集')), color: SET_COLOR},
          ]}
          rows={LABELS.map(l => ({label: tr(l.name), values: [LABEL_MIX.pool[l.id], LABEL_MIX.trainingSet[l.id]]}))}
          max={0.6}
          format={v => pct(v)}
          caption={tr(t('Share of each primary value in the sampled pool and in the training set', '各主要价值在抽样池和训练集中的占比'))}
        />
      </PanelSection>
      <PanelSection
        title={t('Sample rows', '数据样例')}
        description={t(
          'What the student learns from: the post’s text fields and the teacher’s three label fields. Summary and reasoning are left out.',
          '学生模型学习的内容：帖子的文本字段和教师模型的三个标签字段，不包含 summary 和 reasoning。',
        )}>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{tr(t('Post', '帖子'))}</th>
                {FIELDS.map(f => (
                  <th key={f.id} scope="col">
                    {tr(f.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {POSTS.slice(0, 6).map(p => (
                <tr key={p.id}>
                  <td dir="auto" lang={p.lang} className="cell-title">
                    {p.title}
                  </td>
                  {FIELDS.map(f => (
                    <td key={f.id}>
                      <ValueList field={f.id} ids={p.teacher[f.id]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelSection>
    </div>
  );
}

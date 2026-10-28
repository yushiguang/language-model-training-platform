'use client';

import {BarRows} from '@/components/charts/BarRows';
import {CheckList} from '@/components/cards/AgentCard';
import {ValueChip} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, LABELS} from '@/mock/fields';
import {macroF1, RELEASE_GATE, total, valueScores, weakestLabel, TEST_RUNS, TRAINING_SET} from '@/mock/metrics';
import type {Check} from '@/story/types';
import {PanelSection, StatGrid, fmt2} from './parts';

const STUDENT_COLOR = '#3d4b5e';
const TEACHER_COLOR = '#a7b1bd';

/** The student against the sealed test split: the numbers the release decision rests on. */
export function GatePanel() {
  const {tr} = useLocale();
  const {student, teacher} = TEST_RUNS;
  const weakest = weakestLabel(student);
  const checks: Check[] = [
    ...FIELDS.map(f => {
      const v = macroF1(student, f.id);
      const min = RELEASE_GATE.macroF1[f.id];
      return {label: t(`${f.name.en} macro-F1 ≥ ${fmt2(min)}`, `${f.name.zh} macro-F1 ≥ ${fmt2(min)}`), value: fmt2(v), pass: v >= min};
    }),
    {
      label: t(`Every primary value F1 ≥ ${fmt2(RELEASE_GATE.labelF1)}`, `每个主要价值 F1 ≥ ${fmt2(RELEASE_GATE.labelF1)}`),
      value: fmt2(weakest.f1),
      pass: weakest.f1 >= RELEASE_GATE.labelF1,
    },
    {label: t('No training rows overlap the test split', '训练数据与测试集无重叠'), value: t(`${TRAINING_SET.decontaminated} removed`, `已去掉 ${TRAINING_SET.decontaminated} 条`), pass: true},
    {label: t('Regression vs. the current model', '相对线上模型的回退'), value: t('none · first model', '无 · 首个模型'), pass: true},
  ];
  const studentScores = valueScores(student, 'primary_value');
  const teacherScores = valueScores(teacher, 'primary_value');

  return (
    <div className="page">
      <StatGrid
        stats={[
          ...FIELDS.map(f => ({
            label: tr(t(`${f.name.en} · student`, `${f.name.zh} · 学生`)),
            value: fmt2(macroF1(student, f.id)),
            note: tr(t(`teacher ${fmt2(macroF1(teacher, f.id))}`, `教师 ${fmt2(macroF1(teacher, f.id))}`)),
          })),
          {label: tr(t('Sealed test posts', '封存测试集帖子')), value: String(total(student))},
        ]}
      />
      <PanelSection
        title={t('Gate checks', '门禁检查')}
        description={t('Thresholds for a first model are a starting point; you can change them per model.', '首个模型的阈值只是起点，每个模型都可以调整。')}>
        <CheckList checks={checks} />
      </PanelSection>
      <PanelSection title={t('Macro-F1 per field on the test split', '测试集上各字段的 macro-F1')}>
        <BarRows
          series={[
            {name: tr(t('Student 8B', '学生模型 8B')), color: STUDENT_COLOR},
            {name: tr(t('Teacher', '教师模型')), color: TEACHER_COLOR},
          ]}
          rows={FIELDS.map(f => ({label: tr(f.name), values: [macroF1(student, f.id), macroF1(teacher, f.id)]}))}
          max={1}
          format={fmt2}
          caption={tr(t('Student and teacher macro-F1 per field on the sealed test split', '封存测试集上学生模型与教师模型各字段的 macro-F1'))}
        />
      </PanelSection>
      <PanelSection title={t('Primary value, per value', '主要价值的各取值')}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Primary value', '主要价值'))}</th>
                <th scope="col">{tr(t('Student', '学生'))}</th>
                <th scope="col">{tr(t('Teacher', '教师'))}</th>
                <th scope="col">{tr(t('Minimum', '最低线'))}</th>
              </tr>
            </thead>
            <tbody>
              {LABELS.map((l, i) => (
                <tr key={l.id}>
                  <th scope="row">
                    <ValueChip field="primary_value" id={l.id} />
                  </th>
                  <td>{fmt2(studentScores[i].f1)}</td>
                  <td>{fmt2(teacherScores[i].f1)}</td>
                  <td>{fmt2(RELEASE_GATE.labelF1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelSection>
    </div>
  );
}

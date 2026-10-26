'use client';

import {Icon} from '@astryxdesign/core/Icon';
import {VStack} from '@astryxdesign/core/Layout';
import {CircleCheck, CircleX} from 'lucide-react';
import {BarRows} from '@/components/charts/BarRows';
import {LabelChip} from '@/components/LabelChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {LABELS} from '@/mock/labels';
import {macroF1, RELEASE_GATE, scores, TEST_RUNS, total} from '@/mock/metrics';
import {PanelSection, StatGrid, fmt2} from './parts';

const STUDENT_COLOR = '#3d4b5e';
const TEACHER_COLOR = '#a7b1bd';

/** The student against the sealed test split: the numbers the release decision rests on. */
export function GatePanel() {
  const {tr} = useLocale();
  const student = scores(TEST_RUNS.student);
  const teacher = scores(TEST_RUNS.teacher);
  const studentMacro = macroF1(TEST_RUNS.student);
  const lowest = Math.min(...student.map(s => s.f1));
  const checks: {label: T; value: string; pass: boolean}[] = [
    {label: t(`Macro-F1 ≥ ${RELEASE_GATE.macroF1}`, `宏平均 F1 ≥ ${RELEASE_GATE.macroF1}`), value: fmt2(studentMacro), pass: studentMacro >= RELEASE_GATE.macroF1},
    {label: t(`Every label F1 ≥ ${RELEASE_GATE.labelF1.toFixed(2)}`, `每个标签 F1 ≥ ${RELEASE_GATE.labelF1.toFixed(2)}`), value: fmt2(lowest), pass: lowest >= RELEASE_GATE.labelF1},
    {label: t('No training rows overlap the test split', '训练数据与测试集无重叠'), value: tr(t('212 removed', '已去掉 212 条')), pass: true},
    {label: t('Regression vs. the current model', '相对线上模型的回退'), value: tr(t('none · first model', '无 · 首个模型')), pass: true},
  ];

  return (
    <VStack gap={6}>
      <StatGrid
        stats={[
          {label: tr(t('Student macro-F1', '学生模型宏平均 F1')), value: fmt2(studentMacro), note: tr(t(`gate ≥ ${RELEASE_GATE.macroF1}`, `门禁 ≥ ${RELEASE_GATE.macroF1}`))},
          {label: tr(t('Teacher macro-F1', '教师模型宏平均 F1')), value: fmt2(macroF1(TEST_RUNS.teacher))},
          {label: tr(t('Sealed test posts', '封存测试集帖子')), value: String(total(TEST_RUNS.student))},
        ]}
      />
      <PanelSection
        title={t('Gate checks', '门禁检查')}
        description={t('Thresholds for a first model are a starting point; you can change them per model.', '首个模型的阈值只是起点，每个模型都可以调整。')}>
        <ul className="checks">
          {checks.map(c => (
            <li key={c.label.en}>
              <Icon icon={c.pass ? CircleCheck : CircleX} size="sm" color={c.pass ? 'success' : 'error'} label={tr(c.pass ? t('Pass', '通过') : t('Fail', '未通过'))} />
              <span>{tr(c.label)}</span>
              <span className="checks-value">{c.value}</span>
            </li>
          ))}
        </ul>
      </PanelSection>
      <PanelSection title={t('F1 per label on the test split', '测试集上各标签的 F1')}>
        <BarRows
          series={[
            {name: tr(t('Student 8B', '学生模型 8B')), color: STUDENT_COLOR},
            {name: tr(t('Teacher', '教师模型')), color: TEACHER_COLOR},
          ]}
          rows={LABELS.map((l, i) => ({label: tr(l.name), values: [student[i].f1, teacher[i].f1]}))}
          max={1}
          format={fmt2}
          caption={tr(t('Student and teacher F1 per label on the sealed test split', '封存测试集上学生模型与教师模型各标签的 F1'))}
        />
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Label', '标签'))}</th>
                <th scope="col">{tr(t('Student', '学生'))}</th>
                <th scope="col">{tr(t('Teacher', '教师'))}</th>
                <th scope="col">{tr(t('Minimum', '最低线'))}</th>
              </tr>
            </thead>
            <tbody>
              {LABELS.map((l, i) => (
                <tr key={l.id}>
                  <th scope="row">
                    <LabelChip id={l.id} />
                  </th>
                  <td>{fmt2(student[i].f1)}</td>
                  <td>{fmt2(teacher[i].f1)}</td>
                  <td>{RELEASE_GATE.labelF1.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelSection>
    </VStack>
  );
}

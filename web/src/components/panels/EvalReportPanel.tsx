'use client';

import {useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Text} from '@astryxdesign/core/Text';
import {ConfusionMatrix} from '@/components/charts/ConfusionMatrix';
import {LabelChip} from '@/components/LabelChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {LABELS} from '@/mock/labels';
import {invalidRate, macroF1, PROMPT_RUNS, scores, TEACHER_GATE, total} from '@/mock/metrics';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, StatGrid, fmt2, pct} from './parts';

type Version = keyof typeof PROMPT_RUNS;
const VERSIONS: {id: Version; unlockedBy: string}[] = [
  {id: 'v1', unlockedBy: 'pr-v1'},
  {id: 'v2', unlockedBy: 'adv-1'},
  {id: 'v3', unlockedBy: 'adv-2'},
];

function signed(v: number): string {
  const r = Math.round(v * 100) / 100;
  return r > 0 ? `+${r.toFixed(2)}` : r < 0 ? `−${(-r).toFixed(2)}` : '±0.00';
}

/** The teacher on the human-labeled eval split, for each prompt version adopted so far. */
export function EvalReportPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const available = VERSIONS.filter(v => story.isResolved(v.unlockedBy)).map(v => v.id);
  const [picked, setPicked] = useState<Version | null>(null);
  const version = picked && available.includes(picked) ? picked : available[available.length - 1];
  const run = PROMPT_RUNS[version];
  const prevId = available[available.indexOf(version) - 1];
  const prev = prevId ? scores(PROMPT_RUNS[prevId]) : null;
  const rows = scores(run);
  const macro = macroF1(run);
  const lowest = Math.min(...rows.map(r => r.f1));
  const passes = macro >= TEACHER_GATE.macroF1 && lowest >= TEACHER_GATE.labelF1 && invalidRate(run) <= 0.01;

  return (
    <VStack gap={6}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <SegmentedControl label={tr(t('Prompt version', 'Prompt 版本'))} size="sm" value={version} onChange={v => setPicked(v as Version)}>
          {available.map(v => (
            <SegmentedControlItem key={v} value={v} label={`Prompt ${v}`} />
          ))}
        </SegmentedControl>
        <Badge
          variant={passes ? 'success' : 'warning'}
          label={tr(passes ? t('Passes the teacher-quality gate', '通过教师质量门禁') : t('Below the teacher-quality gate', '未达教师质量门禁'))}
        />
      </HStack>

      <StatGrid
        stats={[
          {label: tr(t('Macro-F1', '宏平均 F1')), value: fmt2(macro), note: tr(t(`gate ≥ ${TEACHER_GATE.macroF1}`, `门禁 ≥ ${TEACHER_GATE.macroF1}`))},
          {label: tr(t('Lowest label F1', '最低标签 F1')), value: fmt2(lowest), note: tr(t(`gate ≥ ${TEACHER_GATE.labelF1.toFixed(2)}`, `门禁 ≥ ${TEACHER_GATE.labelF1.toFixed(2)}`))},
          {label: tr(t('Invalid outputs', '无效输出')), value: pct(invalidRate(run), 1), note: tr(t('gate ≤ 1%', '门禁 ≤ 1%'))},
          {label: tr(t('Eval posts, human labels', '评估帖子（人工标注）')), value: String(total(run))},
        ]}
      />

      <PanelSection
        title={t('Per label', '各标签')}
        description={prev ? t(`Change in F1 is against prompt ${prevId}.`, `F1 变化相对于 Prompt ${prevId}。`) : t('Precision: of the posts the teacher gave this label, how many were right. Recall: of the posts that have this label, how many it found.', '精确率：教师判为该标签的帖子里，有多少是对的。召回率：真正属于该标签的帖子里，找到了多少。')}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Label', '标签'))}</th>
                <th scope="col">{tr(t('Precision', '精确率'))}</th>
                <th scope="col">{tr(t('Recall', '召回率'))}</th>
                <th scope="col">F1</th>
                {prev && <th scope="col">{tr(t('Change', '变化'))}</th>}
                <th scope="col">{tr(t('Posts', '帖子数'))}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.label}>
                  <th scope="row">
                    <LabelChip id={r.label} />
                  </th>
                  <td>{fmt2(r.precision)}</td>
                  <td>{fmt2(r.recall)}</td>
                  <td>
                    {fmt2(r.f1)}
                    {r.f1 < TEACHER_GATE.labelF1 && <span className="cell-flag"> · {tr(t('below 0.60', '低于 0.60'))}</span>}
                  </td>
                  {prev && <td>{signed(r.f1 - prev[i].f1)}</td>}
                  <td>{r.support}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelSection>

      <PanelSection
        title={t('Where the teacher goes wrong', '教师模型错在哪里')}
        description={t('Rows are the human label, columns the teacher’s. Shading is the share of each row, so the diagonal is recall.', '行是人工标签，列是教师模型的判断。颜色深浅是该行内的占比，对角线就是召回率。')}>
        <ConfusionMatrix
          labels={LABELS.map(l => tr(l.name))}
          matrix={run.matrix}
          invalid={run.invalid}
          goldHeading={tr(t('Human label', '人工标签'))}
          predictedHeading={tr(t('Teacher’s label', '教师模型标签'))}
          invalidHeading={tr(t('Invalid', '无效'))}
          caption={tr(t(`Confusion matrix, prompt ${version}, ${total(run)} eval posts`, `混淆矩阵，Prompt ${version}，评估集 ${total(run)} 条`))}
        />
        <Text type="supporting" color="secondary">
          {tr(t('Invalid outputs count as wrong for their row’s label.', '无效输出计为所在行标签的错误。'))}
        </Text>
      </PanelSection>
    </VStack>
  );
}

'use client';

import {useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {ConfusionMatrix} from '@/components/charts/ConfusionMatrix';
import {ValueChip} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELD_BY_ID, FIELDS, type FieldId} from '@/mock/fields';
import {invalidRate, macroF1, PROMPT_RUNS, TEACHER_GATE, total, valueScores, weakestLabel, type EvalRun} from '@/mock/metrics';
import {useStory} from '@/story/StoryProvider';
import {FieldSwitch, PanelSection, StatGrid, fmt2, pct} from './parts';

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

export function passesTeacherGate(run: EvalRun): boolean {
  return (
    FIELDS.every(f => macroF1(run, f.id) >= TEACHER_GATE.macroF1[f.id]) &&
    weakestLabel(run).f1 >= TEACHER_GATE.labelF1 &&
    invalidRate(run) <= TEACHER_GATE.invalid
  );
}

/** Topics per post, as tagged and as people tagged them. */
function tagsPerPost(run: EvalRun): {tagged: number; gold: number} {
  const posts = total(run);
  return {
    tagged: run.topics.reduce((a, [tp, fp]) => a + tp + fp, 0) / posts,
    gold: run.topics.reduce((a, [tp, , fn]) => a + tp + fn, 0) / posts,
  };
}

/** The teacher on the human-labeled eval split, for each prompt version adopted so far, field by field. */
export function EvalReportPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const available = VERSIONS.filter(v => story.isResolved(v.unlockedBy)).map(v => v.id);
  const [picked, setPicked] = useState<Version | null>(null);
  const [field, setField] = useState<FieldId>('primary_value');
  const version = picked && available.includes(picked) ? picked : available[available.length - 1];
  const run = PROMPT_RUNS[version];
  const prevId = available[available.indexOf(version) - 1];
  const prev = prevId ? valueScores(PROMPT_RUNS[prevId], field) : null;
  const rows = valueScores(run, field);
  const passes = passesTeacherGate(run);
  const meta = FIELD_BY_ID[field];
  const gate = TEACHER_GATE.macroF1;
  const tags = tagsPerPost(run);

  return (
    <div className="page">
      <div className="page-toolbar">
        <SegmentedControl label={tr(t('Prompt version', 'Prompt 版本'))} size="sm" value={version} onChange={v => setPicked(v as Version)}>
          {available.map(v => (
            <SegmentedControlItem key={v} value={v} label={`Prompt ${v}`} />
          ))}
        </SegmentedControl>
        <Badge
          variant={passes ? 'success' : 'warning'}
          label={tr(passes ? t('Passes the teacher-quality gate', '通过教师质量门禁') : t('Below the teacher-quality gate', '未达教师质量门禁'))}
        />
      </div>

      <StatGrid
        stats={[
          ...FIELDS.map(f => ({
            label: tr(t(`${f.name.en} macro-F1`, `${f.name.zh}宏平均 F1`)),
            value: fmt2(macroF1(run, f.id)),
            note: tr(t(`gate ≥ ${fmt2(gate[f.id])}`, `门禁 ≥ ${fmt2(gate[f.id])}`)),
          })),
          {label: tr(t('Invalid outputs', '无效输出')), value: pct(invalidRate(run), 1), note: tr(t('gate ≤ 1%', '门禁 ≤ 1%'))},
        ]}
      />

      <PanelSection
        title={t('By field', '按字段')}
        description={
          prev
            ? t(`${total(run)} eval posts with human labels. Change is against prompt ${prevId}.`, `评估集 ${total(run)} 条人工标注。变化相对于 Prompt ${prevId}。`)
            : t(
                `${total(run)} eval posts with human labels. Precision: of the posts the teacher gave a value, how many were right. Recall: of the posts that have it, how many it found.`,
                `评估集 ${total(run)} 条人工标注。精确率：教师给出该取值的帖子里，有多少是对的。召回率：真正属于该取值的帖子里，找到了多少。`,
              )
        }
        aside={<FieldSwitch value={field} onChange={setField} />}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(meta.name)}</th>
                <th scope="col">{tr(t('Precision', '精确率'))}</th>
                <th scope="col">{tr(t('Recall', '召回率'))}</th>
                <th scope="col">F1</th>
                {prev && <th scope="col">{tr(t('Change', '变化'))}</th>}
                <th scope="col">{tr(t('Posts', '帖子数'))}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <th scope="row">
                    <ValueChip field={field} id={r.id} />
                  </th>
                  <td>{fmt2(r.precision)}</td>
                  <td>{fmt2(r.recall)}</td>
                  <td>
                    {fmt2(r.f1)}
                    {field === 'primary_value' && r.f1 < TEACHER_GATE.labelF1 && <span className="cell-flag"> · {tr(t('below 0.60', '低于 0.60'))}</span>}
                  </td>
                  {prev && <td>{signed(r.f1 - prev[i].f1)}</td>}
                  <td>{r.support}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelSection>

      {field === 'topics' ? (
        <PanelSection
          title={t('How many topics the teacher picks', '教师模型选几个话题')}
          description={t('Precision on topics drops when the teacher adds topics people wouldn’t.', '教师模型多加人不会加的话题时，话题的精确率就会下降。')}>
          <StatGrid
            stats={[
              {label: tr(t('Topics per post, teacher', '每条话题数（教师）')), value: tags.tagged.toFixed(1)},
              {label: tr(t('Topics per post, people', '每条话题数（人工）')), value: tags.gold.toFixed(1)},
              {label: tr(t('Exact match with people', '与人工完全一致')), value: pct(run.topicsExactMatch)},
            ]}
          />
        </PanelSection>
      ) : (
        <PanelSection
          title={t('Where the teacher goes wrong', '教师模型错在哪里')}
          description={t('Rows are the human label, columns the teacher’s. Shading is the share of each row, so the diagonal is recall. Invalid outputs count as wrong.', '行是人工标签，列是教师模型的判断。颜色深浅是该行内的占比，对角线就是召回率。无效输出计为错误。')}>
          <ConfusionMatrix
            labels={meta.values.map(v => tr(v.name))}
            matrix={run[field].matrix}
            invalid={run[field].invalid}
            goldHeading={tr(t('Human', '人工'))}
            predictedHeading={tr(t('Teacher', '教师'))}
            invalidHeading={tr(t('Invalid', '无效'))}
            caption={tr(t(`${meta.name.en}, prompt ${version}, ${total(run)} eval posts`, `${meta.name.zh}，Prompt ${version}，评估集 ${total(run)} 条`))}
          />
        </PanelSection>
      )}
    </div>
  );
}

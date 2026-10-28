'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {FileText} from 'lucide-react';
import {Delta} from '@/components/Change';
import {PromptTrend, useScoredPrompts} from '@/components/PromptTrend';
import {ConfusionMatrix} from '@/components/charts/ConfusionMatrix';
import {trendOf} from '@/components/trend';
import {ValueChip} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELD_BY_ID, FIELDS, type FieldId} from '@/mock/fields';
import {invalidRate, macroF1, PROMPT_RUNS, TEACHER_GATE, total, valueScores, type EvalRun} from '@/mock/metrics';
import {PROMPT_PARENT, type PromptId} from '@/mock/prompt';
import {useStory} from '@/story/StoryProvider';
import {FieldSwitch, PanelSection, StatGrid, fmt2, pct} from './parts';

/** Topics per post, as tagged and as people tagged them. */
function tagsPerPost(run: EvalRun): {tagged: number; gold: number} {
  const posts = total(run);
  return {
    tagged: run.topics.reduce((a, [tp, fp]) => a + tp + fp, 0) / posts,
    gold: run.topics.reduce((a, [tp, , fn]) => a + tp + fn, 0) / posts,
  };
}

/**
 * One eval run: the teacher with one prompt version on the human-labeled eval split, field by field.
 * Each run is its own report and never changes; the trend at the top compares it with the other runs.
 */
export function EvalReportPanel({artifactRef}: {artifactRef?: string}) {
  const {tr} = useLocale();
  const story = useStory();
  const scored = useScoredPrompts();
  const [field, setField] = useState<FieldId>('primary_value');
  const version = (artifactRef as PromptId | undefined) ?? scored[scored.length - 1];
  const run = PROMPT_RUNS[version];
  const prevId = PROMPT_PARENT[version];
  const prev = prevId ? valueScores(PROMPT_RUNS[prevId], field) : null;
  const rows = valueScores(run, field);
  const meta = FIELD_BY_ID[field];
  const gate = TEACHER_GATE.macroF1;
  const tags = tagsPerPost(run);

  return (
    <div className="page">
      <div className="page-toolbar">
        <span className="report-of">
          {tr(
            prevId
              ? t(`Prompt ${version}, from ${prevId} · 600 eval posts`, `Prompt ${version}，基于 ${prevId} · 600 条评估帖子`)
              : t(`Prompt ${version} · 600 eval posts`, `Prompt ${version} · 600 条评估帖子`),
          )}
        </span>
        <Button
          className="toolbar-end"
          label={tr(t(`Open prompt ${version}`, `打开 Prompt ${version}`))}
          variant="secondary"
          size="sm"
          icon={<Icon icon={FileText} size="sm" />}
          onClick={() => story.openPanel('promptDiff', undefined, version)}
        />
      </div>

      {scored.length > 1 && (
        <PanelSection
          title={t('Across prompt versions', '各 Prompt 版本对比')}
          description={t(
            'Click a version to open its report. A drop on the line means that change made things worse; start again from the best version on the prompt page.',
            '点击某个版本可打开它的报告。连线下降说明那次修改变差了，可以在 Prompt 页面从最佳版本重新开始。',
          )}>
          <PromptTrend selected={version} onSelect={id => id !== version && story.openPanel('evalReport', id)} />
        </PanelSection>
      )}

      <StatGrid
        stats={[
          ...FIELDS.map(f => ({
            label: tr(t(`${f.name.en} macro-F1`, `${f.name.zh} macro-F1`)),
            value: fmt2(macroF1(run, f.id)),
            note: tr(t(`gate ≥ ${fmt2(gate[f.id])}`, `门禁 ≥ ${fmt2(gate[f.id])}`)),
          })),
          {label: tr(t('Invalid outputs', 'Invalid outputs')), value: pct(invalidRate(run), 1), note: tr(t('gate ≤ 1%', '门禁 ≤ 1%'))},
        ]}
      />

      <PanelSection
        title={t('By field', '按字段')}
        description={
          prev
            ? t(`${total(run)} eval posts with human labels. Change is against prompt ${prevId}, the version it came from.`, `评估集 ${total(run)} 条人工标注。变化相对于它的上一版 Prompt ${prevId}。`)
            : t(
                `${total(run)} eval posts with human labels. Precision: of the posts the teacher gave a value, how many were right. Recall: of the posts that have it, how many it found.`,
                `评估集 ${total(run)} 条人工标注。Precision：教师给出该取值的帖子里，有多少是对的。Recall：真正属于该取值的帖子里，找到了多少。`,
              )
        }
        aside={<FieldSwitch value={field} onChange={setField} />}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(meta.name)}</th>
                <th scope="col">{tr(t('Precision', 'Precision'))}</th>
                <th scope="col">{tr(t('Recall', 'Recall'))}</th>
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
                  {prev && (
                    <td>
                      <Delta value={r.f1 - prev[i].f1} trend={trendOf(r.f1 - prev[i].f1, 'higher')} />
                    </td>
                  )}
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
          description={t('Precision on topics drops when the teacher adds topics people wouldn’t.', '教师模型多加人不会加的话题时，话题的 Precision 就会下降。')}>
          <StatGrid
            stats={[
              {label: tr(t('Topics per post, teacher', '每条话题数（教师）')), value: tags.tagged.toFixed(1)},
              {label: tr(t('Topics per post, people', '每条话题数（人工）')), value: tags.gold.toFixed(1)},
              {label: tr(t('Exact match with people', 'Exact match（与人工）')), value: pct(run.topicsExactMatch)},
            ]}
          />
        </PanelSection>
      ) : (
        <PanelSection
          title={t('Where the teacher goes wrong', '教师模型错在哪里')}
          description={t(
            'Rows are the human label, columns the teacher’s. Shading is the share of each row, so the diagonal is recall. Invalid outputs count as wrong.',
            '行是人工标签，列是教师模型的判断。颜色深浅是该行内的占比，对角线就是 Recall。无效输出计为错误。',
          )}>
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

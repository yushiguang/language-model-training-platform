'use client';

import {useState} from 'react';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {FIELD_COLORS} from '@/components/charts/fieldColors';
import {TrendChart, type TrendThreshold} from '@/components/charts/TrendChart';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, type FieldId} from '@/mock/fields';
import {macroF1, macroOf, passesTeacherGate, PROMPT_RUNS, TEACHER_GATE, type Metric} from '@/mock/metrics';
import {fmt2} from '@/mock/numbers';
import {PROMPT_ORDER, PROMPT_PARENT, type PromptId} from '@/mock/prompt';
import {useStory} from '@/story/StoryProvider';

const METRICS: {id: Metric; label: string}[] = [
  {id: 'f1', label: 'F1'},
  {id: 'precision', label: 'Precision'},
  {id: 'recall', label: 'Recall'},
];

/** Prompt versions the agent has scored, in the order they ran: one eval report each. */
export function useScoredPrompts(): PromptId[] {
  const {artifacts} = useStory();
  const scored = new Set(artifacts.filter(a => a.panel === 'evalReport' && a.ref).map(a => a.ref));
  return PROMPT_ORDER.filter(id => scored.has(id));
}

/** The best scored version: highest mean macro-F1 among those that passed the gate, or among all if none did. */
export function bestPrompt(ids: PromptId[]): PromptId | undefined {
  const passed = ids.filter(id => passesTeacherGate(PROMPT_RUNS[id]));
  const pool = passed.length ? passed : ids;
  const mean = (id: PromptId) => FIELDS.reduce((a, f) => a + macroF1(PROMPT_RUNS[id], f.id), 0) / FIELDS.length;
  return pool.reduce<PromptId | undefined>((a, b) => (a === undefined || mean(b) > mean(a) ? b : a), undefined);
}

/** Gate thresholds as dashed lines; fields with the same minimum share one line. */
function thresholds(gateWord: string): TrendThreshold[] {
  const byValue = new Map<number, FieldId[]>();
  for (const f of FIELDS) byValue.set(TEACHER_GATE.macroF1[f.id], [...(byValue.get(TEACHER_GATE.macroF1[f.id]) ?? []), f.id]);
  return [...byValue].map(([value, ids]) => ({value, seriesIds: ids, label: `${gateWord} ≥ ${fmt2(value)}`}));
}

/**
 * How each field scored across the prompt versions run so far, joined in the order they ran.
 * The gate's minimums are dashed lines. Clicking a version selects it.
 */
export function PromptTrend({selected, onSelect}: {selected: PromptId; onSelect?: (id: PromptId) => void}) {
  const {tr} = useLocale();
  const ids = useScoredPrompts();
  const [metric, setMetric] = useState<Metric>('f1');
  if (ids.length === 0) return null;
  const metricName = METRICS.find(m => m.id === metric)!.label;

  return (
    <div className="prompt-trend">
      <SegmentedControl label={tr(t('Score', '指标'))} size="sm" value={metric} onChange={v => setMetric(v as Metric)}>
        {METRICS.map(m => (
          <SegmentedControlItem key={m.id} value={m.id} label={`macro-${m.label}`} />
        ))}
      </SegmentedControl>
      <TrendChart
        runs={ids.map(id => ({
          id,
          label: id,
          detail: PROMPT_PARENT[id] ? tr(t(`from ${PROMPT_PARENT[id]}`, `基于 ${PROMPT_PARENT[id]}`)) : tr(t('first version', '第一版')),
          passed: passesTeacherGate(PROMPT_RUNS[id]),
          values: Object.fromEntries(FIELDS.map(f => [f.id, macroOf(PROMPT_RUNS[id], f.id, metric)])),
        }))}
        series={FIELDS.map(f => ({id: f.id, name: tr(f.name), color: FIELD_COLORS[f.id]}))}
        path={ids}
        highlight={selected}
        best={bestPrompt(ids)}
        thresholds={metric === 'f1' ? thresholds(tr(t('Gate', '门禁'))) : []}
        formatY={fmt2}
        caption={tr(
          t(
            `Macro-${metricName} per field on the 600 eval posts, for each prompt version, in the order they ran.${metric === 'f1' ? ' Dashed lines are the teacher-quality gate.' : ' The gate checks F1 only.'}`,
            `每个 Prompt 版本在 600 条评估帖子上各字段的 macro-${metricName}，按运行顺序排列。${metric === 'f1' ? '虚线是教师质量门禁。' : '门禁只看 F1。'}`,
          ),
        )}
        passedLabel={tr(t('Passed gate', '已过门禁'))}
        failedLabel={tr(t('Below gate', '未过门禁'))}
        thresholdLabel={tr(t('Gate minimum', '门禁最低线'))}
        bestLabel={tr(t('Best', '最佳'))}
        onSelect={onSelect ? id => onSelect(id as PromptId) : undefined}
      />
      <details className="trend-table">
        <summary>{tr(t('Show as a table', '以表格查看'))}</summary>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Prompt', 'Prompt'))}</th>
                <th scope="col">{tr(t('From', '基于'))}</th>
                {FIELDS.map(f => (
                  <th key={f.id} scope="col">
                    {tr(f.name)}
                  </th>
                ))}
                <th scope="col">{tr(t('Gate', '门禁'))}</th>
              </tr>
            </thead>
            <tbody>
              {ids.map(id => (
                <tr key={id}>
                  <th scope="row">{id}</th>
                  <td>{PROMPT_PARENT[id] ?? '–'}</td>
                  {FIELDS.map(f => (
                    <td key={f.id}>{fmt2(macroOf(PROMPT_RUNS[id], f.id, metric))}</td>
                  ))}
                  <td>{tr(passesTeacherGate(PROMPT_RUNS[id]) ? t('Passed', '通过') : t('Below', '未通过'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

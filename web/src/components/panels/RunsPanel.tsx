'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {LineChart} from '@/components/charts/LineChart';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, type FieldId} from '@/mock/fields';
import {LEARNING_CURVE, macroF1, PROMPT_RUNS} from '@/mock/metrics';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, fmt2, useNumber} from './parts';

const kilo = (n: number) => `${n / 1000}k`;

// Categorical slots 7, 5 and 6, so the fields never borrow a primary value's color.
const FIELD_COLORS: Record<FieldId, string> = {primary_value: '#6250d6', format: '#e87ba4', topics: '#008300'};

export function RunsPanel() {
  const {tr} = useLocale();
  const num = useNumber();
  const story = useStory();
  const selected = story.isResolved('q-more') ? 46_000 : null;

  return (
    <div className="page">
      <Banner
        status="info"
        title={tr(t('Illustrative numbers', '示意数据'))}
        description={tr(t('Training runs on Platform S, which isn’t connected yet. This page shows the planned view.', '训练在 Platform S 上进行，目前还没接通。此页面展示的是规划中的视图。'))}
      />
      <PanelSection
        title={t('Does more data still help?', '更多数据还有帮助吗？')}
        description={t('Student 8B trained on nested subsets of the training set, scored on the eval split. Macro-F1 per field.', '学生模型 8B 在训练集的嵌套子集上训练，在评估集上打分。每个字段的 macro-F1。')}>
        <LineChart
          xs={LEARNING_CURVE.map(p => p.size)}
          formatX={kilo}
          series={FIELDS.map(f => ({name: tr(f.name), color: FIELD_COLORS[f.id], values: LEARNING_CURVE.map(p => p.f1[f.id])}))}
          yDomain={[0.5, 0.9]}
          formatY={fmt2}
          caption={tr(t('Student macro-F1 per field by training-set size', '学生模型各字段 macro-F1 随训练集规模的变化'))}
        />
      </PanelSection>
      <PanelSection title={t('Runs', '训练记录')}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Run', '记录'))}</th>
                <th scope="col">{tr(t('Training rows', '训练行数'))}</th>
                {FIELDS.map(f => (
                  <th key={f.id} scope="col">
                    {tr(f.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LEARNING_CURVE.map(r => (
                <tr key={r.size}>
                  <th scope="row">
                    {tr(t('Student 8B', '学生模型 8B'))} · {kilo(r.size)}
                    {selected === r.size && (
                      <>
                        {' '}
                        <Badge variant="info" label={tr(t('To release gate', '进入发布门禁'))} />
                      </>
                    )}
                  </th>
                  <td>{num(r.size)}</td>
                  {FIELDS.map(f => (
                    <td key={f.id}>{fmt2(r.f1[f.id])}</td>
                  ))}
                </tr>
              ))}
              <tr className="total-row">
                <th scope="row">{tr(t('Teacher · prompt v3', '教师模型 · Prompt v3'))}</th>
                <td>—</td>
                {FIELDS.map(f => (
                  <td key={f.id}>{fmt2(macroF1(PROMPT_RUNS.v3, f.id))}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </PanelSection>
    </div>
  );
}

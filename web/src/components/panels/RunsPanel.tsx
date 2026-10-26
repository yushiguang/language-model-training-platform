'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {VStack} from '@astryxdesign/core/Layout';
import {LineChart} from '@/components/charts/LineChart';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {LABELS} from '@/mock/labels';
import {LEARNING_CURVE, macroF1, PROMPT_RUNS} from '@/mock/metrics';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, fmt2} from './parts';

const kilo = (n: number) => `${n / 1000}k`;

export function RunsPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const teacher = macroF1(PROMPT_RUNS.v3);
  const selected = story.isResolved('q-more') ? 46_000 : null;
  const runs = LEARNING_CURVE.map(p => ({size: p.size, macro: LABELS.reduce((a, l) => a + p.f1[l.id], 0) / LABELS.length}));

  return (
    <VStack gap={6}>
      <Banner
        status="info"
        title={tr(t('Illustrative numbers', '示意数据'))}
        description={tr(t('Training runs on Platform S, which isn’t connected yet. This screen shows the planned view.', '训练在 Platform S 上进行，目前还没接通。此页面展示的是规划中的视图。'))}
      />
      <PanelSection
        title={t('Does more data still help?', '更多数据还有帮助吗？')}
        description={t('Student 8B trained on nested subsets of the training set, scored on the eval split.', '学生模型 8B 在训练集的嵌套子集上训练，在评估集上打分。')}>
        <LineChart
          xs={LEARNING_CURVE.map(p => p.size)}
          formatX={kilo}
          series={LABELS.map(l => ({name: tr(l.name), shortName: tr(l.name).split(' ')[0], color: l.color, values: LEARNING_CURVE.map(p => p.f1[l.id])}))}
          yDomain={[0.5, 0.9]}
          formatY={fmt2}
          caption={tr(t('Student F1 per label by training-set size', '学生模型各标签 F1 随训练集规模的变化'))}
        />
      </PanelSection>
      <PanelSection title={t('Runs', '训练记录')}>
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Run', '记录'))}</th>
                <th scope="col">{tr(t('Training rows', '训练行数'))}</th>
                <th scope="col">{tr(t('Macro-F1 on eval', '评估集宏平均 F1'))}</th>
                <th scope="col">{tr(t('Share of teacher', '达到教师的比例'))}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
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
                  <td>{r.size.toLocaleString('en-US')}</td>
                  <td>{fmt2(r.macro)}</td>
                  <td>{Math.round((r.macro / teacher) * 100)}%</td>
                </tr>
              ))}
              <tr className="total-row">
                <th scope="row">{tr(t('Teacher · prompt v3', '教师模型 · Prompt v3'))}</th>
                <td>—</td>
                <td>{fmt2(teacher)}</td>
                <td>100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </PanelSection>
    </VStack>
  );
}

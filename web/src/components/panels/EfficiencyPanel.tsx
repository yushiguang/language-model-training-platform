'use client';

import {Text} from '@astryxdesign/core/Text';
import {BarRows} from '@/components/charts/BarRows';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {EFFICIENCY} from '@/mock/metrics';
import {PanelSection} from './parts';

const DAYS_COLOR = '#3d4b5e';

/** The same job today versus on the platform, for the people deciding whether to adopt it. */
export function EfficiencyPanel() {
  const {tr} = useLocale();
  const {today, project} = EFFICIENCY;
  const hours = (h: number) => tr(t(`${h} h`, `${h} 小时`));

  return (
    <div className="page">
      <div className="compare">
        <div className="compare-col">
          <Text type="supporting" color="secondary" weight="medium">
            {tr(t('Today', '现在'))}
          </Text>
          <div className="stat-value">{tr(t(`${today.weeks} weeks`, `${today.weeks} 周`))}</div>
          <div className="stat-label">{tr(t(`${today.engineerHours} engineer hours`, `${today.engineerHours} 个工程师小时`))}</div>
        </div>
        <div className="compare-col compare-col-new">
          <Text type="supporting" color="secondary" weight="medium">
            {tr(t('This project', '本项目'))}
          </Text>
          <div className="stat-value">{tr(t(`${project.days} working days`, `${project.days} 个工作日`))}</div>
          <div className="stat-label">
            {tr(t(`${project.engineerHours} engineer hours · ${project.humanHours} h of PM and labeler time`, `${project.engineerHours} 个工程师小时 · 产品和标注 ${project.humanHours} 小时`))}
          </div>
        </div>
      </div>
      <Text color="secondary">
        {tr(
          t(
            `The agent took ${project.agentActions} actions: sampling, feature extraction, running the teacher, error analysis, cleaning and evaluation. People made 10 decisions and labeled posts.`,
            `智能体执行了 ${project.agentActions} 个操作：抽样、特征提取、运行教师模型、错误分析、清洗和评估。人做了 10 个决定，并标注了帖子。`,
          ),
        )}
      </Text>
      <PanelSection
        title={t('Working days per stage', '各阶段工作日')}
        description={t('Human labeling is most of the time and most of the human effort.', '人工标注占了大部分时间，也占了大部分人工投入。')}>
        <BarRows
          series={[{name: tr(t('Working days', '工作日')), color: DAYS_COLOR}]}
          rows={project.stages.map(s => ({label: tr(s.name), values: [s.days]}))}
          max={2}
          format={v => tr(t(`${v} d`, `${v} 天`))}
          caption={tr(t('Working days per stage in this project', '本项目各阶段的工作日'))}
        />
        <div className="table-scroll">
          <table className="data-table numeric">
            <thead>
              <tr>
                <th scope="col">{tr(t('Stage', '阶段'))}</th>
                <th scope="col">{tr(t('Working days', '工作日'))}</th>
                <th scope="col">{tr(t('Human time', '人工时间'))}</th>
              </tr>
            </thead>
            <tbody>
              {project.stages.map(s => (
                <tr key={s.name.en}>
                  <th scope="row">{tr(s.name)}</th>
                  <td>{s.days}</td>
                  <td>{hours(s.humanHours)}</td>
                </tr>
              ))}
              <tr className="total-row">
                <th scope="row">{tr(t('Total', '合计'))}</th>
                <td>{project.days}</td>
                <td>{hours(project.humanHours)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </PanelSection>
    </div>
  );
}

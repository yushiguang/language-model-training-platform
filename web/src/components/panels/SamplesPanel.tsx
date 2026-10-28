'use client';

import {useState} from 'react';
import {FactRows} from '@/components/cards/CardFrame';
import {PostLabels} from '@/components/PostLabels';
import {PostPreview} from '@/components/PostPreview';
import {ValueChip} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {LABELS, type LabelId} from '@/mock/fields';
import {SPLITS} from '@/mock/metrics';
import {POSTS} from '@/mock/posts';
import {useStory} from '@/story/StoryProvider';
import {PanelSection, StatGrid, pct, useNumber} from './parts';

/** Primary-value filter as toggle buttons; the count shows how many sample posts each keeps. */
function ValueFilter({value, onChange, counts}: {value: LabelId | 'all'; onChange: (v: LabelId | 'all') => void; counts: Record<LabelId | 'all', number>}) {
  const {tr} = useLocale();
  return (
    <div className="filter-chips" role="group" aria-label={tr(t('Filter by primary value', '按主要价值筛选'))}>
      <button type="button" className="filter-chip" aria-pressed={value === 'all'} onClick={() => onChange('all')}>
        {tr(t('All', '全部'))} <span className="filter-count">{counts.all}</span>
      </button>
      {LABELS.map(label => (
        <button key={label.id} type="button" className="filter-chip" aria-pressed={value === label.id} onClick={() => onChange(label.id)}>
          <ValueChip field="primary_value" id={label.id} /> <span className="filter-count">{counts[label.id]}</span>
        </button>
      ))}
    </div>
  );
}

export function SamplesPanel() {
  const {tr} = useLocale();
  const story = useStory();
  const num = useNumber();
  const [filter, setFilter] = useState<LabelId | 'all'>('all');
  const hasGold = story.isResolved('l-adj');

  // Before gold labels exist the filter uses the teacher's pre-scan; after, the human label.
  const labelsOf = (p: (typeof POSTS)[number]) => (hasGold ? p.gold : p.teacher);
  const counts = {all: POSTS.length} as Record<LabelId | 'all', number>;
  for (const label of LABELS) counts[label.id] = POSTS.filter(p => labelsOf(p).primary_value === label.id).length;
  const posts = POSTS.filter(p => filter === 'all' || labelsOf(p).primary_value === filter);

  return (
    <div className="page">
      <StatGrid
        stats={[
          {label: tr(t('Posts sampled', '抽样帖子')), value: num(SPLITS.pool)},
          {label: tr(t('Countries', '国家')), value: String(SPLITS.countries)},
          {label: tr(t('Languages', '语言')), value: String(SPLITS.languages)},
          {label: tr(t('Near-duplicates, grouped', '近似重复（已分组）')), value: pct(SPLITS.nearDuplicateShare)},
        ]}
      />
      <PanelSection
        title={t('Splits', '数据划分')}
        description={t('Split by creator and near-duplicate group, so no creator appears in both training and test.', '按作者和近似重复组划分，同一作者不会同时出现在训练集和测试集。')}>
        <FactRows
          rows={[
            {label: tr(t('Train', '训练')), value: `${num(SPLITS.train)} · ${tr(t('labeled by the teacher', '由教师模型标注'))}`},
            {label: tr(t('Eval', '评估')), value: `${num(SPLITS.eval)} · ${tr(t('labeled by people, used to tune the prompt', '人工标注，用于调 Prompt'))}`},
            {label: tr(t('Test', '测试')), value: `${num(SPLITS.test)} · ${tr(t('labeled by people, sealed until the release gate', '人工标注，发布门禁前封存'))}`},
          ]}
        />
      </PanelSection>
      <PanelSection
        title={t('Sample posts', '样本帖子')}
        description={
          hasGold
            ? t('12 of the eval posts with their human gold labels. Rows where the teacher answered differently say so.', '评估集中的 12 条及其人工金标。教师模型答案不同的字段会标出。')
            : t('12 of the eval posts with the teacher’s pre-scan, until people label them.', '评估集中的 12 条。人工标注前，显示教师模型的预扫结果。')
        }>
        <ValueFilter value={filter} onChange={setFilter} counts={counts} />
        <div className="post-grid">
          {posts.map(post => (
            <div key={post.id} className="post-card">
              <PostPreview post={post} isCompact />
              <div className="post-card-source">{tr(hasGold ? t('Human gold', '人工金标') : t('Teacher pre-scan', '教师模型预扫'))}</div>
              <PostLabels labels={labelsOf(post)} compareTo={hasGold ? post.teacher : undefined} differsNote={tr(t('teacher differs', '教师不同'))} />
            </div>
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

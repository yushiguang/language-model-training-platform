'use client';

import {Tooltip} from '@astryxdesign/core/Tooltip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {useStory} from '@/story/StoryProvider';
import type {Datasets, SplitStatus} from '@/story/types';

const SPLITS: {id: keyof Datasets; name: T}[] = [
  {id: 'train', name: t('Train', '训练')},
  {id: 'eval', name: t('Eval', '评估')},
  {id: 'test', name: t('Test', '测试')},
];

function compact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, {notation: 'compact', maximumFractionDigits: 1}).format(n);
}

/** The three datasets at a glance: labeled out of total, with where the labels came from on hover. */
export function DatasetStatus({datasets, canOpen}: {datasets: Datasets | null; canOpen: boolean}) {
  const {tr, locale} = useLocale();
  const {openPanel, isPanelAvailable} = useStory();
  const isOpenable = canOpen && isPanelAvailable('samples');
  const full = new Intl.NumberFormat(locale);

  const describe = (name: T, s: SplitStatus | undefined) => {
    if (!s || s.total === 0) return tr(t(`${name.en}: none yet`, `${name.zh}集：暂无`));
    const labels = s.labeled === 0 ? tr(t('no labels yet', '尚无标签')) : `${full.format(s.labeled)} ${tr(t('labeled', '已标注'))}${s.source ? ` · ${tr(s.source)}` : ''}`;
    return `${tr(name)} · ${full.format(s.total)} ${tr(t('posts', '条'))} · ${labels}`;
  };

  return (
    <div className="data-status" role="group" aria-label={tr(t('Datasets', '数据集'))}>
      {SPLITS.map(({id, name}) => {
        const s = datasets?.[id];
        const isEmpty = !s || s.total === 0;
        const isLabeled = !isEmpty && s.labeled === s.total;
        const state = isEmpty ? 'empty' : isLabeled ? 'labeled' : s.labeled > 0 ? 'partial' : 'unlabeled';
        const description = describe(name, s);
        return (
          <Tooltip key={id} content={description} placement="below">
            <button
              type="button"
              className={`data-chip data-${state}`}
              aria-label={description}
              aria-disabled={!isOpenable}
              onClick={() => isOpenable && openPanel('samples')}>
              <span className="data-name">{tr(name)}</span>
              <span className="data-count">{isEmpty ? '—' : `${compact(s.labeled, locale)} / ${compact(s.total, locale)}`}</span>
              <span className="data-meter" aria-hidden>
                <span style={{width: isEmpty ? 0 : `${(s.labeled / s.total) * 100}%`}} />
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

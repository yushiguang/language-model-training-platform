'use client';

import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import type {Datasets} from '@/story/types';

const SPLITS: {id: keyof Datasets; name: T}[] = [
  {id: 'train', name: t('Train', '训练集')},
  {id: 'eval', name: t('Eval', '评估集')},
  {id: 'test', name: t('Test', '测试集')},
];

/** The three datasets: labeled out of total, a small meter, and where the labels came from. */
export function DatasetStatus({datasets}: {datasets: Datasets}) {
  const {tr, locale} = useLocale();
  const num = new Intl.NumberFormat(locale);
  return (
    <dl className="data-rows">
      {SPLITS.map(({id, name}) => {
        const s = datasets[id];
        const isEmpty = s.total === 0;
        const isLabeled = !isEmpty && s.labeled === s.total;
        return (
          <div key={id} className={`data-row${isLabeled ? ' data-labeled' : ''}`}>
            <dt>{tr(name)}</dt>
            <dd className="data-count">{isEmpty ? tr(t('none', '无')) : `${num.format(s.labeled)} / ${num.format(s.total)}`}</dd>
            {!isEmpty && (
              <dd className="data-meter" aria-hidden>
                <span style={{width: `${(s.labeled / s.total) * 100}%`}} />
              </dd>
            )}
            {!isEmpty && <dd className="data-source">{s.labeled === 0 ? tr(t('No labels yet', '尚无标签')) : s.source ? tr(s.source) : tr(t('Labeled', '已标注'))}</dd>}
          </div>
        );
      })}
    </dl>
  );
}

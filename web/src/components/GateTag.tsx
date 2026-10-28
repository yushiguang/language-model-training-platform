import {Icon} from '@astryxdesign/core/Icon';
import {CircleCheck, CircleX} from 'lucide-react';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';

/** Whether an eval run passed its gate, as a tag with an icon and words, so it never rests on color. */
export function GateTag({passed}: {passed?: boolean}) {
  const {tr} = useLocale();
  if (passed === undefined) return null;
  return (
    <span className={`gate-tag ${passed ? 'gate-tag-pass' : 'gate-tag-fail'}`}>
      <Icon icon={passed ? CircleCheck : CircleX} size="xsm" color="inherit" />
      {tr(passed ? t('Passed gate', '已过门禁') : t('Below gate', '未过门禁'))}
    </span>
  );
}

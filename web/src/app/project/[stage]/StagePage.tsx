'use client';

import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useLocale} from '@/i18n/LocaleProvider';
import {STAGES} from '@/mock/stages';

export function StagePage({slug}: {slug: string}) {
  const {t} = useLocale();
  const stage = STAGES.find(s => s.slug === slug);
  if (!stage) return null;
  return (
    <VStack gap={3}>
      <Heading level={1}>{t(stage.titleKey)}</Heading>
      <Text>{t('common.comingNext')}</Text>
    </VStack>
  );
}

'use client';

import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useLocale} from '@/i18n/LocaleProvider';

export default function ProjectsPage() {
  const {t} = useLocale();
  return (
    <VStack gap={3}>
      <Heading level={1}>{t('projects.heading')}</Heading>
      <Text>{t('common.comingNext')}</Text>
    </VStack>
  );
}

'use client';

import {HStack} from '@astryxdesign/core/Layout';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import type {ModelStatus} from '@/story/models';

const STATUS: Record<ModelStatus, {label: T; variant: 'accent' | 'warning' | 'neutral'}> = {
  running: {label: t('Running', '运行中'), variant: 'accent'},
  waiting: {label: t('Waiting for you', '等待你处理'), variant: 'warning'},
  idle: {label: t('Idle', '空闲'), variant: 'neutral'},
};

/** A model's status as a dot plus words, so it never rests on color alone. */
export function ModelStatusDot({status, isReleased = false, hasLabel = false}: {status: ModelStatus; isReleased?: boolean; hasLabel?: boolean}) {
  const {tr} = useLocale();
  const meta = STATUS[status];
  const label = status === 'idle' && isReleased ? tr(t('Idle · released', '空闲 · 已发布')) : tr(meta.label);
  return (
    <HStack gap={1} align="center">
      <StatusDot variant={meta.variant} label={label} isPulsing={status === 'running'} />
      {hasLabel && (
        <Text type="supporting" color="secondary">
          {label}
        </Text>
      )}
    </HStack>
  );
}

export function statusLabel(status: ModelStatus): T {
  return STATUS[status].label;
}

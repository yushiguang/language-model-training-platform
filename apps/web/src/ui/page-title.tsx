'use client';

import Link from 'next/link';
import type {ReactNode} from 'react';
import {HStack, VStack, StackItem} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {ArrowLeftIcon} from '@heroicons/react/24/outline';

/** A page's title row (wireframes v346, `Page`): back link, title, a tag beside it, a supporting line, actions on the right. */
export function PageTitle({title, subtitle, back, actions, titleEnd}: {title: ReactNode; subtitle?: ReactNode; back?: {label: string; href: string}; actions?: ReactNode; titleEnd?: ReactNode}) {
  return (
    <HStack gap={4} vAlign="start" hAlign="between">
      <StackItem size="fill" style={{minWidth: 0}}>
        <VStack gap={2}>
          {back && (
            <Link className="sp-back" href={back.href}>
              <Icon icon={ArrowLeftIcon} size="sm" color="inherit" />
              {back.label}
            </Link>
          )}
          <HStack gap={3} vAlign="center" wrap="wrap">
            {typeof title === 'string' ? (
              <Heading level={1} className="sp-title" maxLines={1}>
                {title}
              </Heading>
            ) : (
              title
            )}
            {titleEnd}
          </HStack>
          {subtitle &&
            (typeof subtitle === 'string' ? (
              <Text type="body" color="secondary">
                {subtitle}
              </Text>
            ) : (
              subtitle
            ))}
        </VStack>
      </StackItem>
      {actions && (
        <HStack gap={2} vAlign="center">
          {actions}
        </HStack>
      )}
    </HStack>
  );
}

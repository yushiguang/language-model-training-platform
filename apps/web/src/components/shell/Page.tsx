'use client';

import type {ReactNode} from 'react';
import {Heading, HStack, StackItem, Text, VStack} from '@/ui/astryx';
import {PageTitle} from '@/ui';

/**
 * A page body (wireframes v346, `Page`): centred, at most 1200 wide with side margins, on white.
 * An optional back link, the title row with the page's actions on the right, an optional
 * supporting line, then the content. One card per job, never a card inside a card; sections are
 * set apart by spacing, not dividers (round 4).
 */
export function Page({
  title,
  subtitle,
  back,
  actions,
  titleEnd,
  below,
  width = 1200,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: {label: string; href: string};
  actions?: ReactNode;
  /** Beside the title, vertically centred on it (a status tag). */
  titleEnd?: ReactNode;
  /** Under the title row (filters, tabs). */
  below?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="sp-page" style={{maxWidth: width}}>
      <VStack gap={8}>
        <VStack gap={4}>
          <PageTitle title={title} subtitle={subtitle} back={back} actions={actions} titleEnd={titleEnd} />
          {below}
        </VStack>
        {children}
      </VStack>
    </div>
  );
}

/** A main column and one side card (the Checkout Wizard shape). */
export function WithSide({side, sideWidth = 340, sticky, children}: {side: ReactNode; sideWidth?: number; sticky?: boolean; children: ReactNode}) {
  return (
    <HStack gap={8} vAlign="start">
      <StackItem size="fill" style={{minWidth: 0}}>
        {children}
      </StackItem>
      <div className={sticky ? 'sp-side-card sticky' : 'sp-side-card'} style={{width: sideWidth}}>
        {side}
      </div>
    </HStack>
  );
}

/** A section's title row inside a page: the title, an optional short hint, an action on the right. */
export function SectionTitle({title, hint, action, level = 2}: {title: string; hint?: string; action?: ReactNode; level?: 2 | 3}) {
  return (
    <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
      <HStack gap={3} vAlign="center">
        <Heading level={level}>{title}</Heading>
        {hint && (
          <Text type="supporting" color="secondary">
            {hint}
          </Text>
        )}
      </HStack>
      {action}
    </HStack>
  );
}

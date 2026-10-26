'use client';

import type {ReactNode} from 'react';
import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import type {LucideIcon} from 'lucide-react';

/** The shared shell of every agent card: a kind line with an icon, a title, then the body. */
export function CardFrame({
  icon,
  kind,
  title,
  children,
  isActive = false,
}: {
  icon: LucideIcon;
  kind: string;
  title: string;
  children?: ReactNode;
  /** Waiting on the user: gets an accent edge so it stands out in a long chat. */
  isActive?: boolean;
}) {
  return (
    <Card padding={4} maxWidth={560} className={isActive ? 'agent-card agent-card-active' : 'agent-card'}>
      <VStack gap={3}>
        <VStack gap={1}>
          <HStack gap={1.5} align="center">
            <Icon icon={icon} size="sm" color="secondary" />
            <Text type="supporting" color="secondary" weight="medium">
              {kind}
            </Text>
          </HStack>
          <Text type="large" weight="semibold">
            {title}
          </Text>
        </VStack>
        {children}
      </VStack>
    </Card>
  );
}

/** Two-column facts inside a card. */
export function FactRows({rows}: {rows: {label: string; value: ReactNode}[]}) {
  return (
    <dl className="fact-rows">
      {rows.map(row => (
        <div key={row.label} className="fact-row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

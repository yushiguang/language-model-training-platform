'use client';

import type {ReactNode} from 'react';
import {Icon} from '@astryxdesign/core/Icon';
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
    <section className={isActive ? 'agent-card agent-card-active' : 'agent-card'} aria-label={title}>
      <div className="agent-card-kind icon-line">
        <span className="icon-slot">
          <Icon icon={icon} size="sm" color="inherit" />
        </span>
        <span>{kind}</span>
      </div>
      <div className="agent-card-title">{title}</div>
      {children}
    </section>
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

/** An icon that sits on the first line of the text beside it, however the text wraps. */
export function IconLine({icon, children, className}: {icon: ReactNode; children: ReactNode; className?: string}) {
  return (
    <div className={className ? `icon-line ${className}` : 'icon-line'}>
      <span className="icon-slot">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

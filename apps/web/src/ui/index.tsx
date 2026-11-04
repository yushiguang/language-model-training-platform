'use client';

/**
 * Our component layer. Astryx is a 0.x beta, so screens import from here, never from Astryx
 * directly; a breaking Astryx release then only touches this file.
 */
import Link from 'next/link';
import {Theme} from '@astryxdesign/core/theme';
import {LinkProvider} from '@astryxdesign/core/Link';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import {Button as AxButton} from '@astryxdesign/core/Button';
import {Badge as AxBadge} from '@astryxdesign/core/Badge';
import {Dialog as AxDialog, DialogHeader} from '@astryxdesign/core/Dialog';
import type {ReactNode} from 'react';

type BtnProps = {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void | Promise<void>;
  href?: string;
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  end?: ReactNode;
  className?: string;
};

/** Theme and link handling for every component below; mounted once around the whole app. */
export function UiProvider({children}: {children: ReactNode}) {
  return (
    <Theme theme={neutralTheme} mode="light">
      <LinkProvider component={Link}>{children}</LinkProvider>
    </Theme>
  );
}

export function Button({label, variant = 'secondary', size = 'md', onClick, href, disabled, loading, icon, end, className}: BtnProps) {
  return (
    <AxButton
      label={label}
      variant={variant}
      size={size}
      href={href}
      isDisabled={disabled}
      isLoading={loading}
      icon={icon}
      endContent={end}
      className={className}
      onClick={onClick ? () => void onClick() : undefined}
    />
  );
}

export function Badge({label, tone = 'neutral', icon}: {label: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'error'; icon?: ReactNode}) {
  return <AxBadge label={label} variant={tone} icon={icon} />;
}

/** Passed / Below / Met: green or grey, always with an icon so colour is never the only signal. */
export function StatusBadge({passed, labels = ['Passed', 'Below']}: {passed: boolean; labels?: [string, string]}) {
  return passed ? <Badge tone="success" label={labels[0]} icon={<Icon name="check" size={12} />} /> : <Badge label={labels[1]} icon={<Icon name="down" size={12} />} />;
}

export function Dialog({open, onClose, title, subtitle, children, width = 560}: {open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; width?: number}) {
  return (
    <AxDialog isOpen={open} onOpenChange={o => !o && onClose()} width={width}>
      <DialogHeader title={title} subtitle={subtitle} onOpenChange={o => !o && onClose()} />
      <div style={{padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 16}}>{children}</div>
    </AxDialog>
  );
}

const PATHS: Record<string, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  down: <path d="m6 9 6 6 6-6" />,
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  back: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </>
  ),
  minimise: (
    <>
      <path d="M14 10l7-7" />
      <path d="M20 10h-6V4" />
      <path d="M3 21l7-7" />
      <path d="M4 14h6v6" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  paperclip: (
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
};

export function Icon({name, size = 16}: {name: string; size?: number}) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" style={{width: size, height: size}}>
      {PATHS[name]}
    </svg>
  );
}

export function Progress({value, max}: {value: number; max: number}) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{width: `${pct}%`}} />
    </div>
  );
}

export function Tick() {
  return (
    <span className="tick">
      <Icon name="check" size={12} />
    </span>
  );
}

export function Note({children, tone = 'info'}: {children: ReactNode; tone?: 'info' | 'error'}) {
  return (
    <div className={tone === 'error' ? 'error-note' : 'note'} role="note">
      <span style={{marginTop: 2}}>
        <Icon name={tone === 'error' ? 'alert' : 'info'} />
      </span>
      <span>{children}</span>
    </div>
  );
}

export const money = (x: number) => (x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString('en-US')}`);
export const num = (x: number) => x.toLocaleString('en-US');
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
  return today ? `today ${t}` : `${d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'})} ${t}`;
};

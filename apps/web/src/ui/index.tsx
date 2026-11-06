'use client';

/**
 * The UI kit: React versions of the parts on the design's Components board (UI canvas, page
 * "Unified UI"). Every screen is built only from these parts and `kit.css`, so the app looks like
 * the canvas. A change to a part goes on the canvas first, then here.
 */
import Link from 'next/link';
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';

/** Mounted once around the app. The kit needs no theme provider; this only sets the root class. */
export function UiProvider({children}: {children: ReactNode}) {
  return <>{children}</>;
}

// ---------- icons (Lucide outline paths, the same set the canvas uses) ----------
const PATHS: Record<string, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  back: (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  up: (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  doc: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 21h14" />
    </>
  ),
  shuffle: (
    <>
      <path d="M16 3h5v5" />
      <path d="M4 20 21 3" />
      <path d="M21 16v5h-5" />
      <path d="m15 15 6 6" />
      <path d="M4 4l5 5" />
    </>
  ),
  video: (
    <>
      <path d="m22 8-6 4 6 4V8z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  left: <path d="m15 18-6-6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  spark: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </>
  ),
  chev: <path d="m6 9 6 6 6-6" />,
  ring: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  play: <path d="M6 4v16l14-8z" />,
};

export function Icon({name, size, style}: {name: keyof typeof PATHS | string; size?: number; style?: CSSProperties}) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" style={size ? {width: size, height: size, ...style} : style}>
      {PATHS[name]}
    </svg>
  );
}

// ---------- buttons ----------
export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'white';

export function Button({
  label,
  kind = 'secondary',
  size = 'md',
  icon,
  href,
  disabled,
  onClick,
  title,
  ariaLabel,
  className,
}: {
  label?: string;
  kind?: ButtonKind;
  size?: 'md' | 'sm';
  icon?: string;
  href?: string;
  disabled?: boolean;
  onClick?: () => void | Promise<unknown>;
  title?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const cls = `btn btn-${kind}${size === 'sm' ? ' btn-sm' : ''}${label ? '' : ' btn-icon'}${className ? ` ${className}` : ''}`;
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {label}
    </>
  );
  if (href && !disabled)
    return (
      <Link className={cls} href={href} title={title} aria-label={ariaLabel}>
        {inner}
      </Link>
    );
  const click = async () => {
    if (!onClick || busy) return;
    const r = onClick();
    if (r instanceof Promise) {
      setBusy(true);
      try {
        await r;
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <button type="button" className={cls} disabled={disabled || busy} onClick={() => void click()} title={title} aria-label={ariaLabel}>
      {inner}
    </button>
  );
}

// ---------- badges ----------
export type Tone = 'ok' | 'err' | 'info' | 'run' | 'warn' | 'gray';
const TONE_ICON: Partial<Record<Tone, string>> = {ok: 'check', err: 'x', info: 'ring', run: 'ring'};

export function Badge({text, tone = 'gray', icon = true}: {text: string; tone?: Tone; icon?: boolean}) {
  const i = icon ? TONE_ICON[tone] : undefined;
  return (
    <span className={`badge b-${tone}`}>
      {i && <Icon name={i} />}
      {text}
    </span>
  );
}
export const Passed = () => <Badge text="Passed" tone="ok" />;
export const Below = () => <Badge text="Below" tone="err" />;

// ---------- numbers ----------
export function Metric({label, value, unit, tone, size = 'md'}: {label?: ReactNode; value: ReactNode; unit?: string; tone?: 'ok' | 'err'; size?: 'md' | 'lg'}) {
  return (
    <div className={`metric${size === 'lg' ? ' lg' : ''}`}>
      {label != null && <span className="metric-l">{label}</span>}
      <div className="metric-v">
        <b className={tone ? `t-${tone}` : undefined}>{value}</b>
        {unit && <span>{unit}</span>}
      </div>
    </div>
  );
}
export function Metrics({children, vertical}: {children: ReactNode; vertical?: boolean}) {
  return <div className={`metrics${vertical ? ' v' : ''}`}>{children}</div>;
}
export const Score = ({v, ok}: {v: number; ok: boolean}) => <b className={`t-${ok ? 'ok' : 'err'}`}>{v.toFixed(2)}</b>;
export const Code = ({children}: {children: ReactNode}) => <span className="code">{children}</span>;

/** A word with a dashed underline whose detail shows on hover. */
export const Hov = ({text, tip}: {text: string; tip: string}) => (
  <span className="hov" title={tip}>
    {text}
  </span>
);

/** One line of text, cut with … and shown in full on hover. */
export const One = ({text, className, style}: {text: string; className?: string; style?: CSSProperties}) => (
  <span className={`one${className ? ` ${className}` : ''}`} title={text} style={style}>
    {text}
  </span>
);

// ---------- card ----------
export function Card({
  title,
  titleExtra,
  actions,
  children,
  ai,
  className,
  style,
  ariaLabel,
}: {
  title?: string;
  titleExtra?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  ai?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const head =
    title || actions ? (
      <div className="card-h">
        <div className="card-h-text">
          {title &&
            (titleExtra ? (
              <div className="card-t-row">
                <h2 className="card-t">{title}</h2>
                {titleExtra}
              </div>
            ) : (
              <h2 className="card-t">{title}</h2>
            ))}
        </div>
        {actions}
      </div>
    ) : null;
  return (
    <section className={`card${ai ? ' ai' : ''}${className ? ` ${className}` : ''}`} style={style} aria-label={ariaLabel ?? title}>
      {head}
      {children}
    </section>
  );
}

// ---------- table ----------
export interface Col {
  label: ReactNode;
  /** '' = text (left), 'c' = centred value (numbers, status), 'act' = row actions (right). */
  kind?: '' | 'c' | 'act';
}
export function Table({cols, rows, first = 28, actWidth = 160}: {cols: Col[]; rows: {key: string; cells: ReactNode[]}[]; first?: number; actWidth?: number}) {
  return (
    <table className="tbl">
      <colgroup>
        {cols.map((c, i) => (
          <col key={i} style={{width: i === 0 ? `${first}%` : c.kind === 'act' ? `${actWidth}px` : 'auto'}} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i} className={c.kind ?? ''}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key}>
            {r.cells.map((cell, i) => (
              <td key={i} className={cols[i]?.kind ?? ''}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- form ----------
export function Field({label, children, width}: {label: ReactNode; children: ReactNode; width?: number}) {
  return (
    <label className="field" style={width ? {width} : undefined}>
      <span className="field-l">{label}</span>
      {children}
    </label>
  );
}

export function Select<T extends string>({label, options, value, onChange, disabled}: {label: string; options: {value: T; label: string}[]; value: T; onChange: (v: T) => void; disabled?: boolean}) {
  return (
    <label className="field">
      <span className="field-l">{label}</span>
      <span className="select">
        <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value as T)}>
          {options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chev" />
      </span>
    </label>
  );
}

export function Progress({done, total}: {done: number; total: number}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="bar" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <span style={{width: `${pct}%`}} />
      </div>
      <small>
        {num(done)} of {num(total)}
      </small>
    </div>
  );
}

/** One choice of a few (radio). The meaning sits on the title's hover. */
export function Opt({title, tip, checked, onSelect, extra}: {title: string; tip: string; checked: boolean; onSelect: () => void; extra?: ReactNode}) {
  return (
    <div
      className="opt"
      role="radio"
      aria-checked={checked}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onSelect())}
    >
      <span className="radio" />
      <b>
        <Hov text={title} tip={tip} />
      </b>
      {extra}
    </div>
  );
}

export function Switch({on, locked, onChange, label}: {on: boolean; locked?: boolean; onChange?: (on: boolean) => void; label: string}) {
  return (
    <span
      className={`switch${on ? ' on' : ''}${locked ? ' locked' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={locked || undefined}
      tabIndex={locked ? -1 : 0}
      style={locked ? undefined : {cursor: 'pointer'}}
      onClick={() => !locked && onChange?.(!on)}
      onKeyDown={e => !locked && (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange?.(!on))}
    />
  );
}

export function Seg<T extends string>({options, value, onChange, label}: {options: {value: T; label: string}[]; value: T; onChange: (v: T) => void; label: string}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A checkbox drawn like the canvas: ticked, empty, or a dash when part of a section is ticked. */
export function Cb({state, onToggle, label}: {state: 'on' | 'off' | 'mixed'; onToggle?: () => void; label: string}) {
  const mixed = state === 'mixed';
  return (
    <span
      className={`cb${state === 'on' ? ' on' : ''}`}
      role="checkbox"
      aria-checked={mixed ? 'mixed' : state === 'on'}
      aria-label={label}
      tabIndex={onToggle ? 0 : -1}
      style={{cursor: onToggle ? 'pointer' : undefined, ...(mixed ? {background: 'var(--text)', borderColor: 'var(--text)'} : {})}}
      onClick={onToggle}
      onKeyDown={e => onToggle && (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onToggle())}
    >
      {state === 'on' && <Icon name="check" />}
      {mixed && <i style={{width: 8, height: 2, borderRadius: 1, background: '#fff'}} />}
    </span>
  );
}

/** A check line: green tick, amber warning or red error, with its one fix on the right. */
export function CheckRow({tone, text, tip, fix}: {tone: 'ok' | 'warn' | 'err'; text: ReactNode; tip?: string; fix?: ReactNode}) {
  return (
    <div className="chk-row">
      <span className={`chk ${tone}`}>{tone === 'ok' ? <Icon name="check" /> : tone === 'err' ? <Icon name="x" /> : <Icon name="alert" />}</span>
      <span className="grow one" title={tip ?? (typeof text === 'string' ? text : undefined)}>
        {tip && typeof text === 'string' ? <Hov text={text} tip={tip} /> : text}
      </span>
      {fix}
    </div>
  );
}

// ---------- agent output ----------
/**
 * The AI Suggestion card body: a small "AI Suggestion" label (dropped inside Ask AI), one bold
 * headline and one grey line, each one line, with the actions on the right.
 */
export function Suggestion({title, text, actions, kicker = true}: {title: string; text?: string; actions?: ReactNode; kicker?: boolean}) {
  return (
    <div className="agent inline-actions">
      {kicker && (
        <span className="agent-k">
          <Icon name="spark" />
          AI Suggestion
        </span>
      )}
      <div className="agent-main">
        <div className="agent-b">
          <span className="agent-t one" title={title}>
            {title}
          </span>
          {text && (
            <span className="agent-x one" title={text}>
              {text}
            </span>
          )}
        </div>
        {actions && <div className="agent-a">{actions}</div>}
      </div>
    </div>
  );
}
export function SuggestionCard(props: {title: string; text?: string; actions?: ReactNode}) {
  return (
    <section className="card ai" aria-label="AI Suggestion">
      <Suggestion {...props} />
    </section>
  );
}

export function Banner({text, action}: {text: string; action?: ReactNode}) {
  return (
    <div className="banner warn" role="status">
      <Icon name="alert" />
      <span className="grow">{text}</span>
      {action}
    </div>
  );
}

// ---------- tabs ----------
export function Tabs<K extends string>({items, selected, onSelect, end, label}: {items: {key: K; label: string; count?: ReactNode; extra?: ReactNode}[]; selected: K; onSelect: (k: K) => void; end?: ReactNode; label: string}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map(t => (
        <button key={t.key} type="button" role="tab" className="tab" aria-selected={t.key === selected} onClick={() => onSelect(t.key)} style={{display: 'inline-flex', alignItems: 'center', gap: 8}}>
          {t.label}
          {t.count != null && <span className="cnt">{t.count}</span>}
          {t.extra}
        </button>
      ))}
      <div className="tabs-end">{end}</div>
    </div>
  );
}

// ---------- page parts ----------
export function Empty({title, text, children}: {title: string; text: string; children?: ReactNode}) {
  return (
    <div className="empty">
      <span className="empty-ic">
        <Icon name="list" />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}

export function LinkChip({text}: {text: string}) {
  return (
    <span className="link-chip">
      <Icon name="doc" />
      {text}
    </span>
  );
}

/** One header structure on every page: title at the content edge, back arrow in the margin, actions on the right. */
export function PageHead({title, actions, back}: {title: string; actions?: ReactNode; back?: {label: string; href: string}}) {
  return (
    <div className="phb">
      {back && (
        <Link className="ph-back" href={back.href} title={back.label} aria-label={back.label}>
          <Icon name="back" />
        </Link>
      )}
      <h1 title={title}>{title}</h1>
      {actions && <div className="ph-actions">{actions}</div>}
    </div>
  );
}

/** A task in progress, centred on the page: title, progress, start time, Stop. */
export function CenterProgress({title, chip, done, total, startedAt, onStop}: {title: string; chip?: ReactNode; done: number; total: number; startedAt: string; onStop?: () => void}) {
  return (
    <div className="center-block">
      <h2 style={{fontSize: 17, lineHeight: '24px', fontWeight: 700}}>{title}</h2>
      {chip}
      <Progress done={done} total={total} />
      <span className="t-3" style={{fontSize: 13}}>
        Started {dateTime(startedAt)}
      </span>
      {onStop && (
        <div style={{marginTop: 8}}>
          <Button label="Stop" icon="stop" onClick={onStop} />
        </div>
      )}
    </div>
  );
}

/** Copies text and shows the result as the element's title for a moment. */
export function useCopy(): [string | null, (text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(text);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(null), 1600);
  };
  return [copied, copy];
}

// ---------- formats ----------
export const num = (x: number) => x.toLocaleString('en-US');
const pad = (n: number) => String(n).padStart(2, '0');
/** Every date and time reads 2026.11.06 10:42. */
export const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

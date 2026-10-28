'use client';

import {useState} from 'react';

export interface TrendSeries {
  id: string;
  name: string;
  color: string;
}

export interface TrendRun {
  id: string;
  label: string;
  /** Shown in the tooltip under the run's name, such as what it came from. */
  detail?: string;
  passed: boolean;
  values: Record<string, number>;
}

export interface TrendThreshold {
  value: number;
  /** Series this threshold applies to; several share one line drawn in alternating dashes. */
  seriesIds: string[];
  label: string;
}

const W = 640;
const H = 280;
const PAD = {top: 18, right: 150, bottom: 52, left: 44};
const LABEL_GAP = 14;

function spreadLabels(ys: number[]): number[] {
  const order = ys.map((y, i) => ({y, i})).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) if (order[k].y - order[k - 1].y < LABEL_GAP) order[k].y = order[k - 1].y + LABEL_GAP;
  const out = new Array<number>(ys.length);
  order.forEach(o => (out[o.i] = o.y));
  return out;
}

/**
 * Scores across evaluation runs, one line per series. Runs sit at equal steps in the order they ran.
 * Lines join only the runs on `path` (one lineage), so a branch never reads as a step forward; other
 * runs show as faint points. A filled point passed the gate, a hollow one didn't; dashed lines are thresholds.
 */
export function TrendChart({
  runs,
  series,
  path,
  highlight,
  best,
  thresholds,
  formatY,
  caption,
  passedLabel,
  failedLabel,
  thresholdLabel,
  bestLabel,
  onSelect,
}: {
  runs: TrendRun[];
  series: TrendSeries[];
  path: string[];
  highlight?: string;
  best?: string;
  thresholds: TrendThreshold[];
  formatY: (y: number) => string;
  caption: string;
  passedLabel: string;
  failedLabel: string;
  thresholdLabel: string;
  bestLabel: string;
  onSelect?: (id: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = innerW / Math.max(runs.length, 1);
  const x = (i: number) => PAD.left + step * (i + 0.5);

  const all = [...runs.flatMap(r => series.map(s => r.values[s.id])), ...thresholds.map(t => t.value)];
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 10) / 10);
  const hi = Math.min(1, Math.ceil((Math.max(...all) + 0.02) * 10) / 10);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.1) ticks.push(Math.round(v * 100) / 100);

  const onPath = runs.map(r => path.includes(r.id));
  const pathIdx = runs.map((_, i) => i).filter(i => onPath[i]);
  const last = pathIdx[pathIdx.length - 1];
  // Series values at the end of the line and the thresholds share the right margin, spread so none overlap.
  const seriesYs = last === undefined ? [] : series.map(s => y(runs[last].values[s.id]));
  const labelYs = spreadLabels([...seriesYs, ...thresholds.map(th => y(th.value))]);
  const endYs = labelYs.slice(0, seriesYs.length);
  const thresholdYs = labelYs.slice(seriesYs.length);
  const colorOf = (id: string) => series.find(s => s.id === id)!.color;

  return (
    <figure className="viz trend" aria-label={caption}>
      <div className="viz-legend">
        {series.map(s => (
          <span key={s.id} className="viz-legend-item">
            <span className="viz-swatch viz-swatch-line" style={{background: s.color}} />
            {s.name}
          </span>
        ))}
        {thresholds.length > 0 && (
          <span className="viz-legend-item">
            <svg width="18" height="4" aria-hidden>
              <line x1="0" x2="18" y1="2" y2="2" className="trend-legend-dash" />
            </svg>
            {thresholdLabel}
          </span>
        )}
        <span className="viz-legend-item">
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="4.5" className="trend-legend-filled" />
          </svg>
          {passedLabel}
        </span>
        <span className="viz-legend-item">
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="4" className="trend-legend-hollow" />
          </svg>
          {failedLabel}
        </span>
      </div>
      <div className="viz-plot trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption} onMouseLeave={() => setHover(null)}>
          {runs.map((r, i) => (r.id === highlight ? <rect key={`band-${r.id}`} className="trend-band" x={x(i) - step / 2} y={PAD.top} width={step} height={innerH} rx={8} /> : null))}
          {ticks.map(v => (
            <g key={v}>
              <line className="viz-grid" x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} />
              <text className="viz-tick" x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {formatY(v)}
              </text>
            </g>
          ))}
          {thresholds.map((th, k) => (
            <g key={th.label}>
              {th.seriesIds.map((id, k) => (
                <line
                  key={id}
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={y(th.value)}
                  y2={y(th.value)}
                  stroke={colorOf(id)}
                  strokeWidth={1.5}
                  strokeDasharray={`6 ${6 * (th.seriesIds.length * 2 - 1)}`}
                  strokeDashoffset={-12 * k}
                />
              ))}
              <text className="trend-threshold-label" x={PAD.left + innerW + 10} y={thresholdYs[k]} dominantBaseline="middle">
                {th.label}
              </text>
            </g>
          ))}
          {runs.map((r, i) => (
            <g key={r.id}>
              <text className={`viz-tick trend-x${r.id === highlight ? ' trend-x-current' : ''}`} x={x(i)} y={H - PAD.bottom + 20} textAnchor="middle">
                {r.label}
              </text>
              {r.id === best && (
                <text className="trend-best" x={x(i)} y={H - PAD.bottom + 38} textAnchor="middle">
                  {bestLabel}
                </text>
              )}
            </g>
          ))}
          {series.map(s => (
            <polyline key={s.id} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={pathIdx.map(i => `${x(i)},${y(runs[i].values[s.id])}`).join(' ')} />
          ))}
          {runs.map((r, i) =>
            series.map(s => (
              <circle
                key={`${r.id}-${s.id}`}
                cx={x(i)}
                cy={y(r.values[s.id])}
                r={hover === i ? 6 : r.passed ? 5 : 4.5}
                fill={r.passed ? s.color : '#ffffff'}
                stroke={r.passed ? '#ffffff' : s.color}
                strokeWidth={2}
                opacity={onPath[i] ? 1 : 0.4}
              />
            )),
          )}
          {last !== undefined &&
            series.map((s, k) => (
              <text key={s.id} className="viz-end-label" x={PAD.left + innerW + 10} y={endYs[k]} dominantBaseline="middle">
                {s.name} {formatY(runs[last].values[s.id])}
              </text>
            ))}
          {runs.map((r, i) => (
            <rect
              key={`hit-${r.id}`}
              className={onSelect ? 'trend-hit trend-hit-link' : 'trend-hit'}
              x={x(i) - step / 2}
              y={PAD.top}
              width={step}
              height={innerH + 44}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(r.id)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div className="viz-tooltip" style={{left: `${(x(hover) / W) * 100}%`}}>
            <div className="viz-tooltip-title">{runs[hover].label}</div>
            {runs[hover].detail && <div className="trend-tooltip-detail">{runs[hover].detail}</div>}
            <div className="trend-tooltip-detail">{runs[hover].passed ? passedLabel : failedLabel}</div>
            {series.map(s => (
              <div key={s.id} className="viz-tooltip-row">
                <span className="viz-swatch" style={{background: s.color}} />
                <span>{s.name}</span>
                <span className="viz-tooltip-value">{formatY(runs[hover].values[s.id])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <figcaption className="viz-caption">{caption}</figcaption>
    </figure>
  );
}

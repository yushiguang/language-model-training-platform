'use client';

import {useState} from 'react';

export interface LineSeries {
  name: string;
  /** Shorter name for the label at the line end; the legend keeps the full name. */
  shortName?: string;
  color: string;
  values: number[];
}

const W = 560;
const H = 260;
const PAD = {top: 16, right: 130, bottom: 36, left: 44};
const LABEL_GAP = 14;

/** Spread end labels apart so close values don't overlap; keeps their order. */
function spreadLabels(ys: number[]): number[] {
  const order = ys.map((y, i) => ({y, i})).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k].y - order[k - 1].y < LABEL_GAP) order[k].y = order[k - 1].y + LABEL_GAP;
  }
  const out = new Array<number>(ys.length);
  order.forEach(o => (out[o.i] = o.y));
  return out;
}

/**
 * A small multi-series line chart with a hover crosshair. Each series is named at its
 * line end and in the legend; x positions are linear in the x values.
 */
export function LineChart({
  xs,
  formatX,
  series,
  yDomain,
  formatY,
  caption,
}: {
  xs: number[];
  formatX: (x: number) => string;
  series: LineSeries[];
  yDomain: [number, number];
  formatY: (y: number) => string;
  caption: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (v: number) => PAD.left + ((v - xs[0]) / (xs[xs.length - 1] - xs[0])) * innerW;
  const y = (v: number) => PAD.top + (1 - (v - yDomain[0]) / (yDomain[1] - yDomain[0])) * innerH;
  const ticks = [];
  for (let v = yDomain[0]; v <= yDomain[1] + 1e-9; v += 0.1) ticks.push(Math.round(v * 100) / 100);
  const endYs = spreadLabels(series.map(s => y(s.values[s.values.length - 1])));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    xs.forEach((v, i) => {
      if (Math.abs(x(v) - px) < Math.abs(x(xs[best]) - px)) best = i;
    });
    setHover(best);
  }

  return (
    <figure className="viz" aria-label={caption}>
      <div className="viz-legend">
        {series.map(s => (
          <span key={s.name} className="viz-legend-item">
            <span className="viz-swatch viz-swatch-line" style={{background: s.color}} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="viz-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map(v => (
            <g key={v}>
              <line className="viz-grid" x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} />
              <text className="viz-tick" x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {formatY(v)}
              </text>
            </g>
          ))}
          {xs.map(v => (
            <text key={v} className="viz-tick" x={x(v)} y={H - PAD.bottom + 20} textAnchor="middle">
              {formatX(v)}
            </text>
          ))}
          {hover !== null && <line className="viz-crosshair" x1={x(xs[hover])} x2={x(xs[hover])} y1={PAD.top} y2={PAD.top + innerH} />}
          {series.map((s, si) => (
            <g key={s.name}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.values.map((v, i) => `${x(xs[i])},${y(v)}`).join(' ')}
              />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(xs[i])} cy={y(v)} r={hover === i ? 5 : 4} fill={s.color} className="viz-point" />
              ))}
              <text className="viz-end-label" x={x(xs[xs.length - 1]) + 10} y={endYs[si]} dominantBaseline="middle">
                {s.shortName ?? s.name} {formatY(s.values[s.values.length - 1])}
              </text>
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className="viz-tooltip" style={{left: `${(x(xs[hover]) / W) * 100}%`}}>
            <div className="viz-tooltip-title">{formatX(xs[hover])}</div>
            {series.map(s => (
              <div key={s.name} className="viz-tooltip-row">
                <span className="viz-swatch" style={{background: s.color}} />
                <span>{s.name}</span>
                <span className="viz-tooltip-value">{formatY(s.values[hover])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <figcaption className="viz-caption">{caption}</figcaption>
    </figure>
  );
}

'use client';

import {Tooltip} from '@astryxdesign/core/Tooltip';

// The longest bar stops short of the track end, leaving room for its value label.
const BAR_SPAN = 85;

export interface BarSeries {
  name: string;
  color: string;
}

export interface BarRow {
  label: string;
  /** One value per series, as a share of the axis maximum's unit (e.g. 0.58). */
  values: number[];
}

/**
 * Horizontal bars, one row per category and one bar per series. Values are
 * written at the bar ends, so identity never rests on color alone.
 */
export function BarRows({
  series,
  rows,
  max,
  format,
  caption,
}: {
  series: BarSeries[];
  rows: BarRow[];
  max: number;
  format: (value: number) => string;
  caption: string;
}) {
  return (
    <figure className="viz" aria-label={caption}>
      {series.length > 1 && (
        <div className="viz-legend">
          {series.map(s => (
            <span key={s.name} className="viz-legend-item">
              <span className="viz-swatch" style={{background: s.color}} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="bar-rows">
        {rows.map(row => (
          <div key={row.label} className="bar-row">
            <div className="bar-label">{row.label}</div>
            <div className="bar-track">
              {row.values.map((v, i) => (
                <Tooltip key={series[i].name} content={`${row.label} · ${series[i].name}: ${format(v)}`}>
                  <div className="bar-line">
                    <div className="bar" style={{width: `${(v / max) * BAR_SPAN}%`, background: series[i].color}} />
                    <span className="bar-value">{format(v)}</span>
                  </div>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="viz-caption">{caption}</figcaption>
    </figure>
  );
}

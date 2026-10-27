import type {MeasureRow} from './measures';
import type {Trend} from './trend';

/** A signed change, green when it is good news and red when it is bad. */
export function Delta({value, trend, digits = 2}: {value: number; trend: Trend; digits?: number}) {
  const r = Number(value.toFixed(digits));
  const text = r > 0 ? `+${r.toFixed(digits)}` : r < 0 ? `−${(-r).toFixed(digits)}` : `±${(0).toFixed(digits)}`;
  return <span className={`trend trend-${trend}`}>{text}</span>;
}

/** Before → after, with the after value colored by whether it is good news. */
export function BeforeAfter({row}: {row: MeasureRow}) {
  return (
    <span className="before-after">
      <span className="before">{row.before}</span>
      <span aria-hidden> → </span>
      <span className={`trend trend-${row.trend}`}>{row.after}</span>
    </span>
  );
}

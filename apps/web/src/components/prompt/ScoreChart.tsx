'use client';

/**
 * Score by version (design: one line, a dashed threshold line labelled at its left end, values
 * printed only for the best, the selected and the latest version, others on hover, and the
 * selected column shaded). Drawn as SVG like the canvas.
 */
export interface Point {
  label: string;
  score: number;
  passed: boolean;
}

const FONT = {fontFamily: 'Figtree, system-ui, sans-serif'};

export function ScoreChart({points, threshold, selected, onSelect, H = 200, W = 1232}: {points: Point[]; threshold: number; selected?: string; onSelect?: (label: string) => void; H?: number; W?: number}) {
  const n = points.length;
  if (!n) return null;
  const x0 = 48;
  const x1 = W - 16;
  const xs = points.map((_, i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1)));
  const top = 20;
  const bot = H - 32;
  const lo = Math.min(0.5, Math.floor(Math.min(...points.map(p => p.score), threshold) * 10) / 10);
  const y = (v: number) => bot - ((v - lo) / (1 - lo)) * (bot - top);
  const best = points.reduce((b, p, i) => (p.score > points[b].score ? i : b), 0);
  const si = selected ? points.findIndex(p => p.label === selected) : -1;
  const show = new Set([best, n - 1, ...(si >= 0 ? [si] : [])]);
  const grid: number[] = [];
  for (let g = lo; g <= 1.0001; g += 0.1) grid.push(Math.round(g * 10) / 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Score by version" style={{display: 'block'}}>
      {grid.map(g => (
        <g key={g}>
          <path d={`M${x0} ${y(g).toFixed(1)}H${x1}`} stroke="#00000010" />
          <text x={x0 - 12} y={y(g) + 4} textAnchor="end" fontSize={12} fill="#6a6a6a" style={FONT}>
            {g.toFixed(1)}
          </text>
        </g>
      ))}
      <path d={`M${x0} ${y(threshold).toFixed(1)}H${x1}`} stroke="#6a6a6a" strokeDasharray="4 4" />
      <text x={x0 + 8} y={y(threshold) - 8} textAnchor="start" fontSize={12} fontWeight={500} fill="#474747" style={FONT}>
        Threshold {threshold.toFixed(2)}
      </text>
      {si >= 0 && <rect x={xs[si] - 18} y={top - 8} width={36} height={bot - top + 16} rx={8} fill="#0000000a" />}
      {n > 1 && <path d={'M' + points.map((p, i) => `${xs[i].toFixed(1)} ${y(p.score).toFixed(1)}`).join(' L')} fill="none" stroke="#1b1b1b" strokeWidth={2} strokeLinejoin="round" />}
      {points.map((p, i) => {
        const col = p.passed ? '#2f7d33' : '#1b1b1b';
        const isSel = i === si;
        const ly = p.score >= threshold ? y(p.score) - 14 : y(p.score) + 22;
        const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        const lx = xs[i] + (n === 1 ? 0 : i === 0 ? 8 : i === n - 1 ? -8 : 0);
        return (
          <g
            key={p.label}
            style={onSelect ? {cursor: 'pointer'} : undefined}
            onClick={() => onSelect?.(p.label)}
            {...(onSelect ? {role: 'button', tabIndex: 0, 'aria-label': `${p.label}, ${p.score.toFixed(2)}`, onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p.label))} : {})}
          >
            <rect x={xs[i] - 18} y={top - 8} width={36} height={H - top} fill="transparent" />
            <text x={xs[i]} y={H - 6} textAnchor="middle" fontSize={12} fontWeight={isSel ? 600 : 400} fill={isSel ? '#000' : '#6a6a6a'} style={FONT}>
              {p.label}
            </text>
            <circle cx={xs[i]} cy={y(p.score)} r={p.passed ? 6 : 4.5} fill={p.passed ? col : '#fff'} stroke={col} strokeWidth={2}>
              <title>
                {p.label} · {p.score.toFixed(2)}
              </title>
            </circle>
            {show.has(i) && (
              <text x={lx} y={ly} textAnchor={anchor} fontSize={12} fontWeight={600} fill={col} style={FONT}>
                {p.score.toFixed(2)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

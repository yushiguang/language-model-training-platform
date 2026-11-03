'use client';

import {useEffect, useRef} from 'react';

export interface Series {
  name: string;
  /** One value per x label; null = not scored. */
  values: (number | null)[];
  color: string;
}

/** Score by version: one line per model, direct end labels, dashed threshold line. */
export function ScoreChart({labels, series, threshold, height = 260}: {labels: string[]; series: Series[]; threshold?: number | null; height?: number}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let chart: import('echarts').ECharts | null = null;
    let disposed = false;
    const onResize = () => chart?.resize();
    void import('echarts').then(echarts => {
      if (disposed || !el.current) return;
      chart = echarts.init(el.current, undefined, {renderer: 'svg'});
      const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
      const min = Math.max(0, Math.floor((Math.min(...all, threshold ?? 1) - 0.05) * 20) / 20);
      chart.setOption({
        animation: false,
        grid: {left: 40, right: 90, top: 16, bottom: 28},
        textStyle: {fontFamily: 'Figtree, system-ui, sans-serif'},
        tooltip: {trigger: 'axis', valueFormatter: (v: number) => (v == null ? '–' : v.toFixed(2))},
        xAxis: {type: 'category', data: labels, axisLine: {lineStyle: {color: '#d4d4d4'}}, axisTick: {show: false}, axisLabel: {color: '#666'}},
        yAxis: {type: 'value', min, max: 1, splitLine: {lineStyle: {color: '#00000014'}}, axisLabel: {color: '#666', formatter: (v: number) => v.toFixed(2)}},
        series: [
          ...series.map(s => ({
            name: s.name,
            type: 'line',
            data: s.values,
            connectNulls: true,
            symbolSize: 6,
            lineStyle: {width: 2, color: s.color},
            itemStyle: {color: s.color},
            endLabel: {show: true, formatter: s.name, color: s.color, fontWeight: 600},
          })),
          ...(threshold != null
            ? [{name: 'Threshold', type: 'line', data: labels.map(() => threshold), symbol: 'none', lineStyle: {type: 'dashed', color: '#919191', width: 1}, endLabel: {show: true, formatter: `Needs ${threshold.toFixed(2)}`, color: '#666'}, tooltip: {show: false}}]
            : []),
        ],
      });
      window.addEventListener('resize', onResize);
    });
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      chart?.dispose();
    };
  }, [JSON.stringify({labels, series, threshold})]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} className="chart" style={{height}} role="img" aria-label={`Score by version: ${series.map(s => `${s.name} ${s.values.filter(v => v != null).at(-1)?.toFixed(2) ?? '–'}`).join(', ')}`} />;
}

export const MODEL_COLOR: Record<string, string> = {A: '#1b1b1b', B: '#00838f'};

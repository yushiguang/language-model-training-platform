export type Trend = 'better' | 'worse' | 'same';

/** Whether a change is good news, given which way is better. Changes under half a point of the shown precision count as no change. */
export function trendOf(delta: number, betterIs: 'higher' | 'lower', epsilon = 0.005): Trend {
  if (Math.abs(delta) < epsilon) return 'same';
  return (delta > 0) === (betterIs === 'higher') ? 'better' : 'worse';
}

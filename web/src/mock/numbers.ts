/** Number formats shared by the story script and the pages, so the same value always reads the same. */
export const fmt2 = (v: number) => v.toFixed(2);
export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;

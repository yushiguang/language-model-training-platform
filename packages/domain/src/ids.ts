/** New record id: `<prefix>_<16 random hex chars>`. */
export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${rand}`;
}

/** A plain record (how maps cross a service boundary) as a Map, for code that looks things up. */
export const toMap = <V>(record: Record<string, V>): Map<string, V> => new Map(Object.entries(record));

/** Keys of work running in this page, so the same labeling run never starts twice. */
const inFlight = new Set<string>();

export async function once<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

export const busy = (key: string) => inFlight.has(key);

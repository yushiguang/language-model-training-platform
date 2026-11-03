import type {DocCollection, DocOrder, DocRuntime, StoredDoc} from '../../../contracts/src/infra-api';

/**
 * Stand-in document storage: persists collections in localStorage when available,
 * and falls back to an in-memory map during SSR or Node unit tests.
 */
export function localDocRuntime(prefix = 'tsp-doc'): DocRuntime {
  const memory = new Map<string, StoredDoc<any>[]>();
  let nextSeq = 1;

  const keyFor = (name: string) => `${prefix}:${name}`;
  const hasBrowserStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

  const readAll = <T extends object>(name: string): StoredDoc<T>[] => {
    if (hasBrowserStorage()) {
      try {
        const raw = window.localStorage.getItem(keyFor(name));
        return raw ? (JSON.parse(raw) as StoredDoc<T>[]) : [];
      } catch {
        // Fall through to in-memory storage if localStorage is unavailable.
      }
    }
    return (memory.get(name) as StoredDoc<T>[] | undefined) ?? [];
  };

  const writeAll = <T extends object>(name: string, docs: StoredDoc<T>[]) => {
    memory.set(name, docs);
    if (hasBrowserStorage()) {
      try {
        window.localStorage.setItem(keyFor(name), JSON.stringify(docs));
      } catch {
        // Ignore quota errors in stand-in mode.
      }
    }
  };

  const makeCollection = <T extends object>(name: string): DocCollection<T> => ({
    async add(data: T) {
      const docs = readAll<T>(name);
      const docId = String(Date.now() * 1000 + (nextSeq++ % 1000));
      docs.push({docId, data: structuredClone(data)});
      writeAll(name, docs);
      return {docId};
    },
    async set(docId: string, data: T) {
      const docs = readAll<T>(name);
      const idx = docs.findIndex(d => d.docId === docId);
      if (idx === -1) throw new Error(`Document ${docId} not found in ${name}`);
      docs[idx] = {docId, data: structuredClone(data)};
      writeAll(name, docs);
    },
    async find(where: Record<string, unknown> = {}, order?: DocOrder) {
      const entries = Object.entries(where);
      const matched = readAll<T>(name).filter(doc =>
        entries.every(([k, v]) => (doc.data as Record<string, unknown>)[k] === v),
      );
      if (order) {
        const sign = order.dir === 'desc' ? -1 : 1;
        matched.sort((a, b) => {
          const av = (a.data as Record<string, unknown>)[order.field];
          const bv = (b.data as Record<string, unknown>)[order.field];
          if (av === bv) return 0;
          return (av as any) < (bv as any) ? -1 * sign : 1 * sign;
        });
      }
      return matched.map(d => ({docId: d.docId, data: structuredClone(d.data)}));
    },
  });

  return {
    collection: <T extends object = Record<string, unknown>>(name: string) => makeCollection<T>(name),
  };
}

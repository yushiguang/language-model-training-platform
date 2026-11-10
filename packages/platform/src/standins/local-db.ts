import type {
  DocBatchOpResult,
  DocCollection,
  DocFieldValueSentinel,
  DocFilterExpression,
  DocOrder,
  DocPage,
  DocRuntime,
  DocStructuredQuery,
  DocSubscriptionHandlers,
  DocUpdatePatch,
  DocWhereOp,
  DocWriteBatch,
  StoredDoc,
} from '@tsp/contracts';

function isFilterExpression(val: unknown): val is DocFilterExpression {
  return typeof val === 'object' && val !== null && ('type' in val) && (((val as any).type === 'field') || ((val as any).type === 'and') || ((val as any).type === 'or'));
}

function isSentinel(val: unknown): val is DocFieldValueSentinel {
  return typeof val === 'object' && val !== null && '__docFieldValue' in val;
}

function evalOp(actual: unknown, op: DocWhereOp, expected: unknown): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '<':
      return (actual as any) < (expected as any);
    case '<=':
      return (actual as any) <= (expected as any);
    case '>':
      return (actual as any) > (expected as any);
    case '>=':
      return (actual as any) >= (expected as any);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'not-in':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'array-contains':
      return Array.isArray(actual) && actual.includes(expected);
    case 'array-contains-any':
      return Array.isArray(actual) && Array.isArray(expected) && expected.some(v => actual.includes(v));
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.toLowerCase().includes(expected.toLowerCase());
  }
}

function matchesFilter(record: Record<string, unknown>, expr: DocFilterExpression): boolean {
  if (expr.type === 'field') {
    return evalOp(record[expr.field], expr.op, expr.value);
  }
  if (expr.type === 'and') {
    return expr.filters.every(f => matchesFilter(record, f));
  }
  return expr.filters.some(f => matchesFilter(record, f));
}

function normalizeWhere(where?: Record<string, unknown> | DocFilterExpression | DocFilterExpression[]): DocFilterExpression | null {
  if (!where) return null;
  if (Array.isArray(where)) {
    return where.length ? {type: 'and', filters: where} : null;
  }
  if (isFilterExpression(where)) return where;
  const entries = Object.entries(where).filter(([, v]) => v !== undefined);
  if (!entries.length) return null;
  return {
    type: 'and',
    filters: entries.map(([field, value]) => ({type: 'field', field, op: '==', value})),
  };
}

function normalizeOrder(order?: DocOrder | DocOrder[]): DocOrder[] {
  if (!order) return [];
  return Array.isArray(order) ? order : [order];
}

function applyPatch<T extends object>(current: T, patch: DocUpdatePatch<T>): T {
  const next: Record<string, unknown> = {...(current as Record<string, unknown>)};
  for (const [k, rawVal] of Object.entries(patch)) {
    if (!isSentinel(rawVal)) {
      if (rawVal !== undefined) next[k] = structuredClone(rawVal);
      continue;
    }
    switch (rawVal.__docFieldValue) {
      case 'increment': {
        const cur = typeof next[k] === 'number' ? (next[k] as number) : 0;
        next[k] = cur + Number(rawVal.value ?? 0);
        break;
      }
      case 'arrayUnion': {
        const cur = Array.isArray(next[k]) ? [...(next[k] as unknown[])] : [];
        const additions = Array.isArray(rawVal.value) ? rawVal.value : [];
        for (const item of additions) {
          if (!cur.some(existing => JSON.stringify(existing) === JSON.stringify(item))) {
            cur.push(structuredClone(item));
          }
        }
        next[k] = cur;
        break;
      }
      case 'arrayRemove': {
        const cur = Array.isArray(next[k]) ? (next[k] as unknown[]) : [];
        const removals = Array.isArray(rawVal.value) ? rawVal.value : [];
        next[k] = cur.filter(existing => !removals.some(rem => JSON.stringify(existing) === JSON.stringify(rem)));
        break;
      }
      case 'delete': {
        delete next[k];
        break;
      }
    }
  }
  return next as T;
}

/**
 * Stand-in document storage: persists collections in localStorage when available,
 * and falls back to an in-memory map during SSR or Node unit tests.
 * Supports all 11 filter operators, composite AND/OR filters, atomic `DocFieldValue`
 * updates, pagination, polling subscriptions, and batch writes.
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

  const makeCollection = <T extends object>(name: string): DocCollection<T> => {
    const runQuery = async (q: DocStructuredQuery): Promise<DocPage<T>> => {
      const filter = normalizeWhere(q.where);
      const orders = normalizeOrder(q.orderBy);
      const matched = readAll<T>(name).filter(doc =>
        filter ? matchesFilter(doc.data as Record<string, unknown>, filter) : true,
      );
      if (orders.length > 0) {
        matched.sort((a, b) => {
          for (const ord of orders) {
            const sign = ord.dir === 'desc' ? -1 : 1;
            const av = (a.data as Record<string, unknown>)[ord.field];
            const bv = (b.data as Record<string, unknown>)[ord.field];
            if (av === bv) continue;
            return (av as any) < (bv as any) ? -1 * sign : 1 * sign;
          }
          return 0;
        });
      }
      const total = matched.length;
      const start = q.offset ?? 0;
      const sliced = q.limit != null ? matched.slice(start, start + q.limit) : matched.slice(start);
      return {
        documents: sliced.map(d => ({docId: d.docId, data: structuredClone(d.data), createdAt: d.createdAt})),
        total,
      };
    };

    return {
      name,
      async add(data: T) {
        const docs = readAll<T>(name);
        const docId = String(Date.now() * 1000 + (nextSeq++ % 1000));
        docs.push({docId, data: structuredClone(data), createdAt: new Date().toISOString()});
        writeAll(name, docs);
        return {docId};
      },
      async get(docId: string) {
        const found = readAll<T>(name).find(d => d.docId === String(docId));
        return found ? {docId: found.docId, data: structuredClone(found.data), createdAt: found.createdAt} : null;
      },
      async set(docId: string, data: T) {
        const docs = readAll<T>(name);
        const idx = docs.findIndex(d => d.docId === String(docId));
        if (idx === -1) throw new Error(`Document ${docId} not found in ${name}`);
        docs[idx] = {docId: docs[idx].docId, data: structuredClone(data), createdAt: docs[idx].createdAt};
        writeAll(name, docs);
      },
      async update(docId: string, patch: DocUpdatePatch<T>) {
        const docs = readAll<T>(name);
        const idx = docs.findIndex(d => d.docId === String(docId));
        if (idx === -1) throw new Error(`Document ${docId} not found in ${name}`);
        docs[idx] = {
          docId: docs[idx].docId,
          data: applyPatch(docs[idx].data, patch),
          createdAt: docs[idx].createdAt,
        };
        writeAll(name, docs);
      },
      async delete(docId: string) {
        const docs = readAll<T>(name);
        const idx = docs.findIndex(d => d.docId === String(docId));
        if (idx === -1) throw new Error(`Document ${docId} not found in ${name}`);
        docs.splice(idx, 1);
        writeAll(name, docs);
      },
      async find(where?: Record<string, unknown> | DocFilterExpression, order?: DocOrder | DocOrder[]) {
        const page = await runQuery({where, orderBy: order});
        return page.documents;
      },
      query: runQuery,
      subscribe(handlers: DocSubscriptionHandlers<T>) {
        const interval = handlers.intervalMs ?? 2000;
        let prev = new Map<string, string>();
        let initialized = false;
        const poll = async () => {
          try {
            const {documents} = await runQuery({});
            handlers.onSnapshot?.(documents);
            const next = new Map<string, string>();
            for (const doc of documents) {
              const serialized = JSON.stringify(doc.data);
              next.set(doc.docId, serialized);
              if (initialized) {
                if (!prev.has(doc.docId)) handlers.onCreate?.(doc);
                else if (prev.get(doc.docId) !== serialized) handlers.onUpdate?.(doc);
              }
            }
            if (initialized) {
              for (const oldId of prev.keys()) {
                if (!next.has(oldId)) handlers.onDelete?.(oldId);
              }
            }
            prev = next;
            initialized = true;
          } catch (err) {
            handlers.onError?.(err);
          }
        };
        void poll();
        const timer = setInterval(() => void poll(), interval);
        return {
          unsubscribe() {
            clearInterval(timer);
          },
        };
      },
    };
  };

  return {
    collection: <T extends object = Record<string, unknown>>(name: string) => makeCollection<T>(name),
    batch(): DocWriteBatch {
      const ops: (() => Promise<DocBatchOpResult>)[] = [];
      const batchObj: DocWriteBatch = {
        set<T extends object>(collectionName: string, docId: string, data: T) {
          const index = ops.length;
          ops.push(async () => {
            try {
              await makeCollection<T>(collectionName).set(docId, data);
              return {index, status: 'ok', docId};
            } catch (e) {
              return {index, status: 'error', error: (e as Error).message};
            }
          });
          return batchObj;
        },
        update<T extends object>(collectionName: string, docId: string, patch: DocUpdatePatch<T>) {
          const index = ops.length;
          ops.push(async () => {
            try {
              await makeCollection<T>(collectionName).update(docId, patch);
              return {index, status: 'ok', docId};
            } catch (e) {
              return {index, status: 'error', error: (e as Error).message};
            }
          });
          return batchObj;
        },
        delete(collectionName: string, docId: string) {
          const index = ops.length;
          ops.push(async () => {
            try {
              await makeCollection(collectionName).delete(docId);
              return {index, status: 'ok', docId};
            } catch (e) {
              return {index, status: 'error', error: (e as Error).message};
            }
          });
          return batchObj;
        },
        async commit() {
          if (!ops.length) throw new Error('Cannot commit an empty write batch');
          const results: DocBatchOpResult[] = [];
          for (const op of ops) {
            results.push(await op());
          }
          return {results};
        },
      };
      return batchObj;
    },
  };
}

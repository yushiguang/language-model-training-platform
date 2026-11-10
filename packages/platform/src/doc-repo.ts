import {
  DocFieldValue,
  DocFilter,
  type DocFilterExpression,
  type DocOrder,
  type DocRuntime,
  type DocSubscriptionHandlers,
  type DocUpdatePatch,
} from '@tsp/contracts';
import {newId} from '@tsp/domain';

export {DocFieldValue, DocFilter};

/**
 * Name of a document collection. Each service owns its own collections: catalog owns the product
 * records, labeling owns tasks and predictions. Uniqueness rules are enforced by the owning service.
 */
export type Kind = string;

const COLUMN_MAP: Record<string, string> = {
  id: '_appId',
  project_id: 'projectId',
  schema_version: 'schemaVersion',
  created_at: 'createdAt',
  snapshot_id: 'snapshotId',
  external_id: 'externalId',
  example_id: 'exampleId',
  prompt_version_id: 'promptVersionId',
  settings_hash: 'settingsHash',
  started_at: 'startedAt',
  context_id: 'contextId',
  training_set_id: 'trainingSetId',
};

const mapField = (col: string): string => COLUMN_MAP[col] ?? col;

function isFilterExpression(val: unknown): val is DocFilterExpression {
  return (
    typeof val === 'object' &&
    val !== null &&
    'type' in val &&
    ((val as any).type === 'field' || (val as any).type === 'and' || (val as any).type === 'or')
  );
}

function mapFilterExpression(expr: DocFilterExpression): DocFilterExpression {
  if (expr.type === 'field') {
    return {type: 'field', field: mapField(expr.field), op: expr.op, value: expr.value};
  }
  return {type: expr.type, filters: expr.filters.map(mapFilterExpression)};
}

function mapWhereInput(where?: Record<string, unknown> | DocFilterExpression): Record<string, unknown> | DocFilterExpression | undefined {
  if (!where) return undefined;
  if (isFilterExpression(where)) return mapFilterExpression(where);
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where)) {
    mapped[mapField(k)] = v;
  }
  return mapped;
}

function parseOrders(order: string): DocOrder[] | undefined {
  const trimmed = order.trim();
  if (!trimmed) return undefined;
  return trimmed.split(',').map(clause => {
    const parts = clause.trim().split(/\s+/);
    const field = mapField(parts[0]);
    const dir = parts[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
    return {field, dir};
  });
}

type StoredRecord<T> = T & {_appId: string};

function stripInternal<T extends object>(doc: StoredRecord<T>): T {
  const clone = {...doc} as Record<string, unknown>;
  delete clone._appId;
  return clone as T;
}

export class DocRepo {
  /** Maps `${kind}:${appId}` to the underlying document-store integer/string ID. */
  private docIds = new Map<string, string>();
  private db: DocRuntime;

  constructor(db: DocRuntime) {
    this.db = db;
  }

  private cacheKey(kind: string, appId: string): string {
    return `${kind}:${appId}`;
  }

  private async resolveDocId<T extends {id: string}>(kind: Kind, appId: string): Promise<string> {
    const cached = this.docIds.get(this.cacheKey(kind, appId));
    if (cached) return cached;
    const found = await this.db.collection<StoredRecord<T>>(kind).find({_appId: appId});
    if (!found[0]) throw new Error(`Record ${appId} not found in ${kind}`);
    this.docIds.set(this.cacheKey(kind, appId), found[0].docId);
    return found[0].docId;
  }

  async insert<T extends object>(kind: Kind, rec: T): Promise<T> {
    const appId = (rec as {id?: string}).id ?? newId('rec');
    const payload: StoredRecord<T> = {...rec, _appId: appId};
    const {docId} = await this.db.collection<StoredRecord<T>>(kind).add(payload);
    this.docIds.set(this.cacheKey(kind, appId), docId);
    return rec;
  }

  /** Full replacement update for mutable records; preserves `_appId` across overwrites. */
  async update<T extends {id: string}>(kind: Kind, rec: T): Promise<T> {
    const docId = await this.resolveDocId<T>(kind, rec.id);
    const payload: StoredRecord<T> = {...rec, _appId: rec.id};
    await this.db.collection<StoredRecord<T>>(kind).set(docId, payload);
    return rec;
  }

  /**
   * Partial update of an existing record by application `id`.
   * Only specified fields are modified; values may use `DocFieldValue.increment`,
   * `DocFieldValue.arrayUnion`, `DocFieldValue.arrayRemove`, or `DocFieldValue.delete`.
   */
  async patch<T extends {id: string}>(kind: Kind, id: string, patch: DocUpdatePatch<T>): Promise<void> {
    const docId = await this.resolveDocId<T>(kind, id);
    const mappedPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === '_appId') continue;
      mappedPatch[mapField(k)] = v;
    }
    await this.db.collection<StoredRecord<T>>(kind).update(docId, mappedPatch as DocUpdatePatch<StoredRecord<T>>);
  }

  /** Deletes a record by application `id`. */
  async delete(kind: Kind, id: string): Promise<void> {
    const docId = await this.resolveDocId<{id: string}>(kind, id);
    await this.db.collection(kind).delete(docId);
    this.docIds.delete(this.cacheKey(kind, id));
  }

  async get<T>(kind: Kind, id: string): Promise<T | null> {
    const docs = await this.db.collection<StoredRecord<T & object>>(kind).find({_appId: id});
    if (!docs[0]) return null;
    this.docIds.set(this.cacheKey(kind, id), docs[0].docId);
    return stripInternal(docs[0].data);
  }

  /**
   * Finds all records matching `where` (supports both plain `{field: value}` equality maps and
   * rich `DocFilter` expressions with `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`,
   * `array-contains`, `array-contains-any`, `contains`, `and`, `or`).
   */
  async find<T>(kind: Kind, where: Record<string, unknown> | DocFilterExpression = {}, order = ''): Promise<T[]> {
    const docs = await this.db.collection<StoredRecord<T & object>>(kind).find(mapWhereInput(where), parseOrders(order));
    return docs.map(d => {
      const appId = (d.data as {id?: string; _appId?: string})._appId ?? (d.data as {id?: string}).id;
      if (appId) this.docIds.set(this.cacheKey(kind, appId), d.docId);
      return stripInternal(d.data);
    });
  }

  /**
   * Executes a paginated query returning `{items, total}`, supporting `limit`, `offset`,
   * multi-column `order`, and composite `DocFilter` expressions.
   */
  async query<T>(
    kind: Kind,
    opts: {where?: Record<string, unknown> | DocFilterExpression; order?: string; limit?: number; offset?: number} = {},
  ): Promise<{items: T[]; total: number}> {
    const page = await this.db.collection<StoredRecord<T & object>>(kind).query({
      where: mapWhereInput(opts.where),
      orderBy: opts.order ? parseOrders(opts.order) : undefined,
      limit: opts.limit,
      offset: opts.offset,
    });
    const items = page.documents.map(d => {
      const appId = (d.data as {id?: string; _appId?: string})._appId ?? (d.data as {id?: string}).id;
      if (appId) this.docIds.set(this.cacheKey(kind, appId), d.docId);
      return stripInternal(d.data);
    });
    return {items, total: page.total};
  }

  /** Subscribes to changes in a collection via polling. */
  subscribe<T extends object>(
    kind: Kind,
    handlers: {
      intervalMs?: number;
      onSnapshot?: (items: T[]) => void;
      onCreate?: (item: T) => void;
      onUpdate?: (item: T) => void;
      onDelete?: (docId: string) => void;
      onError?: (error: unknown) => void;
    },
  ): {unsubscribe(): void} {
    const unwrap = (doc: {docId: string; data: StoredRecord<T>}): T => {
      const appId = (doc.data as {id?: string; _appId?: string})._appId ?? (doc.data as {id?: string}).id;
      if (appId) this.docIds.set(this.cacheKey(kind, appId), doc.docId);
      return stripInternal(doc.data);
    };
    const subHandlers: DocSubscriptionHandlers<StoredRecord<T>> = {
      intervalMs: handlers.intervalMs,
      onSnapshot: handlers.onSnapshot ? docs => handlers.onSnapshot!(docs.map(unwrap)) : undefined,
      onCreate: handlers.onCreate ? doc => handlers.onCreate!(unwrap(doc)) : undefined,
      onUpdate: handlers.onUpdate ? doc => handlers.onUpdate!(unwrap(doc)) : undefined,
      onDelete: handlers.onDelete,
      onError: handlers.onError,
    };
    return this.db.collection<StoredRecord<T>>(kind).subscribe(subHandlers);
  }

  /** Inserts many records, a few requests at a time (document stores have no multi-insert here). */
  async insertMany<T extends object>(kind: Kind, recs: T[], parallel = 8): Promise<void> {
    for (let i = 0; i < recs.length; i += parallel) {
      await Promise.all(recs.slice(i, i + parallel).map(r => this.insert(kind, r)));
    }
  }

  /** Partial updates of many records in one batch request. Not atomic: check the results. */
  async patchMany<T extends {id: string}>(kind: Kind, patches: {id: string; patch: DocUpdatePatch<T>}[]): Promise<void> {
    if (!patches.length) return;
    const batch = this.db.batch();
    for (const p of patches) {
      const docId = await this.resolveDocId<T>(kind, p.id);
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.patch)) if (k !== '_appId' && k !== 'id') mapped[mapField(k)] = v;
      batch.update(kind, docId, mapped);
    }
    const {results} = await batch.commit();
    const failed = results.filter(r => r.status === 'error');
    if (failed.length) throw new Error(`${failed.length} of ${patches.length} updates to ${kind} failed`);
  }
}

export {newId} from '@tsp/domain';

import {
  DocFieldValue,
  DocFilter,
  type DocFilterExpression,
  type DocOrder,
  type DocRuntime,
  type DocSubscriptionHandlers,
  type DocUpdatePatch,
} from '../../../../packages/contracts/src/infra-api.ts';

export {DocFieldValue, DocFilter};

/**
 * Collection names managed by the BFF repository.
 * Note: Unique constraints that existed in the SQL schema (such as (projectId, number) on
 * setup_versions, (projectId, major, minor) on prompt_versions, and the 4-tuple on predictions)
 * are enforced at the application/service layer when backed by a schemaless document store.
 */
export type Kind =
  | 'projects'
  | 'setup_versions'
  | 'dataset_snapshots'
  | 'examples'
  | 'gold_labels'
  | 'prompt_versions'
  | 'predictions'
  | 'labeling_runs'
  | 'eval_reports'
  | 'optimisation_runs'
  | 'training_sets'
  | 'gate_approvals'
  | 'chat_messages'
  | 'agent_proposals'
  | 'start_requests'
  | 'recommendations'
  | 'audit_log';

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

export class Repo {
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

  async insertTrainingRows(rows: {trainingSetId: string; exampleId: string}[]): Promise<void> {
    if (!rows.length) return;
    const col = this.db.collection<Record<string, unknown>>('training_rows');
    const bySet = new Map<string, Set<string>>();
    for (const r of rows) {
      let existing = bySet.get(r.trainingSetId);
      if (!existing) {
        const docs = await col.find({trainingSetId: r.trainingSetId});
        existing = new Set(docs.map(d => String(d.data.exampleId)));
        bySet.set(r.trainingSetId, existing);
      }
      if (existing.has(r.exampleId)) continue;
      await col.add({...r, _appId: `${r.trainingSetId}:${r.exampleId}`});
      existing.add(r.exampleId);
    }
  }

  async trainingRows<T>(trainingSetId: string): Promise<T[]> {
    const col = this.db.collection<StoredRecord<T & object>>('training_rows');
    const docs = await col.find({trainingSetId});
    return docs.map(d => stripInternal(d.data));
  }

  async setSplit(exampleId: string, split: string | null, data: object): Promise<void> {
    const docId = await this.resolveDocId<{id: string}>('examples', exampleId);
    await this.db.collection<Record<string, unknown>>('examples').set(docId, {...data, id: exampleId, split, _appId: exampleId});
  }

  /**
   * Updates the `split` and `optimiserHalf` fields of multiple examples in a single batch request.
   */
  async setSplitsBatch(examples: {id: string; split: string | null; optimiserHalf: boolean}[]): Promise<void> {
    if (!examples.length) return;
    const batch = this.db.batch();
    for (const ex of examples) {
      const docId = await this.resolveDocId<{id: string}>('examples', ex.id);
      batch.update('examples', docId, {split: ex.split, optimiserHalf: ex.optimiserHalf});
    }
    await batch.commit();
  }

  async audit(projectId: string | null, actor: string, action: string, data: object = {}): Promise<void> {
    const id = newId('au');
    const rec = {id, projectId, actor, action, createdAt: new Date().toISOString(), data, _appId: id};
    const {docId} = await this.db.collection<typeof rec>('audit_log').add(rec);
    this.docIds.set(this.cacheKey('audit_log', id), docId);
  }
}

export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${rand}`;
}

import type {SqlRuntime} from '../platform/interfaces';
import {SCHEMA_SQL, SCHEMA_VERSION} from './schema';

/**
 * A thin repository over the SQL runtime. Each kind maps to a table, its key columns and how
 * to read them from the record. Every statement is plain Postgres.
 */
type Cols = Record<string, (r: any) => unknown>;
const KINDS = {
  projects: {created_at: r => r.createdAt},
  setup_versions: {project_id: r => r.projectId, number: r => r.number, schema_version: r => r.schemaVersion, created_at: r => r.createdAt},
  dataset_snapshots: {project_id: r => r.projectId, number: r => r.number, created_at: r => r.createdAt},
  examples: {snapshot_id: r => r.snapshotId, external_id: r => r.externalId, split: r => r.split},
  gold_labels: {project_id: r => r.projectId, example_id: r => r.exampleId, schema_version: r => r.schemaVersion, created_at: r => r.createdAt},
  prompt_versions: {project_id: r => r.projectId, major: r => r.major, minor: r => r.minor, created_at: r => r.createdAt},
  predictions: {prompt_version_id: r => r.promptVersionId, endpoint: r => r.endpoint, settings_hash: r => r.settingsHash, example_id: r => r.exampleId},
  labeling_runs: {project_id: r => r.projectId, prompt_version_id: r => r.promptVersionId, endpoint: r => r.endpoint, state: r => r.state, started_at: r => r.startedAt},
  eval_reports: {project_id: r => r.projectId, prompt_version_id: r => r.promptVersionId, endpoint: r => r.endpoint, context_id: r => r.contextId, created_at: r => r.createdAt},
  optimisation_runs: {project_id: r => r.projectId, endpoint: r => r.endpoint, state: r => r.state, started_at: r => r.startedAt},
  training_sets: {project_id: r => r.projectId, state: r => r.state, started_at: r => r.startedAt},
  gate_approvals: {project_id: r => r.projectId, node: r => r.node, created_at: r => r.createdAt},
  chat_messages: {project_id: r => r.projectId, created_at: r => r.createdAt},
  agent_proposals: {project_id: r => r.projectId, kind: r => r.kind, state: r => r.state, created_at: r => r.createdAt},
  start_requests: {project_id: r => r.projectId, created_at: r => r.createdAt},
  recommendations: {project_id: r => r.projectId, created_at: r => r.createdAt},
  audit_log: {project_id: r => r.projectId, actor: r => r.actor, action: r => r.action, created_at: r => r.createdAt},
} satisfies Record<string, Cols>;

export type Kind = keyof typeof KINDS;

export class Repo {
  private ready: Promise<void> | null = null;
  constructor(private sql: SqlRuntime) {}

  migrate(): Promise<void> {
    return (this.ready ??= (async () => {
      await this.sql.exec(SCHEMA_SQL);
      await this.sql.query('insert into schema_meta (version) values ($1) on conflict do nothing', [SCHEMA_VERSION]);
    })());
  }

  private row(kind: Kind, rec: any) {
    const cols = KINDS[kind] as Cols;
    const names = Object.keys(cols);
    const values = names.map(n => cols[n](rec));
    return {names, values};
  }

  async insert<T extends object>(kind: Kind, rec: T): Promise<T> {
    await this.migrate();
    const {names, values} = this.row(kind, rec);
    const all = ['id', ...names, 'data'];
    const params = [(rec as any).id, ...values, JSON.stringify(rec)];
    await this.sql.query(`insert into ${kind} (${all.join(', ')}) values (${all.map((_, i) => `$${i + 1}`).join(', ')})`, params);
    return rec;
  }

  /** Only for the tables marked mutable in the schema. */
  async update<T extends {id: string}>(kind: Kind, rec: T): Promise<T> {
    await this.migrate();
    const {names, values} = this.row(kind, rec);
    const sets = [...names, 'data'].map((n, i) => `${n} = $${i + 2}`).join(', ');
    await this.sql.query(`update ${kind} set ${sets} where id = $1`, [rec.id, ...values, JSON.stringify(rec)]);
    return rec;
  }

  async get<T>(kind: Kind, id: string): Promise<T | null> {
    await this.migrate();
    const rows = await this.sql.query<{data: T | string}>(`select data from ${kind} where id = $1`, [id]);
    return rows[0] ? parse<T>(rows[0].data) : null;
  }

  async find<T>(kind: Kind, where: Record<string, unknown> = {}, order = ''): Promise<T[]> {
    await this.migrate();
    const keys = Object.keys(where);
    const clause = keys.length ? `where ${keys.map((k, i) => `${k} = $${i + 1}`).join(' and ')}` : '';
    const rows = await this.sql.query<{data: T | string}>(`select data from ${kind} ${clause} ${order ? `order by ${order}` : ''}`, keys.map(k => where[k]));
    return rows.map(r => parse<T>(r.data));
  }

  async insertTrainingRows(rows: {trainingSetId: string; exampleId: string}[]): Promise<void> {
    // One statement per row keeps this portable; batch it if the runtime supports multi-row inserts.
    await this.migrate();
    for (const r of rows)
      await this.sql.query('insert into training_rows (training_set_id, example_id, data) values ($1, $2, $3) on conflict do nothing', [r.trainingSetId, r.exampleId, JSON.stringify(r)]);
  }

  async trainingRows<T>(trainingSetId: string): Promise<T[]> {
    await this.migrate();
    const rows = await this.sql.query<{data: T | string}>('select data from training_rows where training_set_id = $1', [trainingSetId]);
    return rows.map(r => parse<T>(r.data));
  }

  async setSplit(exampleId: string, split: string | null, data: object): Promise<void> {
    await this.sql.query('update examples set split = $2, data = $3 where id = $1', [exampleId, split, JSON.stringify(data)]);
  }

  async audit(projectId: string | null, actor: string, action: string, data: object = {}): Promise<void> {
    await this.migrate();
    await this.sql.query('insert into audit_log (id, project_id, actor, action, created_at, data) values ($1, $2, $3, $4, $5, $6)', [newId('au'), projectId, actor, action, new Date().toISOString(), JSON.stringify(data)]);
  }
}

const parse = <T>(d: T | string): T => (typeof d === 'string' ? (JSON.parse(d) as T) : d);

export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${rand}`;
}

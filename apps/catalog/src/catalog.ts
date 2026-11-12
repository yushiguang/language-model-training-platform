import {NO_TELEMETRY, type CatalogContract, type CatalogKind, type CatalogRecords, type DocRuntime, type NewPromptVersion, type NewSetupVersion, type PromptVersion, type SetupVersion, type TelemetryPort} from '@tsp/contracts';
import {nextVersion} from '@tsp/domain';
import {DocRepo, newId} from '@tsp/platform';

const now = () => new Date().toISOString();

const ID_PREFIX: Record<CatalogKind, string> = {
  projects: 'pr',
  setup_versions: 'sv',
  dataset_snapshots: 'ds',
  examples: 'ex',
  gold_labels: 'gl',
  prompt_versions: 'pv',
  eval_reports: 'er',
  optimisation_runs: 'op',
  training_sets: 'ts',
  gate_approvals: 'ga',
  chat_messages: 'cm',
  agent_proposals: 'ap',
  start_requests: 'sr',
  audit_log: 'au',
};

/** New record id for a kind, for callers that build the record before inserting it. */
export const catalogId = (kind: CatalogKind) => newId(ID_PREFIX[kind]);

/**
 * The catalog: platform CRUD over the document store.
 * Writes are partial (`patch`), so a background run and a page action do not undo each other.
 * Version numbers are assigned here from what is stored, never from what a browser sent.
 */
export function createCatalog(db: DocRuntime, opts: {telemetry?: TelemetryPort} = {}): CatalogContract {
  const repo = new DocRepo(db);
  const orderOf = (order?: string) => order ?? '';

  const contract: CatalogContract = {
    async insert(kind, rec) {
      await repo.insert(kind, rec as object);
      return rec;
    },
    async insertMany(kind, recs) {
      await repo.insertMany(kind, recs as object[]);
    },
    get: (kind, id) => repo.get(kind, id),
    find: (kind, where = {}, order) => repo.find(kind, where as Record<string, unknown>, orderOf(order)),
    async findByIds<K extends CatalogKind>(kind: K, ids: string[]) {
      if (!ids.length) return [];
      const wanted = new Set(ids);
      const out: CatalogRecords[K][] = [];
      // `in` filters accept up to 30 values per query.
      for (let i = 0; i < ids.length; i += 30) {
        const chunk = ids.slice(i, i + 30);
        const rows = await repo.find<CatalogRecords[K]>(kind, {type: 'field', field: 'id', op: 'in', value: chunk});
        for (const r of rows) if (wanted.has((r as {id: string}).id)) out.push(r);
      }
      return out;
    },
    patch: (kind, id, patch) => repo.patch(kind, id, patch as Record<string, unknown>),
    patchMany: (kind, patches) => repo.patchMany(kind, patches as {id: string; patch: Record<string, unknown>}[]),

    async createPromptVersion(v: NewPromptVersion): Promise<PromptVersion> {
      const all = await repo.find<PromptVersion>('prompt_versions', {projectId: v.projectId});
      const parent = v.parentId ? (all.find(x => x.id === v.parentId) ?? null) : null;
      if (v.parentId && !parent) throw new Error('The version this was edited from no longer exists.');
      // Majors reserved by Optimiser runs are taken even before their first change is saved.
      const runs = v.kind === 'major' ? await repo.find<{major?: number}>('optimisation_runs', {projectId: v.projectId}) : [];
      const n = nextVersion(all, parent, v.kind, {inMajor: v.inMajor, reserved: runs.map(r => r.major ?? 0)});
      const {kind: _kind, inMajor: _inMajor, ...rest} = v;
      const version: PromptVersion = {...rest, id: catalogId('prompt_versions'), major: n.major, minor: n.minor, createdAt: now()};
      await repo.insert('prompt_versions', version);
      return version;
    },

    async createSetupVersion(v: NewSetupVersion): Promise<SetupVersion> {
      const all = await repo.find<SetupVersion>('setup_versions', {projectId: v.projectId});
      const number = all.reduce((m, x) => Math.max(m, x.number), 0) + 1;
      const setup: SetupVersion = {...v, id: catalogId('setup_versions'), number, createdAt: now()};
      await repo.insert('setup_versions', setup);
      return setup;
    },

    async audit(projectId, actor, action, data = {}) {
      await repo.insert('audit_log', {id: catalogId('audit_log'), projectId, actor, action, data, createdAt: now()});
    },
  };
  return instrument(contract, opts.telemetry ?? NO_TELEMETRY);
}

const KIND_OF: Partial<Record<keyof CatalogContract, CatalogKind>> = {createPromptVersion: 'prompt_versions', createSetupVersion: 'setup_versions', audit: 'audit_log'};

/** Counts and times every catalog operation (`tsp_catalog_*`), without changing what it does. */
function instrument(c: CatalogContract, tm: TelemetryPort): CatalogContract {
  if (tm === NO_TELEMETRY) return c;
  tm.allowLabelValues('op', Object.keys(c));
  const out = {} as Record<string, unknown>;
  for (const [op, fn] of Object.entries(c) as [keyof CatalogContract, (...a: unknown[]) => Promise<unknown>][]) {
    out[op] = async (...args: unknown[]) => {
      const collection = KIND_OF[op] ?? String(args[0]);
      const started = Date.now();
      try {
        const r = await fn(...args);
        tm.counter('tsp_catalog_operations_total', {collection, op, outcome: 'ok'});
        if (Array.isArray(r) && (op === 'find' || op === 'findByIds')) tm.histogram('tsp_catalog_documents_returned', r.length, {collection});
        return r;
      } catch (e) {
        tm.counter('tsp_catalog_operations_total', {collection, op, outcome: 'error'});
        tm.counter('tsp_storage_errors_total', {kind: 'other'});
        throw e;
      } finally {
        tm.histogram('tsp_catalog_operation_duration_seconds', (Date.now() - started) / 1000, {collection, op});
      }
    };
  }
  return out as unknown as CatalogContract;
}

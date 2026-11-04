import type {CatalogContract, CatalogKind, CatalogRecords, DocRuntime, NewPromptVersion, NewSetupVersion, PromptVersion, SetupVersion} from '@tsp/contracts';
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
  recommendations: 'rc',
  audit_log: 'au',
};

/** New record id for a kind, for callers that build the record before inserting it. */
export const catalogId = (kind: CatalogKind) => newId(ID_PREFIX[kind]);

/**
 * The catalog: platform CRUD over the document store.
 * Writes are partial (`patch`), so a background run and a page action do not undo each other.
 * Version numbers are assigned here from what is stored, never from what a browser sent.
 */
export function createCatalog(db: DocRuntime): CatalogContract {
  const repo = new DocRepo(db);
  const orderOf = (order?: string) => order ?? '';

  return {
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
      const n = nextVersion(all, parent, v.kind);
      const {kind: _kind, ...rest} = v;
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
}

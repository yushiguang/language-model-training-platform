/**
 * Postgres schema. Each table has the columns the app filters or sorts on, plus `data jsonb`
 * holding the whole record as in src/core/types.ts. Records are immutable except where a
 * table says "mutable" (run progress and the project's pointers).
 *
 * `npm run schema` writes this to ../db/schema.sql for the storage runtime.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
create table if not exists schema_meta (version int primary key, applied_at timestamptz not null default now());

-- mutable: current setup and dataset pointers, approved nodes
create table if not exists projects (
  id text primary key,
  created_at timestamptz not null,
  data jsonb not null
);

create table if not exists setup_versions (
  id text primary key,
  project_id text not null references projects(id),
  number int not null,
  schema_version int not null,
  created_at timestamptz not null,
  data jsonb not null,
  unique (project_id, number)
);

-- mutable: split sizes (set once)
create table if not exists dataset_snapshots (
  id text primary key,
  project_id text not null references projects(id),
  number int not null,
  created_at timestamptz not null,
  data jsonb not null
);

-- mutable: split (set once per snapshot)
create table if not exists examples (
  id text primary key,
  snapshot_id text not null references dataset_snapshots(id),
  external_id text not null,
  split text,
  data jsonb not null
);
create index if not exists examples_snapshot on examples (snapshot_id, split);

create table if not exists gold_labels (
  id text primary key,
  project_id text not null references projects(id),
  example_id text not null references examples(id),
  schema_version int not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index if not exists gold_labels_lookup on gold_labels (project_id, schema_version, example_id, created_at);

create table if not exists prompt_versions (
  id text primary key,
  project_id text not null references projects(id),
  major int not null,
  minor int not null,
  created_at timestamptz not null,
  data jsonb not null,
  unique (project_id, major, minor)
);

-- one row per (prompt version, endpoint, decoding settings, example); doubles as the cache
create table if not exists predictions (
  id text primary key,
  prompt_version_id text not null references prompt_versions(id),
  endpoint text not null,
  settings_hash text not null,
  example_id text not null references examples(id),
  data jsonb not null,
  unique (prompt_version_id, endpoint, settings_hash, example_id)
);

-- mutable: progress
create table if not exists labeling_runs (
  id text primary key,
  project_id text not null references projects(id),
  prompt_version_id text not null references prompt_versions(id),
  endpoint text not null,
  state text not null,
  started_at timestamptz not null,
  data jsonb not null
);

-- mutable: archived flag only
create table if not exists eval_reports (
  id text primary key,
  project_id text not null references projects(id),
  prompt_version_id text not null references prompt_versions(id),
  endpoint text not null,
  context_id text not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index if not exists eval_reports_lookup on eval_reports (project_id, prompt_version_id, endpoint);

-- mutable: progress
create table if not exists optimisation_runs (
  id text primary key,
  project_id text not null references projects(id),
  endpoint text not null,
  state text not null,
  started_at timestamptz not null,
  data jsonb not null
);

-- mutable: progress
create table if not exists training_sets (
  id text primary key,
  project_id text not null references projects(id),
  state text not null,
  started_at timestamptz not null,
  data jsonb not null
);

create table if not exists training_rows (
  training_set_id text not null references training_sets(id),
  example_id text not null references examples(id),
  data jsonb not null,
  primary key (training_set_id, example_id)
);

create table if not exists gate_approvals (
  id text primary key,
  project_id text not null references projects(id),
  node text not null,
  created_at timestamptz not null,
  data jsonb not null
);

create table if not exists chat_messages (
  id text primary key,
  project_id text not null references projects(id),
  created_at timestamptz not null,
  data jsonb not null
);
create index if not exists chat_messages_project on chat_messages (project_id, created_at);

-- mutable: state (open, approved, discarded)
create table if not exists agent_proposals (
  id text primary key,
  project_id text not null references projects(id),
  kind text not null,
  state text not null,
  created_at timestamptz not null,
  data jsonb not null
);

create table if not exists start_requests (
  id text primary key,
  project_id text not null references projects(id),
  created_at timestamptz not null,
  data jsonb not null
);

-- mutable: the user's response
create table if not exists recommendations (
  id text primary key,
  project_id text not null references projects(id),
  created_at timestamptz not null,
  data jsonb not null
);

create table if not exists audit_log (
  id text primary key,
  project_id text,
  actor text not null,
  action text not null,
  created_at timestamptz not null,
  data jsonb not null
);
`;

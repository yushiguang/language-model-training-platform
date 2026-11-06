/**
 * Contract: telemetry (`apps/telemetry`). The full list is designed in the doc
 * "Telemetry: events and metrics"; add to the doc first, then here.
 *
 * Two streams:
 * - service metrics, Prometheus style: counters, gauges and histograms with labels whose values
 *   come from a small fixed list (never a project, user, example or version id);
 * - product events: one structured record per thing a person or the system did, with ids.
 *
 * The port never throws and never blocks. Where the data goes is the platform's `TelemetrySink`
 * (stand-in: a local collection; later: the company's monitoring, plugged in by the internal agent).
 */

export const BUCKETS = {
  SHORT: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  CALL: [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64],
  LONG: [10, 30, 60, 120, 300, 600, 1800, 3600],
  RATIO: [0.5, 0.75, 0.9, 1, 1.1, 1.2, 1.5, 2],
  TOKENS: [256, 1024, 2048, 4096, 8192, 16384, 32768],
  COUNT: [0, 1, 2, 3, 4, 6],
  DOCS: [1, 10, 100, 1000, 10000],
  BYTES: [10_000, 100_000, 1_000_000, 10_000_000],
} as const;

type Spec = {type: 'counter' | 'gauge' | 'histogram'; help: string; labels: readonly string[]; buckets?: readonly number[]};

/** Every metric the platform reports. `app` and `env` are added by the port. */
export const METRICS = {
  // llm-gateway
  tsp_llm_requests_total: {type: 'counter', help: 'Attempts sent to a model endpoint (retries count)', labels: ['endpoint', 'model', 'purpose', 'outcome']},
  tsp_llm_calls_total: {type: 'counter', help: 'Calls after all retries', labels: ['endpoint', 'purpose', 'outcome']},
  tsp_llm_request_duration_seconds: {type: 'histogram', help: 'One attempt at the platform', labels: ['endpoint', 'model', 'purpose'], buckets: BUCKETS.CALL},
  tsp_llm_call_duration_seconds: {type: 'histogram', help: 'Whole call including queue wait and retries', labels: ['endpoint', 'purpose'], buckets: BUCKETS.CALL},
  tsp_llm_retries_total: {type: 'counter', help: 'Retries by reason', labels: ['endpoint', 'purpose', 'reason']},
  tsp_llm_tokens_total: {type: 'counter', help: 'Tokens by kind', labels: ['endpoint', 'model', 'purpose', 'kind']},
  tsp_llm_request_tokens: {type: 'histogram', help: 'Estimated input tokens of one request', labels: ['endpoint', 'purpose'], buckets: BUCKETS.TOKENS},
  tsp_llm_cost_usd_total: {type: 'counter', help: 'Cost from registry prices', labels: ['endpoint', 'model', 'purpose']},
  tsp_llm_limiter_queue_length: {type: 'gauge', help: 'Calls waiting for a slot', labels: ['endpoint']},
  tsp_llm_limiter_wait_seconds: {type: 'histogram', help: 'Time from asking for a slot to getting one', labels: ['endpoint'], buckets: BUCKETS.LONG},
  tsp_llm_in_flight: {type: 'gauge', help: 'Calls running now', labels: ['endpoint']},
  tsp_llm_concurrency_limit: {type: 'gauge', help: 'Current cap on calls in flight', labels: ['endpoint']},
  tsp_llm_qpm_used_ratio: {type: 'gauge', help: "Share of the minute's QPM used", labels: ['endpoint']},
  tsp_llm_tpm_used_ratio: {type: 'gauge', help: "Share of the minute's TPM used", labels: ['endpoint']},
  tsp_llm_endpoint_limit: {type: 'gauge', help: 'Limits in force, and whether they are assumed', labels: ['endpoint', 'kind', 'assumed']},
  // labeling
  tsp_labeling_tasks_started_total: {type: 'counter', help: 'Runs of a labeling task started (resumes included)', labels: ['task_purpose', 'trigger']},
  tsp_labeling_resumes_total: {type: 'counter', help: 'Runs that continued a task already begun', labels: ['task_purpose', 'trigger']},
  tsp_labeling_tasks_ended_total: {type: 'counter', help: 'Runs ended, by state and reason', labels: ['task_purpose', 'state', 'reason']},
  tsp_labeling_tasks_running: {type: 'gauge', help: 'Runners active in this browser', labels: ['task_purpose']},
  tsp_labeling_examples_total: {type: 'counter', help: 'Examples by result', labels: ['task_purpose', 'result']},
  tsp_labeling_example_duration_seconds: {type: 'histogram', help: 'Render, call, parse and save of one example', labels: ['task_purpose'], buckets: BUCKETS.CALL},
  tsp_labeling_task_duration_seconds: {type: 'histogram', help: 'Running time of one run', labels: ['task_purpose'], buckets: BUCKETS.LONG},
  tsp_labeling_cost_usd_total: {type: 'counter', help: 'Labeling cost', labels: ['task_purpose']},
  tsp_labeling_cost_vs_estimate_ratio: {type: 'histogram', help: 'Final cost / approved estimate, at task end', labels: ['task_purpose'], buckets: BUCKETS.RATIO},
  tsp_labeling_lock_conflicts_total: {type: 'counter', help: 'A tab asked to run a task another tab runs', labels: ['task_purpose']},
  tsp_labeling_stop_latency_seconds: {type: 'histogram', help: 'From Stop pressed to the runner stopping', labels: ['task_purpose'], buckets: BUCKETS.LONG},
  // agents
  tsp_agent_turns_total: {type: 'counter', help: 'User messages answered', labels: ['agent', 'page', 'outcome']},
  tsp_agent_turn_duration_seconds: {type: 'histogram', help: 'User message to last reply', labels: ['agent'], buckets: BUCKETS.CALL},
  tsp_agent_model_calls_total: {type: 'counter', help: 'Model calls in turns, tool loops included', labels: ['agent', 'model']},
  tsp_agent_handoffs_total: {type: 'counter', help: 'Front desk handoffs', labels: ['from', 'to', 'outcome']},
  tsp_agent_tool_calls_total: {type: 'counter', help: 'Agent tool calls', labels: ['agent', 'tool', 'outcome']},
  tsp_agent_tool_duration_seconds: {type: 'histogram', help: 'One tool call', labels: ['tool'], buckets: BUCKETS.SHORT},
  tsp_agent_tool_calls_per_turn: {type: 'histogram', help: 'Tool calls in one turn', labels: ['agent'], buckets: BUCKETS.COUNT},
  tsp_agent_parse_failures_total: {type: 'counter', help: "Answers that weren't the asked JSON", labels: ['agent', 'intent']},
  tsp_agent_proposals_total: {type: 'counter', help: 'Proposals by outcome', labels: ['agent', 'kind', 'outcome']},
  tsp_optimiser_runs_total: {type: 'counter', help: 'Optimiser runs by outcome', labels: ['slot', 'outcome']},
  tsp_optimiser_candidates_total: {type: 'counter', help: 'Optimiser candidates by result', labels: ['slot', 'result']},
  // catalog and storage
  tsp_catalog_operations_total: {type: 'counter', help: 'Catalog operations', labels: ['collection', 'op', 'outcome']},
  tsp_catalog_operation_duration_seconds: {type: 'histogram', help: 'One catalog operation', labels: ['collection', 'op'], buckets: BUCKETS.SHORT},
  tsp_catalog_documents_returned: {type: 'histogram', help: 'Size of find results', labels: ['collection'], buckets: BUCKETS.DOCS},
  tsp_storage_errors_total: {type: 'counter', help: 'Errors from the document store', labels: ['kind']},
  tsp_files_upload_bytes: {type: 'histogram', help: 'Uploaded file sizes', labels: ['kind'], buckets: BUCKETS.BYTES},
  // bff
  tsp_bff_calls_total: {type: 'counter', help: 'Calls into the bff', labels: ['method', 'outcome']},
  tsp_bff_call_duration_seconds: {type: 'histogram', help: 'One bff call', labels: ['method'], buckets: BUCKETS.SHORT},
  tsp_bff_project_state_load_seconds: {type: 'histogram', help: 'loadProjectState, which every page calls', labels: [], buckets: BUCKETS.SHORT},
  tsp_gate_actions_total: {type: 'counter', help: 'Gate approvals, skips and refusals', labels: ['node', 'action']},
  tsp_auto_starts_total: {type: 'counter', help: 'Automatic paid starts and what was decided', labels: ['what', 'decision']},
  tsp_cost_confirms_total: {type: 'counter', help: 'Cost confirms shown, accepted, cancelled', labels: ['what', 'outcome']},
  tsp_stale_writes_rejected_total: {type: 'counter', help: 'Writes based on an old read that were refused', labels: ['collection']},
  // web
  tsp_web_page_views_total: {type: 'counter', help: 'Page views', labels: ['page']},
  tsp_web_page_load_seconds: {type: 'histogram', help: 'Largest contentful paint', labels: ['page'], buckets: BUCKETS.CALL},
  tsp_web_interaction_seconds: {type: 'histogram', help: 'Interaction to next paint', labels: ['page'], buckets: BUCKETS.SHORT},
  tsp_web_errors_total: {type: 'counter', help: 'Script errors, failed backend calls, missing assets', labels: ['page', 'kind']},
  tsp_web_cross_tab_updates_total: {type: 'counter', help: 'Changes heard from another tab', labels: []},
  tsp_web_open_tabs: {type: 'gauge', help: 'Tabs of the site open in this browser', labels: []},
} as const satisfies Record<string, Spec>;

export type MetricName = keyof typeof METRICS;

/**
 * Allowed values for each metric label. A value that is not listed becomes `other`, so an id, an
 * email or free text can never become a label value. Labels whose values are only known at
 * startup start empty and are filled by the app that owns them (`TelemetryPort.allowLabelValues`):
 * `endpoint` and `model` by the llm-gateway (its registry), `op` by the catalog, `method` by the
 * web composition root (the bff calls it wraps).
 */
export const LABEL_VALUES: Record<string, readonly string[]> = {
  purpose: ['labeling', 'chat'],
  outcome: ['ok', 'error', 'rate_limited', 'server', 'timeout', 'rejected', 'aborted', 'gave_up', 'shown', 'accepted', 'cancelled', 'approved', 'discarded', 'joined', 'passes', 'no_new_ideas', 'budget', 'stopped', 'failed'],
  reason: ['rate_limited', 'server', 'timeout', 'user', 'budget', 'failures', 'closed', 'none'],
  kind: ['input', 'output', 'reasoning', 'qpm', 'tpm', 'concurrency', 'script', 'asset', 'backend', 'image', 'schema', 'prompt', 'other'],
  assumed: ['true', 'false'],
  task_purpose: ['eval', 'optimiser', 'test', 'training'],
  trigger: ['system', 'user'],
  state: ['queued', 'running', 'paused', 'needs_attention', 'done', 'stopped', 'failed'],
  result: ['valid', 'invalid', 'failed', 'kept', 'rejected', 'placeholders_changed'],
  agent: ['front_desk', 'schema_agent', 'prompt_agent', 'evaluation_agent'],
  from: ['front_desk'],
  to: ['schema_agent', 'prompt_agent', 'evaluation_agent'],
  intent: ['answer', 'propose_schema', 'revise_schema', 'draft_prompt', 'revise_prompt', 'explain_version', 'explain_report', 'reflect'],
  tool: ['get_page_view', 'list_versions', 'get_version', 'get_report', 'get_examples', 'get_gold_labels', 'get_predictions', 'check_template', 'try_template', 'score_version', 'start_optimiser'],
  page: ['projects', 'setup', 'dataset', 'gold', 'prompt', 'prompt_edit', 'compare', 'report', 'training', 'other'],
  slot: ['A', 'B'],
  what: ['score', 'resume', 'optimiser', 'try_template', 'score_version', 'start_optimiser', 'final_run', 'test_answers'],
  decision: ['started'],
  node: ['setup', 'dataset', 'gold', 'prompt', 'training'],
  action: ['approve', 'refused', 'skip'],
  collection: ['projects', 'setup_versions', 'dataset_snapshots', 'examples', 'gold_labels', 'prompt_versions', 'eval_reports', 'optimisation_runs', 'training_sets', 'gate_approvals', 'chat_messages', 'agent_proposals', 'start_requests', 'recommendations', 'audit_log'],
  // Filled at startup (see above).
  endpoint: [],
  model: [],
  op: [],
  method: [],
};
type OfType<T extends Spec['type']> = {[K in MetricName]: (typeof METRICS)[K]['type'] extends T ? K : never}[MetricName];
export type CounterName = OfType<'counter'>;
export type GaugeName = OfType<'gauge'>;
export type HistogramName = OfType<'histogram'>;
export type Labels = Record<string, string | number | boolean>;

type Id = string;
type Num = number;
type Slot = 'A' | 'B';

/** Every product event and its props (beyond the envelope). Names are snake_case, past tense. */
export interface EventProps {
  // Session and navigation
  session_started: {viewport: 'phone' | 'tablet' | 'desktop'; language: string};
  page_viewed: {from_page: string | null; version_id?: Id; slot?: Slot};
  page_left: {seconds_visible: Num; seconds_idle: Num};
  step_reached: {node: string; minutes_since_project_created: Num};
  project_created: Record<string, never>;
  project_opened: {node: string; days_since_last_open: Num | null};
  project_finished: {minutes_since_created: Num; total_cost_usd: Num; versions: Num; gold_labels: Num};
  // Setup
  task_described: {chars: Num; attachments: Num; example_ids: Num};
  schema_proposal_shown: {agent: string; fields: Num; values: Num; revision: Num};
  schema_approved: {fields: Num; values: Num; schema_version: Num; revisions_before: Num; edited_before_approve: boolean};
  schema_discarded: {revision: Num};
  schema_changed_after_labels: {gold_labels_needing_recheck: Num; reports_archived: Num};
  thresholds_saved: {mode: 'default' | 'custom' | 'none'; changed: string};
  models_saved: {slots: 'A' | 'B' | 'both'; temperature_changed: boolean};
  // Dataset
  sample_started: {requested: Num};
  sample_finished: {fetched: Num; seconds: Num; outcome: 'done' | 'stopped' | 'failed'};
  dataset_uploaded: {rows: Num; valid: Num; invalid: Num; video: Num; photo_text: Num};
  dataset_upload_failed: {reason: 'format' | 'empty' | 'too_large' | 'other'};
  split_applied: {eval: Num; test: Num; train: Num; used_recommended: boolean};
  // Gold Labels
  model_answer_revealed: {split: string; had_answer: boolean};
  gold_label_saved: {split: string; revealed: boolean; seconds_on_example: Num; matches_model: boolean | null; was_recheck: boolean};
  gold_labels_uploaded: {source: 'file' | 'bundled'; saved: Num; skipped: Num};
  gold_skipped: {eval_done: Num; eval_total: Num};
  test_answers_requested: {estimate_usd: Num; examples: Num};
  // Prompt Engineering
  prompt_draft_requested: Record<string, never>;
  template_fix_applied: {code: string; fix: string};
  feature_toggled: {group: string; key: string; on: boolean};
  prompt_image_added: {images_now: Num};
  prompt_preview_opened: {example_type: string};
  version_created: {made_by: string; kind: 'minor' | 'major'; from_version_id: Id | null; warnings: Num; lines_added: Num; lines_removed: Num};
  version_scored: {version_id: Id; slot: Slot; lowest_field_macro_f1: Num; passed: boolean; cost_usd: Num; trigger: string};
  report_opened: {version_id: Id; slot: Slot; from_page: string | null};
  compare_opened: Record<string, never>;
  advice_shown: {kind: string};
  advice_followed: {kind: string; seconds_after_shown: Num};
  optimiser_started: {slot: Slot; trigger: string; resumed: boolean};
  optimiser_stopped_by_user: {slot: Slot; candidates: Num; cost_usd: Num};
  optimiser_ended: {slot: Slot; outcome: string; candidates: Num; kept: Num; cost_usd: Num; best_lowest_field_macro_f1: Num | null};
  rerun_requested: {version_id: Id; slot: Slot};
  // Training and test sets
  final_run_confirm_shown: {train: Num; test_to_label: Num; test_with_gold: Num; test_with_answers: Num; estimate_usd: Num; evaluated: boolean};
  final_run_started: {version_id: Id; slot: Slot; label_test: boolean; estimate_usd: Num};
  final_run_resumed: {after: string; done: Num; total: Num};
  final_run_stopped_by_user: {done: Num; total: Num};
  final_run_ended: {state: string; train_rows: Num; test_rows: Num; invalid_rate: Num; cost_usd: Num; estimate_usd: Num; minutes: Num};
  low_count_warning_shown: {values_below_min: Num};
  export_downloaded: {set: 'training' | 'test' | 'both'; format: 'jsonl' | 'csv'; rows: Num};
  // Assistant and agents
  assistant_opened: Record<string, never>;
  assistant_minimised: Record<string, never>;
  chat_message_sent: {entry_agent: string; chars: Num; attachments: Num};
  agent_replied: {agent: string; seconds: Num; handoff_to: string | null; tool_calls: Num; proposal_kind: string | null};
  agent_tool_called: {agent: string; tool: string; ok: boolean; ms: Num};
  prompt_proposal_shown: {agent: string};
  prompt_proposal_approved: {agent: string; edited_before_approve: boolean};
  prompt_proposal_discarded: {agent: string};
  start_card_shown: {tool: string; estimate_usd: Num};
  start_card_accepted: {tool: string; estimate_usd: Num};
  start_card_cancelled: {tool: string; estimate_usd: Num};
  auto_started: {what: string; estimate_usd: Num; project_auto_spend_usd: Num};
  // Problems
  error_shown: {code: string; where: string};
  stale_page_made_read_only: {reason: 'schema_changed' | 'newer_version' | 'other_tab'};
  run_needs_attention: {task_purpose: string; failed: Num; total: Num};
}

export type EventName = keyof EventProps;

/**
 * The props each event may carry, checked when the event is recorded: other keys are dropped,
 * and a string prop must be a short token (an id, an enum, a page), never text. Keep in step with
 * `EventProps` (the type below makes a missing event or an unknown prop name a compile error).
 */
export const EVENT_PROP_KEYS: {[E in EventName]: readonly (keyof EventProps[E] & string)[]} = {
  // Session and navigation
  session_started: ['viewport', 'language'],
  page_viewed: ['from_page', 'version_id', 'slot'],
  page_left: ['seconds_visible', 'seconds_idle'],
  step_reached: ['node', 'minutes_since_project_created'],
  project_created: [],
  project_opened: ['node', 'days_since_last_open'],
  project_finished: ['minutes_since_created', 'total_cost_usd', 'versions', 'gold_labels'],
  // Setup
  task_described: ['chars', 'attachments', 'example_ids'],
  schema_proposal_shown: ['agent', 'fields', 'values', 'revision'],
  schema_approved: ['fields', 'values', 'schema_version', 'revisions_before', 'edited_before_approve'],
  schema_discarded: ['revision'],
  schema_changed_after_labels: ['gold_labels_needing_recheck', 'reports_archived'],
  thresholds_saved: ['mode', 'changed'],
  models_saved: ['slots', 'temperature_changed'],
  // Dataset
  sample_started: ['requested'],
  sample_finished: ['fetched', 'seconds', 'outcome'],
  dataset_uploaded: ['rows', 'valid', 'invalid', 'video', 'photo_text'],
  dataset_upload_failed: ['reason'],
  split_applied: ['eval', 'test', 'train', 'used_recommended'],
  // Gold Labels
  model_answer_revealed: ['split', 'had_answer'],
  gold_label_saved: ['split', 'revealed', 'seconds_on_example', 'matches_model', 'was_recheck'],
  gold_labels_uploaded: ['source', 'saved', 'skipped'],
  gold_skipped: ['eval_done', 'eval_total'],
  test_answers_requested: ['estimate_usd', 'examples'],
  // Prompt Engineering
  prompt_draft_requested: [],
  template_fix_applied: ['code', 'fix'],
  feature_toggled: ['group', 'key', 'on'],
  prompt_image_added: ['images_now'],
  prompt_preview_opened: ['example_type'],
  version_created: ['made_by', 'kind', 'from_version_id', 'warnings', 'lines_added', 'lines_removed'],
  version_scored: ['version_id', 'slot', 'lowest_field_macro_f1', 'passed', 'cost_usd', 'trigger'],
  report_opened: ['version_id', 'slot', 'from_page'],
  compare_opened: [],
  advice_shown: ['kind'],
  advice_followed: ['kind', 'seconds_after_shown'],
  optimiser_started: ['slot', 'trigger', 'resumed'],
  optimiser_stopped_by_user: ['slot', 'candidates', 'cost_usd'],
  optimiser_ended: ['slot', 'outcome', 'candidates', 'kept', 'cost_usd', 'best_lowest_field_macro_f1'],
  rerun_requested: ['version_id', 'slot'],
  // Training and test sets
  final_run_confirm_shown: ['train', 'test_to_label', 'test_with_gold', 'test_with_answers', 'estimate_usd', 'evaluated'],
  final_run_started: ['version_id', 'slot', 'label_test', 'estimate_usd'],
  final_run_resumed: ['after', 'done', 'total'],
  final_run_stopped_by_user: ['done', 'total'],
  final_run_ended: ['state', 'train_rows', 'test_rows', 'invalid_rate', 'cost_usd', 'estimate_usd', 'minutes'],
  low_count_warning_shown: ['values_below_min'],
  export_downloaded: ['set', 'format', 'rows'],
  // Assistant and agents
  assistant_opened: [],
  assistant_minimised: [],
  chat_message_sent: ['entry_agent', 'chars', 'attachments'],
  agent_replied: ['agent', 'seconds', 'handoff_to', 'tool_calls', 'proposal_kind'],
  agent_tool_called: ['agent', 'tool', 'ok', 'ms'],
  prompt_proposal_shown: ['agent'],
  prompt_proposal_approved: ['agent', 'edited_before_approve'],
  prompt_proposal_discarded: ['agent'],
  start_card_shown: ['tool', 'estimate_usd'],
  start_card_accepted: ['tool', 'estimate_usd'],
  start_card_cancelled: ['tool', 'estimate_usd'],
  auto_started: ['what', 'estimate_usd', 'project_auto_spend_usd'],
  // Problems
  error_shown: ['code', 'where'],
  stale_page_made_read_only: ['reason'],
  run_needs_attention: ['task_purpose', 'failed', 'total'],
};

/** One product event as the sink receives it. */
export interface TelemetryEvent<E extends EventName = EventName> {
  event: E;
  ts: string;
  event_id: string;
  session_id: string;
  user_id: string | null;
  project_id: string | null;
  page: string | null;
  app_version: string;
  props: EventProps[E];
}

/** Who and where, filled into every event (set by the web app as people move around). */
export interface TelemetryContext {
  userId?: string | null;
  projectId?: string | null;
  page?: string | null;
}

export interface TelemetryPort {
  counter(m: CounterName, labels?: Labels, by?: number): void;
  gauge(m: GaugeName, value: number, labels?: Labels): void;
  histogram(m: HistogramName, value: number, labels?: Labels): void;
  event<E extends EventName>(name: E, props: EventProps[E]): void;
  setContext(ctx: TelemetryContext): void;
  /** Adds values a label may take that are only known at startup (see `LABEL_VALUES`). */
  allowLabelValues(label: string, values: readonly string[]): void;
  /** Prometheus text exposition of everything counted so far. */
  render(): string;
  /** Sends what is buffered now (also runs on a timer and when the page hides). */
  flush(): Promise<void>;
}

/** Where telemetry goes: provided by the platform (stand-in or the company's adapter). */
export interface TelemetrySink {
  /** Called with the full exposition text; the adapter pushes it (the browser can't be scraped). */
  pushMetrics(exposition: string): Promise<void>;
  pushEvents(events: TelemetryEvent[]): Promise<void>;
}

/** A port that does nothing, for tests and for code that runs before wiring. */
export const NO_TELEMETRY: TelemetryPort = {
  counter() {},
  gauge() {},
  histogram() {},
  event() {},
  setContext() {},
  allowLabelValues() {},
  render: () => '',
  flush: async () => {},
};

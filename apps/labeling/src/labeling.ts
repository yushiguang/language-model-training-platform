import {
  DocFieldValue,
  NO_TELEMETRY,
  errorKindOf,
  type CatalogContract,
  type ContentPart,
  type CreateTaskInput,
  type DocRuntime,
  type EndpointId,
  type Example,
  type LabelingContract,
  type LabelingTask,
  type LlmGatewayContract,
  type ModelMessage,
  type Prediction,
  type RunOptions,
  type TaskState,
  type TelemetryPort,
  type TryTemplateRow,
} from '@tsp/contracts';
import {hashString, parseOutput, renderPrompt, settingsHash, type Part} from '@tsp/domain';
import {DocRepo, newId} from '@tsp/platform';
import {browserLocks, type TaskLocks} from './locks.ts';

export interface LabelingDeps {
  db: DocRuntime;
  catalog: CatalogContract;
  gateway: LlmGatewayContract;
  locks?: TaskLocks;
  /** Turns relative image URLs into ones the model can fetch. */
  resolveUrl?: (url: string) => string;
  /** Called after every write, so open pages refresh. */
  onChange?: () => void;
  telemetry?: TelemetryPort;
}

/** Examples labeled at once by default. */
export const DEFAULT_PARALLEL = 4;
/** The task pauses with "needs attention" when more than this share of examples failed. */
export const MAX_FAILED_SHARE = 0.05;
/** ...or when this many examples in a row failed. */
export const MAX_FAILED_IN_A_ROW = 20;
/** The task pauses when cost passes this multiple of the accepted estimate. */
export const BUDGET_MARGIN = 1.2;
/** How often a runner re-reads its task to see a Stop pressed in another tab. */
const STOP_CHECK_MS = 2000;

const TASKS = 'labeling_tasks';
const PREDICTIONS = 'predictions';
const now = () => new Date().toISOString();
const lockName = (taskId: string) => `labeling:${taskId}`;
const FINISHED: TaskState[] = ['done'];

export function toMessages(parts: Part[], resolveUrl: (u: string) => string = u => u): ModelMessage[] {
  const content: ContentPart[] = parts.map(p => (p.type === 'text' ? {type: 'text', text: p.text} : {type: 'image', url: resolveUrl(p.url)}));
  return [{role: 'user', content}];
}

/** One prediction per prompt version + model + settings + example (`try` 2: labeled again after an invalid answer). */
export const predictionId = (promptVersionId: string, endpoint: EndpointId, hash: string, exampleId: string, attempt = 1) =>
  `pd_${hashString(`${promptVersionId}|${endpoint}|${hash}|${exampleId}`)}${attempt > 1 ? `_${attempt}` : ''}`;

/**
 * The labeling app: runs labeling tasks. MVP runner = the open page, one runner per task via a
 * browser lock, up to `parallel` examples at once, each call through the llm-gateway (which keeps
 * calls under the endpoint's QPM/TPM and retries busy replies).
 */
export function createLabeling(deps: LabelingDeps): LabelingContract {
  const repo = new DocRepo(deps.db);
  const locks = deps.locks ?? browserLocks();
  const emit = () => deps.onChange?.();
  const active = new Map<string, AbortController>();
  const tm = deps.telemetry ?? NO_TELEMETRY;
  const running = new Map<string, number>();
  const stopPressed = new Map<string, number>();
  const setRunning = (purpose: string, d: number) => {
    running.set(purpose, (running.get(purpose) ?? 0) + d);
    tm.gauge('tsp_labeling_tasks_running', running.get(purpose)!, {task_purpose: purpose});
  };
  const defaultTrigger = (t: LabelingTask) => (t.purpose === 'eval' || t.purpose === 'optimiser' ? 'system' : 'user');

  /** Runs a task under its lock; a second tab asking for the same task gets null. */
  async function run(taskId: string, trigger?: 'system' | 'user', opts: RunOptions = {}) {
    const r = await locks.run(lockName(taskId), () => execute(taskId, trigger, opts));
    if (r === null) {
      const t = await getTask(taskId);
      if (t) tm.counter('tsp_labeling_lock_conflicts_total', {task_purpose: t.purpose});
    }
    return r;
  }

  const getTask = (id: string) => repo.get<LabelingTask>(TASKS, id);

  /** Every saved prediction per example, oldest first. */
  async function allPredictions(promptVersionId: string, endpoint: EndpointId, hash: string): Promise<Map<string, Prediction[]>> {
    const rows = await repo.find<Prediction>(PREDICTIONS, {promptVersionId, endpoint, settingsHash: hash}, 'createdAt');
    const out = new Map<string, Prediction[]>();
    for (const p of rows) out.set(p.exampleId, [...(out.get(p.exampleId) ?? []), p]);
    return out;
  }

  async function predictions(promptVersionId: string, endpoint: EndpointId, hash: string): Promise<Map<string, Prediction>> {
    const out = new Map<string, Prediction>();
    for (const [id, ps] of await allPredictions(promptVersionId, endpoint, hash)) out.set(id, ps.find(p => p.answer) ?? ps[0]);
    return out;
  }

  async function isRunning(taskId: string) {
    return active.has(taskId) || (await locks.isHeld(lockName(taskId)));
  }

  async function execute(taskId: string, trigger: 'system' | 'user' | undefined, opts: RunOptions): Promise<LabelingTask | null> {
    const task = await getTask(taskId);
    if (!task || FINISHED.includes(task.state)) return task;
    const purpose = task.purpose;
    const how = trigger ?? defaultTrigger(task);
    tm.counter('tsp_labeling_tasks_started_total', {task_purpose: purpose, trigger: how});
    if (task.startedAt) tm.counter('tsp_labeling_resumes_total', {task_purpose: purpose, trigger: how});
    const runStarted = Date.now();
    const [version, setup] = await Promise.all([deps.catalog.get('prompt_versions', task.promptVersionId), deps.catalog.get('setup_versions', task.setupVersionId)]);
    if (!version || !setup?.schema) {
      await repo.patch<LabelingTask>(TASKS, taskId, {state: 'failed', error: 'The prompt version or schema of this task no longer exists.', finishedAt: now()});
      emit();
      return getTask(taskId);
    }
    const schema = setup.schema;

    // Counters are rebuilt from saved predictions, so a crash never leaves them wrong.
    const all = await allPredictions(task.promptVersionId, task.endpoint, task.settingsHash);
    const best = (id: string) => all.get(id)?.find(p => p.answer) ?? all.get(id)?.[0];
    // Under relabelInvalid, an example whose only answer is invalid is labeled once more.
    const again = (id: string) => !!task.relabelInvalid && all.get(id)?.length === 1 && !all.get(id)![0].answer;
    const mine = task.exampleIds.filter(id => best(id) && !again(id)).map(id => best(id)!);
    const failedSet = new Set(task.failedExampleIds);
    const pending = task.exampleIds.filter(id => (!all.has(id) || again(id)) && !failedSet.has(id));
    const counts = {
      done: mine.length,
      valid: mine.filter(p => p.answer).length,
      invalid: mine.filter(p => !p.answer).length,
      failed: failedSet.size,
      costUsd: mine.reduce((n, p) => n + p.costUsd, 0),
    };
    await repo.patch<LabelingTask>(TASKS, taskId, {...counts, state: 'running', stopReason: null, stopRequested: false, error: null, startedAt: task.startedAt ?? now(), finishedAt: null});
    emit();

    const examples = new Map((await deps.catalog.findByIds('examples', pending)).map(e => [e.id, e] as [string, Example]));
    const ctrl = new AbortController();
    active.set(taskId, ctrl);
    setRunning(purpose, 1);
    let stopReason: LabelingTask['stopReason'] = null;
    let inARow = 0;
    let lastError: string | null = null;
    let lastStopCheck = Date.now();
    let next = 0;
    /** This run's own cost, for `opts.budgetUsd`. */
    let runCostUsd = 0;

    const checkStop = async () => {
      if (Date.now() - lastStopCheck < STOP_CHECK_MS) return;
      lastStopCheck = Date.now();
      const fresh = await getTask(taskId);
      if (fresh?.stopRequested) {
        if (!stopPressed.has(taskId)) stopPressed.set(taskId, Date.now() - STOP_CHECK_MS / 2);
        ctrl.abort();
      }
    };

    const worker = async () => {
      while (next < pending.length && !stopReason && !ctrl.signal.aborted) {
        const exampleId = pending[next++];
        const ex = examples.get(exampleId);
        const exStarted = Date.now();
        try {
          if (!ex) throw new Error('The example no longer exists.');
          const parts = renderPrompt(version.template, ex, version.features, version.images);
          const res = await deps.gateway.label({
            slot: task.endpoint,
            messages: toMessages(parts, deps.resolveUrl),
            maxOutputTokens: task.settings.maxOutputTokens,
            temperature: task.settings.temperature,
            traceId: ex.externalId,
            signal: ctrl.signal,
          });
          const parsed = parseOutput(res.text, schema);
          const pred: Prediction = {
            id: predictionId(task.promptVersionId, task.endpoint, task.settingsHash, exampleId, again(exampleId) ? 2 : 1),
            promptVersionId: task.promptVersionId,
            endpoint: task.endpoint,
            settingsHash: task.settingsHash,
            exampleId,
            output: res.text,
            answer: parsed.answer,
            invalidReason: parsed.reason,
            costUsd: res.costUsd,
            createdAt: now(),
          };
          // Prediction first, counters after: a crash in between undercounts, and the next run recounts.
          await repo.insert(PREDICTIONS, pred);
          await repo.patch<LabelingTask>(TASKS, taskId, {
            done: DocFieldValue.increment(1),
            [parsed.answer ? 'valid' : 'invalid']: DocFieldValue.increment(1),
            costUsd: DocFieldValue.increment(res.costUsd),
            ...(opts.auto ? {autoCostUsd: DocFieldValue.increment(res.costUsd)} : {}),
          });
          counts.done++;
          counts.costUsd += res.costUsd;
          runCostUsd += res.costUsd;
          inARow = 0;
          tm.counter('tsp_labeling_examples_total', {task_purpose: purpose, result: parsed.answer ? 'valid' : 'invalid'});
          tm.counter('tsp_labeling_cost_usd_total', {task_purpose: purpose}, res.costUsd);
          tm.histogram('tsp_labeling_example_duration_seconds', (Date.now() - exStarted) / 1000, {task_purpose: purpose});
        } catch (e) {
          if (errorKindOf(e) === 'aborted') break;
          tm.counter('tsp_labeling_examples_total', {task_purpose: purpose, result: 'failed'});
          inARow++;
          counts.failed++;
          lastError = (e as Error).message ?? String(e);
          await repo.patch<LabelingTask>(TASKS, taskId, {failed: DocFieldValue.increment(1), failedExampleIds: DocFieldValue.arrayUnion(exampleId), error: lastError});
          if (counts.failed / task.total > MAX_FAILED_SHARE || inARow >= MAX_FAILED_IN_A_ROW) stopReason = 'failures';
        }
        if (task.budgetUsd != null && counts.costUsd > task.budgetUsd * BUDGET_MARGIN) stopReason = 'budget';
        if (opts.budgetUsd != null && runCostUsd > opts.budgetUsd * BUDGET_MARGIN) stopReason = 'budget';
        emit();
        await checkStop();
      }
    };

    try {
      await Promise.all(Array.from({length: Math.max(1, task.parallel)}, worker));
    } finally {
      active.delete(taskId);
      setRunning(purpose, -1);
    }

    let state: TaskState;
    let error: string | null = lastError;
    if (ctrl.signal.aborted) {
      state = 'stopped';
      stopReason = 'user';
      error = null;
    } else if (stopReason === 'budget') {
      state = 'paused';
      error =
        task.budgetUsd != null && counts.costUsd > task.budgetUsd * BUDGET_MARGIN
          ? `Paused: the cost passed ${Math.round(BUDGET_MARGIN * 100)}% of the approved estimate.`
          : `Paused: this automatic start cost more than ${Math.round(BUDGET_MARGIN * 100)}% of its estimate.`;
    } else if (stopReason === 'failures' || counts.failed > 0) {
      state = 'needs_attention';
      stopReason = 'failures';
      error = `${counts.failed} example${counts.failed === 1 ? '' : 's'} failed. ${lastError ? `Last error: ${lastError}. ` : ''}Retry failed to label them again.`;
    } else {
      state = 'done';
      error = null;
    }
    await repo.patch<LabelingTask>(TASKS, taskId, {state, stopReason, error, finishedAt: now()});
    emit();
    tm.counter('tsp_labeling_tasks_ended_total', {task_purpose: purpose, state, reason: stopReason ?? 'none'});
    if (state === 'needs_attention') tm.event('run_needs_attention', {task_purpose: purpose, failed: counts.failed, total: task.total});
    tm.histogram('tsp_labeling_task_duration_seconds', (Date.now() - runStarted) / 1000, {task_purpose: purpose});
    if (state === 'done' && task.budgetUsd) tm.histogram('tsp_labeling_cost_vs_estimate_ratio', counts.costUsd / task.budgetUsd, {task_purpose: purpose});
    const pressed = stopPressed.get(taskId);
    if (state === 'stopped' && pressed) tm.histogram('tsp_labeling_stop_latency_seconds', (Date.now() - pressed) / 1000, {task_purpose: purpose});
    stopPressed.delete(taskId);
    return getTask(taskId);
  }

  return {
    async createTask(input: CreateTaskInput): Promise<LabelingTask> {
      const task: LabelingTask = {
        id: newId('lt'),
        projectId: input.projectId,
        purpose: input.purpose,
        promptVersionId: input.promptVersionId,
        setupVersionId: input.setupVersionId,
        endpoint: input.endpoint,
        settings: input.settings,
        settingsHash: settingsHash(input.settings),
        exampleIds: input.exampleIds,
        total: input.exampleIds.length,
        done: 0,
        valid: 0,
        invalid: 0,
        failed: 0,
        failedExampleIds: [],
        costUsd: 0,
        budgetUsd: input.budgetUsd ?? null,
        parallel: input.parallel ?? DEFAULT_PARALLEL,
        ...(input.relabelInvalid ? {relabelInvalid: true} : {}),
        state: 'queued',
        stopReason: null,
        stopRequested: false,
        error: null,
        createdAt: now(),
        createdBy: input.createdBy,
        startedAt: null,
        finishedAt: null,
      };
      await repo.insert(TASKS, task);
      emit();
      return task;
    },

    runTask: run,

    async stopTask(taskId: string) {
      stopPressed.set(taskId, Date.now());
      active.get(taskId)?.abort();
      if (!active.has(taskId)) await repo.patch<LabelingTask>(TASKS, taskId, {stopRequested: true});
      emit();
    },

    async retryFailed(taskId: string, trigger?: 'system' | 'user', opts: RunOptions = {}) {
      await repo.patch<LabelingTask>(TASKS, taskId, {failedExampleIds: [], failed: 0, state: 'queued', error: null, stopReason: null});
      emit();
      return run(taskId, trigger, opts);
    },

    getTask,

    /**
     * A task stored as running that no tab runs any more was left by a closed page: it shows as
     * paused, and running it again resumes from the predictions already saved.
     */
    async listTasks(projectId: string) {
      const tasks = await repo.find<LabelingTask>(TASKS, {projectId}, 'createdAt desc');
      let changed = false;
      for (const t of tasks) {
        if (t.state !== 'running' || (await isRunning(t.id))) continue;
        t.state = 'paused';
        t.stopReason = 'closed';
        await repo.patch<LabelingTask>(TASKS, t.id, {state: 'paused', stopReason: 'closed'});
        changed = true;
      }
      if (changed) emit();
      return tasks;
    },

    isRunning,
    predictions,

    async tryTemplate(input) {
      const out: TryTemplateRow[] = [];
      await Promise.all(
        input.examples.map(async ex => {
          try {
            const parts = renderPrompt(input.template, ex, input.features, input.images);
            const res = await deps.gateway.label({
              slot: input.settings.endpoint,
              messages: toMessages(parts, deps.resolveUrl),
              maxOutputTokens: input.settings.maxOutputTokens,
              temperature: input.settings.temperature,
              traceId: ex.externalId,
              signal: input.signal,
            });
            const parsed = parseOutput(res.text, input.schema);
            out.push({exampleId: ex.id, answer: parsed.answer, invalidReason: parsed.reason, costUsd: res.costUsd, error: null});
          } catch (e) {
            out.push({exampleId: ex.id, answer: null, invalidReason: null, costUsd: 0, error: (e as Error).message ?? String(e)});
          }
        }),
      );
      const order = new Map(input.examples.map((e, i) => [e.id, i]));
      return out.sort((a, b) => order.get(a.exampleId)! - order.get(b.exampleId)!);
    },
  };
}

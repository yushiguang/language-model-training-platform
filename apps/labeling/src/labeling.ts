import {
  DocFieldValue,
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
  type TaskState,
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

/** One prediction per prompt version + model + settings + example. */
export const predictionId = (promptVersionId: string, endpoint: EndpointId, hash: string, exampleId: string) => `pd_${hashString(`${promptVersionId}|${endpoint}|${hash}|${exampleId}`)}`;

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

  const getTask = (id: string) => repo.get<LabelingTask>(TASKS, id);

  async function predictions(promptVersionId: string, endpoint: EndpointId, hash: string): Promise<Map<string, Prediction>> {
    const rows = await repo.find<Prediction>(PREDICTIONS, {promptVersionId, endpoint, settingsHash: hash}, 'createdAt');
    const out = new Map<string, Prediction>();
    for (const p of rows) if (!out.has(p.exampleId)) out.set(p.exampleId, p);
    return out;
  }

  async function isRunning(taskId: string) {
    return active.has(taskId) || (await locks.isHeld(lockName(taskId)));
  }

  async function execute(taskId: string): Promise<LabelingTask | null> {
    const task = await getTask(taskId);
    if (!task || FINISHED.includes(task.state)) return task;
    const [version, setup] = await Promise.all([deps.catalog.get('prompt_versions', task.promptVersionId), deps.catalog.get('setup_versions', task.setupVersionId)]);
    if (!version || !setup?.schema) {
      await repo.patch<LabelingTask>(TASKS, taskId, {state: 'failed', error: 'The prompt version or schema of this task no longer exists.', finishedAt: now()});
      emit();
      return getTask(taskId);
    }
    const schema = setup.schema;

    // Counters are rebuilt from saved predictions, so a crash never leaves them wrong.
    const saved = await predictions(task.promptVersionId, task.endpoint, task.settingsHash);
    const mine = task.exampleIds.filter(id => saved.has(id)).map(id => saved.get(id)!);
    const failedSet = new Set(task.failedExampleIds);
    const pending = task.exampleIds.filter(id => !saved.has(id) && !failedSet.has(id));
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
    let stopReason: LabelingTask['stopReason'] = null;
    let inARow = 0;
    let lastError: string | null = null;
    let lastStopCheck = Date.now();
    let next = 0;

    const checkStop = async () => {
      if (Date.now() - lastStopCheck < STOP_CHECK_MS) return;
      lastStopCheck = Date.now();
      const fresh = await getTask(taskId);
      if (fresh?.stopRequested) ctrl.abort();
    };

    const worker = async () => {
      while (next < pending.length && !stopReason && !ctrl.signal.aborted) {
        const exampleId = pending[next++];
        const ex = examples.get(exampleId);
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
            id: predictionId(task.promptVersionId, task.endpoint, task.settingsHash, exampleId),
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
          });
          counts.done++;
          counts.costUsd += res.costUsd;
          inARow = 0;
        } catch (e) {
          if (errorKindOf(e) === 'aborted') break;
          inARow++;
          counts.failed++;
          lastError = (e as Error).message ?? String(e);
          await repo.patch<LabelingTask>(TASKS, taskId, {failed: DocFieldValue.increment(1), failedExampleIds: DocFieldValue.arrayUnion(exampleId), error: lastError});
          if (counts.failed / task.total > MAX_FAILED_SHARE || inARow >= MAX_FAILED_IN_A_ROW) stopReason = 'failures';
        }
        if (task.budgetUsd != null && counts.costUsd > task.budgetUsd * BUDGET_MARGIN) stopReason = 'budget';
        emit();
        await checkStop();
      }
    };

    try {
      await Promise.all(Array.from({length: Math.max(1, task.parallel)}, worker));
    } finally {
      active.delete(taskId);
    }

    let state: TaskState;
    let error: string | null = lastError;
    if (ctrl.signal.aborted) {
      state = 'stopped';
      stopReason = 'user';
      error = null;
    } else if (stopReason === 'budget') {
      state = 'paused';
      error = `Paused: the cost passed ${Math.round(BUDGET_MARGIN * 100)}% of the approved estimate.`;
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

    runTask: taskId => locks.run(lockName(taskId), () => execute(taskId)),

    async stopTask(taskId: string) {
      active.get(taskId)?.abort();
      if (!active.has(taskId)) await repo.patch<LabelingTask>(TASKS, taskId, {stopRequested: true});
      emit();
    },

    async retryFailed(taskId: string) {
      await repo.patch<LabelingTask>(TASKS, taskId, {failedExampleIds: [], failed: 0, state: 'queued', error: null, stopReason: null});
      emit();
      return locks.run(lockName(taskId), () => execute(taskId));
    },

    getTask,

    /**
     * A task stored as running that no tab runs any more was left by a closed page: it shows as
     * paused, and running it again resumes from the predictions already saved.
     */
    async listTasks(projectId: string) {
      const tasks = await repo.find<LabelingTask>(TASKS, {projectId}, 'createdAt desc');
      for (const t of tasks) {
        if (t.state !== 'running' || (await isRunning(t.id))) continue;
        t.state = 'paused';
        t.stopReason = 'closed';
        await repo.patch<LabelingTask>(TASKS, t.id, {state: 'paused', stopReason: 'closed'});
      }
      return tasks;
    },

    isRunning,
    predictions,
  };
}

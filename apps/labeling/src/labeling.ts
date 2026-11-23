import {
  DocFieldValue,
  NO_TELEMETRY,
  errorKindOf,
  type CatalogContract,
  type ContentPart,
  type CreateTaskInput,
  type DocRuntime,
  type EndpointId,
  type ExampleWithFeatures,
  type LabelingContract,
  type LabelingTask,
  type LlmGatewayContract,
  type ModelMessage,
  type Prediction,
  type RunOptions,
  type TaskState,
  type TelemetryPort,
  type TryTemplateRow,
} from '@yushiguang/sprint-contracts';
import {asAnswerOrNull, hashString, parseOutput, REASON_LINE, renderPrompt, settingsHash, type Part, systemConfig} from '@yushiguang/sprint-domain';
import {DocRepo, newId} from '@yushiguang/sprint-platform';
import {browserLocks, type TaskLocks} from './locks.ts';

export interface LabelingDeps {
  db: DocRuntime;
  catalog: CatalogContract;
  gateway: LlmGatewayContract;
  locks?: TaskLocks;
  /**
   * Turns a stored image URL into one the model can fetch: a relative URL made absolute, or a
   * signed URL made for this call (which may take a request, so it may return a Promise).
   */
  resolveUrl?: (url: string) => string | Promise<string>;
  /**
   * Whether work that this process cannot see through its locks is live for this task — in a
   * server composition, a queued or running job for it (the composition root answers from the job
   * module, whose lease the worker holds; issue #46). `listTasks` asks only for a task stored as
   * running whose lock nobody reachable holds (a candidate orphan): true keeps it `running`,
   * because a reader in another process must never falsify a live run as paused; left out, only
   * the locks decide, as in the browser.
   */
  liveElsewhere?: (task: LabelingTask) => Promise<boolean>;
  /** Called after every write, with the project written to when known, so open pages refresh. */
  onChange?: (projectId?: string) => void;
  telemetry?: TelemetryPort;
}


const TASKS = 'labeling_tasks';
const PREDICTIONS = 'predictions';
const now = () => new Date().toISOString();
const lockName = (taskId: string) => `labeling:${taskId}`;
const FINISHED: TaskState[] = ['done'];

/**
 * The task's examples with their frozen features (#32), read by id a batch at a time as the
 * workers reach them, so a run over many examples never holds all their features at once. A
 * batch two behind the one being read is let go; an example asked for again (a busy lock puts it
 * back in line) reads its batch again. Null: the example or its features are gone.
 */
function exampleReader(catalog: CatalogContract, ids: string[]): (id: string) => Promise<ExampleWithFeatures | null> {
  const size = Math.max(1, systemConfig().dataset.featureBatch);
  const batchOf = new Map(ids.map((id, i) => [id, Math.floor(i / size)]));
  const batches = new Map<number, Promise<Map<string, ExampleWithFeatures>>>();
  const read = async (b: number) => {
    const examples = await catalog.findByIds('examples', ids.slice(b * size, (b + 1) * size));
    const features = await catalog.exampleFeatures(examples);
    return new Map(examples.filter(e => features[e.id]).map(e => [e.id, {...e, features: features[e.id]}] as [string, ExampleWithFeatures]));
  };
  // Every worker on a batch waits on the same read: a passing storage error is tried twice more
  // before it fails them, so one blip never fails a whole batch of workers at once.
  const load = async (b: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(b);
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
      }
    }
  };
  return async id => {
    const b = batchOf.get(id);
    if (b == null) return null;
    let batch = batches.get(b);
    if (!batch) {
      batch = load(b);
      // A failed read is tried again by the next example of the batch.
      batch.catch(() => batches.delete(b));
      batches.set(b, batch);
      for (const k of batches.keys()) if (k < b - 2) batches.delete(k);
    }
    return (await batch).get(id) ?? null;
  };
}

/** A run's options, plus Retry failed (clears the failed examples once the lock is held). */
type ExecOptions = RunOptions & {retry?: boolean};

/** The site's own last line of every labeling prompt: asks the model for its short reason. */
const withReason = (parts: Part[]): Part[] => [...parts, {type: 'text', text: `\n\n${REASON_LINE}`}];

/** The prompt as the model's message; each image URL is resolved for this call, all at once. */
export async function toMessages(parts: Part[], resolveUrl: (u: string) => string | Promise<string> = u => u): Promise<ModelMessage[]> {
  const content: ContentPart[] = await Promise.all(parts.map(async (p): Promise<ContentPart> => (p.type === 'text' ? {type: 'text', text: p.text} : {type: 'image', url: await resolveUrl(p.url)})));
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
  const emit = (projectId?: string) => deps.onChange?.(projectId);
  const active = new Map<string, AbortController>();
  /** The runs going on in this process, by task: deleting a project waits for them to end. */
  const runs = new Map<string, Set<Promise<unknown>>>();
  /** Projects being deleted in this process: a run of theirs that is just starting stops at once. */
  const deleting = new Set<string>();
  const tm = deps.telemetry ?? NO_TELEMETRY;
  const running = new Map<string, number>();
  const stopPressed = new Map<string, number>();
  const setRunning = (purpose: string, d: number) => {
    running.set(purpose, (running.get(purpose) ?? 0) + d);
    tm.gauge('sprint_labeling_tasks_running', running.get(purpose)!, {task_purpose: purpose});
  };
  const defaultTrigger = (t: LabelingTask) => (t.purpose === 'eval' || t.purpose === 'optimiser' ? 'system' : 'user');

  /** Runs a task under its lock; a second tab asking for the same task gets null. */
  async function run(taskId: string, trigger?: 'system' | 'user', opts: ExecOptions = {}) {
    const going = locks.run(lockName(taskId), () => execute(taskId, trigger, opts));
    const tracked = going.catch(() => undefined);
    const mine = runs.get(taskId) ?? new Set();
    runs.set(taskId, mine.add(tracked));
    const r = await going.finally(() => {
      mine.delete(tracked);
      if (!mine.size && runs.get(taskId) === mine) runs.delete(taskId);
    });
    if (r === null) {
      const t = await getTask(taskId);
      if (t) tm.counter('sprint_labeling_lock_conflicts_total', {task_purpose: t.purpose});
    }
    return r;
  }

  const getTask = (id: string) => repo.get<LabelingTask>(TASKS, id);

  /** Every saved prediction per example, oldest first. */
  async function allPredictions(promptVersionId: string, endpoint: EndpointId, hash: string): Promise<Map<string, Prediction[]>> {
    const rows = await repo.find<Prediction>(PREDICTIONS, {promptVersionId, endpoint, settingsHash: hash}, 'createdAt');
    const out = new Map<string, Prediction[]>();
    // Answers stored as a plain string earlier on 2026-11-16 read as a one-item list.
    for (const p0 of rows) {
      const p = {...p0, answer: asAnswerOrNull(p0.answer)};
      out.set(p.exampleId, [...(out.get(p.exampleId) ?? []), p]);
    }
    return out;
  }

  async function predictions(promptVersionId: string, endpoint: EndpointId, hash: string): Promise<Record<string, Prediction>> {
    const out: Record<string, Prediction> = {};
    for (const [id, ps] of await allPredictions(promptVersionId, endpoint, hash)) out[id] = ps.find(p => p.answer) ?? ps[0];
    return out;
  }

  /** States a task has not ended in: a Stop still applies. */
  const OPEN: readonly LabelingTask['state'][] = ['queued', 'paused', 'running'];

  /**
   * A Stop for a task no runner in this process is labeling. Under the task's lock, so no
   * runner that shares the locks starts (or finishes) meanwhile: a task no runner holds anywhere
   * (waiting in the queue, paused, or left running by a runner `liveElsewhere` says is gone)
   * ends as stopped by the user, or the next check would start it again. A running record
   * counts as left behind only when `liveElsewhere` can say so: without it, a runner this
   * process's locks cannot see may still hold it. Otherwise (the lock is held, or a runner
   * elsewhere has it, starting or running) the request is saved and its runner sees it. A task
   * that has ended is left as it is. Returns the task as last read.
   */
  async function stopIfIdle(taskId: string, save = true): Promise<LabelingTask | null> {
    const request = async (t: LabelingTask | null) => {
      if (save && t && !FINISHED.includes(t.state)) await repo.patch<LabelingTask>(TASKS, taskId, {stopRequested: true, stopRequestedAt: now()});
      return t;
    };
    const held = await locks.run(lockName(taskId), async () => {
      const t = await getTask(taskId);
      if (!t || FINISHED.includes(t.state)) return {t};
      // A stopped or failed task may be starting again (Resume, Retry failed): its job is live
      // elsewhere while the record still shows the old state, so it is asked about too.
      const elsewhere = deps.liveElsewhere ? await deps.liveElsewhere(t).catch(() => true) : false;
      // Read again after asking: the runner elsewhere may have ended it meanwhile.
      const latest = await getTask(taskId);
      if (!latest || FINISHED.includes(latest.state)) return {t: latest};
      // A read only ends what an earlier Stop left: never a new request, nor one on work since begun.
      if (!save && (elsewhere || !latest.stopRequested)) return {t: latest};
      if (!elsewhere && !OPEN.includes(latest.state)) {
        // Ended and idle: nothing to stop, and no request may wait for a later run.
        if (latest.stopRequested) await repo.patch<LabelingTask>(TASKS, taskId, {stopRequested: false});
        return {t: await getTask(taskId)};
      }
      if (!elsewhere && (latest.state !== 'running' || !!deps.liveElsewhere)) {
        await repo.patch<LabelingTask>(TASKS, taskId, {state: 'stopped', stopReason: 'user', stopRequested: false, finishedAt: now()});
        return {t: latest};
      }
      return {t: await request(latest)};
    });
    return held ? held.t : request(await getTask(taskId));
  }

  async function isRunning(taskId: string) {
    return active.has(taskId) || (await locks.isHeld(lockName(taskId)));
  }

  async function execute(taskId: string, trigger: 'system' | 'user' | undefined, opts: ExecOptions): Promise<LabelingTask | null> {
    // Taken before the first read: a Stop saved before that read is seen by the check below, one
    // saved after it is newer than this moment, so the stop timer sees it.
    const runStartedIso = now();
    // Retry failed clears the failed examples here, under the lock: a second tab asking while
    // this task runs gets null and changes nothing.
    let found = await getTask(taskId);
    if (found && opts.retry && !FINISHED.includes(found.state)) {
      await repo.patch<LabelingTask>(TASKS, taskId, {failedExampleIds: [], failed: 0, state: 'queued', error: null, stopReason: null});
      found = await getTask(taskId);
    }
    if (!found || FINISHED.includes(found.state)) return found;
    // A Stop saved while this run was starting (no runner held the task yet): ended here, before
    // any model call. Every end clears the request, so one still set is never an old one.
    if (found.stopRequested) {
      await repo.patch<LabelingTask>(TASKS, taskId, {state: 'stopped', stopReason: 'user', stopRequested: false, finishedAt: now()});
      stopPressed.delete(taskId);
      emit(found.projectId);
      return getTask(taskId);
    }
    const task = found;
    const purpose = task.purpose;
    const how = trigger ?? defaultTrigger(task);
    tm.counter('sprint_labeling_tasks_started_total', {task_purpose: purpose, trigger: how});
    if (task.startedAt) tm.counter('sprint_labeling_resumes_total', {task_purpose: purpose, trigger: how});
    const runStarted = Date.now();
    const [version, setup] = await Promise.all([deps.catalog.get('prompt_versions', task.promptVersionId), deps.catalog.get('setup_versions', task.setupVersionId)]);
    if (!version || !setup?.schema) {
      await repo.patch<LabelingTask>(TASKS, taskId, {state: 'failed', error: 'The prompt version or schema of this task no longer exists.', finishedAt: now()});
      emit(task.projectId);
      return getTask(taskId);
    }
    const schema = setup.schema;

    // Counters are rebuilt from saved predictions, so a crash never leaves them wrong.
    const all = await allPredictions(task.promptVersionId, task.endpoint, task.settingsHash);
    const best = (id: string) => all.get(id)?.find(p => p.answer) ?? all.get(id)?.[0];
    // Under relabelInvalid, an example whose only answer is invalid when the task first starts is
    // labeled once more. The first run records which ones, so an answer this task saves itself
    // (before a pause) is its result on a later run, like any other. No clocks are compared.
    const onlyInvalid = (id: string) => {
      const ps = all.get(id);
      return ps?.length === 1 && !ps[0].answer;
    };
    const relabelIds = task.relabelInvalid ? (task.startedAt ? (task.relabelExampleIds ?? []) : task.exampleIds.filter(onlyInvalid)) : [];
    const relabelSet = new Set(relabelIds);
    const again = (id: string) => relabelSet.has(id) && onlyInvalid(id);
    const mine = task.exampleIds.filter(id => best(id) && !again(id)).map(id => best(id)!);
    // An example another run saved since it failed here is done, not failed.
    const failedSet = new Set(task.failedExampleIds.filter(id => !mine.some(p => p.exampleId === id)));
    const pending = task.exampleIds.filter(id => (!all.has(id) || again(id)) && !failedSet.has(id));
    const counts = {
      done: mine.length,
      valid: mine.filter(p => p.answer).length,
      invalid: mine.filter(p => !p.answer).length,
      filtered: mine.filter(p => p.filtered).length,
      failed: failedSet.size,
      costUsd: mine.reduce((n, p) => n + p.costUsd, 0),
      tokens: mine.reduce((n, p) => n + (p.tokens ?? 0), 0),
    };
    await repo.patch<LabelingTask>(TASKS, taskId, {...counts, failedExampleIds: [...failedSet], ...(task.relabelInvalid ? {relabelExampleIds: relabelIds} : {}), state: 'running', stopReason: null, error: null, startedAt: task.startedAt ?? now(), finishedAt: null});
    emit(task.projectId);

    const examples = exampleReader(deps.catalog, pending);
    const ctrl = new AbortController();
    active.set(taskId, ctrl);
    if (deleting.has(task.projectId)) ctrl.abort();
    // The run's model calls share one request id; a Stop cancels them at the gateway by id.
    const runId = newId('lr');
    ctrl.signal.addEventListener('abort', () => void Promise.resolve().then(() => deps.gateway.cancel(runId)).catch(() => undefined), {once: true});
    setRunning(purpose, 1);
    let stopReason: LabelingTask['stopReason'] = null;
    let inARow = 0;
    let lastError: string | null = null;
    let next = 0;
    // Checked before every example, so a resumed task that is already over a limit makes no call.
    const overLimit = (): LabelingTask['stopReason'] => {
      if (counts.failed / task.total > systemConfig().labeling.maxFailedShare || inARow >= systemConfig().labeling.maxFailedInARow) return 'failures';
      return null;
    };

    // A Stop from another tab: read on a timer, so it is seen even while calls wait in the
    // limiter, in retry sleeps or in a long model call (the abort cancels them).
    const checkStop = () =>
      getTask(taskId).then(fresh => {
        if (fresh?.stopRequested && (fresh.stopRequestedAt ?? '') >= runStartedIso) {
          if (!stopPressed.has(taskId)) stopPressed.set(taskId, Date.parse(fresh.stopRequestedAt!));
          ctrl.abort();
        }
      });
    const stopTimer = setInterval(() => void checkStop(), systemConfig().labeling.stopCheckMs);
    (stopTimer as {unref?: () => void}).unref?.();

    /**
     * Labels one example under a lock on its prediction, so two tasks for the same version,
     * model and settings never pay for the same example: the second one waits and then reuses
     * the saved answer. That holds wherever the locks reach — every tab in the browser, every
     * process when the composition wires `leaseLocks` over a shared lock store (issue #46).
     * Returns false when the lock is busy (try again later).
     */
    const labelOne = async (exampleId: string, example: () => Promise<ExampleWithFeatures | null>): Promise<boolean> => {
      const id = predictionId(task.promptVersionId, task.endpoint, task.settingsHash, exampleId, again(exampleId) ? 2 : 1);
      /**
       * Saves a prediction, re-reading first: another runner whose locks this one cannot see
       * (or a lock lease lost mid-call) may have saved the same deterministic prediction while
       * this call was in flight, and then its answer is the saved one and nothing is stored
       * twice. Honestly: this does not un-pay the call just made — keeping two runners from
       * paying at all is the prediction lock's job, above; this only keeps the store to one
       * document and the counters to one answer when that lock did not reach.
       */
      const savePrediction = async (pred: Prediction): Promise<{pred: Prediction; paid: boolean}> => {
        const meanwhile = await repo.get<Prediction>(PREDICTIONS, pred.id);
        if (meanwhile) return {pred: meanwhile, paid: false};
        await repo.insert(PREDICTIONS, pred);
        return {pred, paid: true};
      };
      const r = await locks.run(`labeling:prediction:${id}`, async () => {
        const saved = await repo.get<Prediction>(PREDICTIONS, id);
        if (saved) return {pred: saved, paid: false};
        // Read only now: a saved answer needs no features, so a batch let go is not read again.
        const ex = await example();
        if (!ex) throw new Error('The example or its features could not be found.');
        const parts = withReason(renderPrompt(version.template, ex, version.features, version.images));
        const res = await deps.gateway
          .label({
            tenantId: task.tenantId ?? 'default',
            slot: task.endpoint,
            messages: await toMessages(parts, deps.resolveUrl),
            maxOutputTokens: task.settings.maxOutputTokens,
            temperature: task.settings.temperature,
            traceId: ex.externalId,
            requestId: runId,
          })
          .catch(e => {
            // The safety filter's answer is final: saved as a filtered example, not a failure.
            if (errorKindOf(e) === 'filtered') return null;
            throw e;
          });
        if (!res) {
          const pred: Prediction = {id, projectId: task.projectId, promptVersionId: task.promptVersionId, endpoint: task.endpoint, settingsHash: task.settingsHash, exampleId, output: '', answer: null, invalidReason: 'Stopped by the safety filter', filtered: true, costUsd: 0, tokens: 0, createdAt: now()};
          return savePrediction(pred);
        }
        const parsed = parseOutput(res.text, schema);
        const pred: Prediction = {
          id,
          projectId: task.projectId,
          promptVersionId: task.promptVersionId,
          endpoint: task.endpoint,
          settingsHash: task.settingsHash,
          exampleId,
          output: res.text,
          answer: parsed.answer,
          invalidReason: parsed.reason,
          ...(parsed.note ? {reason: parsed.note} : {}),
          costUsd: res.costUsd,
          tokens: res.inputTokens + res.outputTokens + (res.reasoningTokens ?? 0),
          createdAt: now(),
        };
        return savePrediction(pred);
      });
      if (!r) return false;
      const {pred, paid} = r;
      // Prediction first, counters after: a crash in between undercounts, and the next run recounts.
      await repo.patch<LabelingTask>(TASKS, taskId, {
        done: DocFieldValue.increment(1),
        [pred.answer ? 'valid' : 'invalid']: DocFieldValue.increment(1),
        ...(pred.filtered ? {filtered: DocFieldValue.increment(1)} : {}),
        costUsd: DocFieldValue.increment(pred.costUsd),
        tokens: DocFieldValue.increment(pred.tokens ?? 0),
        ...(opts.auto && paid ? {autoCostUsd: DocFieldValue.increment(pred.costUsd)} : {}),
      });
      counts.done++;
      counts.costUsd += pred.costUsd;
      tm.counter('sprint_labeling_examples_total', {task_purpose: purpose, result: pred.answer ? 'valid' : pred.filtered ? 'filtered' : 'invalid'});
      if (paid) tm.counter('sprint_labeling_cost_usd_total', {task_purpose: purpose}, pred.costUsd);
      return true;
    };

    const worker = async () => {
      while (next < pending.length && !stopReason && !ctrl.signal.aborted) {
        stopReason = overLimit();
        if (stopReason) break;
        const exampleId = pending[next++];
        const exStarted = Date.now();
        try {
          if (!(await labelOne(exampleId, () => examples(exampleId)))) {
            // Another task in this browser is labeling the same example: come back to it.
            pending.push(exampleId);
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
          inARow = 0;
          tm.histogram('sprint_labeling_example_duration_seconds', (Date.now() - exStarted) / 1000, {task_purpose: purpose});
        } catch (e) {
          if (errorKindOf(e) === 'aborted') break;
          tm.counter('sprint_labeling_examples_total', {task_purpose: purpose, result: 'failed'});
          inARow++;
          counts.failed++;
          lastError = (e as Error).message ?? String(e);
          await repo.patch<LabelingTask>(TASKS, taskId, {failed: DocFieldValue.increment(1), failedExampleIds: DocFieldValue.arrayUnion(exampleId), error: lastError});
        }
        stopReason = overLimit();
        emit(task.projectId);
      }
    };

    try {
      // A Stop saved while this run was preparing (before `active` held it): seen before any call.
      await checkStop();
      await Promise.all(Array.from({length: Math.max(1, task.parallel)}, worker));
    } finally {
      clearInterval(stopTimer);
      active.delete(taskId);
      setRunning(purpose, -1);
    }

    let state: TaskState;
    let error: string | null = lastError;
    if (ctrl.signal.aborted) {
      state = 'stopped';
      stopReason = 'user';
      error = null;
    } else if (stopReason === 'failures' || counts.failed > 0) {
      state = 'needs_attention';
      stopReason = 'failures';
      error = `${counts.failed} example${counts.failed === 1 ? '' : 's'} failed. ${lastError ? `Last error: ${lastError}. ` : ''}Retry failed to label them again.`;
    } else {
      state = 'done';
      error = null;
    }
    await repo.patch<LabelingTask>(TASKS, taskId, {state, stopReason, error, stopRequested: false, finishedAt: now()});
    emit(task.projectId);
    tm.counter('sprint_labeling_tasks_ended_total', {task_purpose: purpose, state, reason: stopReason ?? 'none'});
    if (state === 'needs_attention') tm.event('run_needs_attention', {task_purpose: purpose, failed: counts.failed, total: task.total});
    tm.histogram('sprint_labeling_task_duration_seconds', (Date.now() - runStarted) / 1000, {task_purpose: purpose});
    const pressed = stopPressed.get(taskId);
    if (state === 'stopped' && pressed) tm.histogram('sprint_labeling_stop_latency_seconds', (Date.now() - pressed) / 1000, {task_purpose: purpose});
    stopPressed.delete(taskId);
    return getTask(taskId);
  }

  return {
    async createTask(input: CreateTaskInput): Promise<LabelingTask> {
      const task: LabelingTask = {
        id: newId('lt'),
        projectId: input.projectId,
        tenantId: input.tenantId,
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
        filtered: 0,
        failed: 0,
        failedExampleIds: [],
        costUsd: 0,
        tokens: 0,
        parallel: input.parallel ?? systemConfig().labeling.defaultParallel,
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
      emit(task.projectId);
      return task;
    },

    runTask: run,

    async stopTask(taskId: string) {
      stopPressed.set(taskId, Date.now());
      active.get(taskId)?.abort();
      if (active.has(taskId)) return emit();
      const t = await stopIfIdle(taskId);
      if (t) emit(t.projectId);
      else emit();
    },

    retryFailed: (taskId: string, trigger?: 'system' | 'user', opts: RunOptions = {}) => run(taskId, trigger, {...opts, retry: true}),

    getTask,

    /**
     * A task stored as running that no runner holds any more — through the locks every process
     * shares, and through `liveElsewhere` where jobs run it — was left by a closed page or a dead
     * worker: it shows as paused, and running it again resumes from the predictions already saved.
     */
    async listTasks(projectId: string) {
      const tasks = await repo.find<LabelingTask>(TASKS, {projectId}, 'createdAt desc');
      let changed = false;
      for (const t of tasks) {
        // A Stop asked while its runner was starting, whose runner then went away: ended now.
        if (t.state !== 'running' && !FINISHED.includes(t.state) && t.stopRequested && !(await isRunning(t.id))) {
          const before = t.state;
          Object.assign(t, (await stopIfIdle(t.id, false)) ?? {});
          const after = await getTask(t.id);
          if (after) Object.assign(t, after);
          if (t.state !== before) changed = true;
          continue;
        }
        if (t.state !== 'running' || (await isRunning(t.id))) continue;
        // The runner may have finished between the read above and the lock check: read again,
        // so a task that just ended is never marked as left behind.
        const fresh = await getTask(t.id);
        if (fresh && fresh.state !== 'running') {
          Object.assign(t, fresh);
          continue;
        }
        // Nor when live work for it exists that this process's locks cannot see (a queued or
        // running job in another unit): only a task with no runner anywhere is left behind.
        if (fresh && deps.liveElsewhere) {
          // A predicate that cannot answer (a job-store blip) proves nothing: do not reap on
          // this read, and the read itself still succeeds.
          const live = await deps.liveElsewhere(fresh).catch(() => true);
          if (live) continue;
          // The predicate was awaited after the re-read above, so the runner may have finished
          // meanwhile: read once more, and a task that is no longer running is never patched over.
          const after = await getTask(t.id);
          if (!after) continue;
          if (after.state !== 'running') {
            Object.assign(t, after);
            continue;
          }
        }
        // A Stop asked while no runner held it ends it; otherwise it shows as paused. The latest
        // read says whether one was asked.
        const latest = await getTask(t.id);
        if (!latest || latest.state !== 'running') {
          if (latest) Object.assign(t, latest);
          continue;
        }
        const end = latest.stopRequested ? {state: 'stopped' as const, stopReason: 'user' as const, stopRequested: false, finishedAt: now()} : {state: 'paused' as const, stopReason: 'closed' as const};
        Object.assign(t, end);
        await repo.patch<LabelingTask>(TASKS, t.id, end);
        changed = true;
      }
      if (changed) emit(projectId);
      return tasks;
    },

    isRunning,
    predictions,

    async tryTemplate(input) {
      const out: TryTemplateRow[] = [];
      await Promise.all(
        input.examples.map(async ex => {
          try {
            const parts = withReason(renderPrompt(input.template, ex, input.features, input.images));
            const res = await deps.gateway.label({
              tenantId: input.tenantId,
              slot: input.settings.endpoint,
              messages: await toMessages(parts, deps.resolveUrl),
              maxOutputTokens: input.settings.maxOutputTokens,
              temperature: input.settings.temperature,
              traceId: ex.externalId,
              ...(input.requestId ? {requestId: input.requestId} : {}),
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

    cancel: requestId => deps.gateway.cancel(requestId),

    /**
     * Deleting a project: its running tasks stop, and their runs in this process end before
     * anything is deleted, so no answer is saved after the delete. Then its tasks and their saved
     * answers go. Answers carry their project, so a run elsewhere that saved one late is removed
     * by deleting again.
     */
    async deleteProject(projectId: string) {
      deleting.add(projectId);
      try {
        await removeProject(projectId);
      } finally {
        deleting.delete(projectId);
      }
      emit(projectId);
    },
  };

  /** Stops the project's runs in this process, waits for them to end, then deletes its records. */
  async function removeProject(projectId: string) {
    const tasks = await repo.find<LabelingTask>(TASKS, {projectId});
    for (const t of tasks) active.get(t.id)?.abort();
    await Promise.all(tasks.flatMap(t => [...(runs.get(t.id) ?? [])]));
    await repo.deleteWhere(PREDICTIONS, {projectId});
    // Answers saved before they carried their project: one batched delete per version, model
    // and settings (deployment readiness spec, 3).
    const seen = new Set<string>();
    for (const t of tasks) {
      const key = `${t.promptVersionId}|${t.endpoint}|${t.settingsHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await repo.deleteWhere(PREDICTIONS, {promptVersionId: t.promptVersionId, endpoint: t.endpoint, settingsHash: t.settingsHash});
    }
    await repo.deleteWhere(TASKS, {projectId});
  }
}

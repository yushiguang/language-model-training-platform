import {DocFieldValue, type DocRuntime, type EndpointId, type LabelingStorePort, type LabelingTask, type ObjectStorePort, type Prediction, type PredictionScope} from '@yushiguang/sprint-contracts';
import {DocRepo, newId} from '@yushiguang/sprint-platform';

const TASKS = 'labeling_tasks';
const PREDICTIONS = 'predictions';
const SEGMENTS = 'prediction_segments';

/** Tasks and answers as documents (the browser build, and deployments without object storage). */
export function docLabelingStore(db: DocRuntime): LabelingStorePort {
  const repo = new DocRepo(db);
  return {
    getTask: id => repo.get<LabelingTask>(TASKS, id),
    findTasks: projectId => repo.find<LabelingTask>(TASKS, {projectId}, 'createdAt desc'),
    async insertTask(task) {
      await repo.insert(TASKS, task);
    },
    patchTask: (id, patch) => repo.patch<LabelingTask>(TASKS, id, patch),
    async addToTask(id, tally, opts = {}) {
      const patch: Record<string, unknown> = {...opts.set};
      for (const [k, n] of Object.entries(tally)) if (n) patch[k] = DocFieldValue.increment(n);
      if (opts.failedExampleId) patch.failedExampleIds = DocFieldValue.arrayUnion(opts.failedExampleId);
      if (Object.keys(patch).length) await repo.patch(TASKS, id, patch);
    },
    getPrediction: id => repo.get<Prediction>(PREDICTIONS, id),
    async savePredictions(predictions) {
      const out: {prediction: Prediction; saved: boolean}[] = [];
      for (const p of predictions) {
        const there = await repo.get<Prediction>(PREDICTIONS, p.id);
        if (there) out.push({prediction: there, saved: false});
        else {
          await repo.insert(PREDICTIONS, p);
          out.push({prediction: p, saved: true});
        }
      }
      return out;
    },
    predictionsFor: (promptVersionId, endpoint, settingsHash) => repo.find<Prediction>(PREDICTIONS, {promptVersionId, endpoint, settingsHash}, 'createdAt'),
    async deletePredictions(where) {
      await repo.deleteWhere(PREDICTIONS, where);
    },
    async deleteTasks(projectId) {
      await repo.deleteWhere(TASKS, {projectId});
    },
  };
}

/** The pointer to one segment file of answers (docs/design/server.md 6). */
interface PredictionSegment {
  id: string;
  projectId: string;
  promptVersionId: string;
  endpoint: EndpointId;
  settingsHash: string;
  /** The segment file's object key. */
  key: string;
  /** The answers in it, by prediction id. */
  predictionIds: string[];
  createdAt: string;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Tasks as documents; answers in object storage (docs/design/server.md 6). Each batch passed to
 * `savePredictions` is one segment file, `answers/<projectId>/<promptVersionId>/<segment>.jsonl`,
 * one answer per line, and one pointer record (`prediction_segments`) with the version, model,
 * settings and the answers' ids. A version's answers are read whole: its pointers, then each
 * segment file once. Answers saved as documents before are still read and deleted.
 */
export function objectLabelingStore(db: DocRuntime, objects: ObjectStorePort): LabelingStorePort {
  const repo = new DocRepo(db);
  const docs = docLabelingStore(db);
  const read = async (seg: PredictionSegment): Promise<Prediction[]> => {
    const body = await objects.get(seg.key);
    if (!body) return [];
    return fromUtf8
      .decode(body)
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Prediction);
  };
  const segmentsOf = (promptVersionId: string, endpoint: EndpointId, settingsHash: string) => repo.find<PredictionSegment>(SEGMENTS, {promptVersionId, endpoint, settingsHash});
  /** Looks only through the pointers of the answer's own version, model and settings. */
  const find = async (id: string, scope: PredictionScope, segs?: PredictionSegment[]): Promise<Prediction | null> => {
    for (const seg of segs ?? (await segmentsOf(scope.promptVersionId, scope.endpoint, scope.settingsHash))) {
      if (!seg.predictionIds.includes(id)) continue;
      const p = (await read(seg)).find(x => x.id === id);
      if (p) return p;
    }
    return docs.getPrediction(id, scope);
  };
  const removeSegments = async (segs: PredictionSegment[]) => {
    if (!segs.length) return;
    // The files first: a delete cut short still finds them through the pointers, which go after.
    await objects.deleteBatch(segs.map(s => s.key));
    // `in` filters accept up to 30 values per query.
    for (let i = 0; i < segs.length; i += 30) await repo.deleteWhere(SEGMENTS, {type: 'field', field: 'id', op: 'in', value: segs.slice(i, i + 30).map(s => s.id)});
  };
  return {
    ...docs,
    getPrediction: find,
    async savePredictions(predictions) {
      const out = new Map<string, {prediction: Prediction; saved: boolean}>();
      // Answers already saved (by another runner) are kept, not written twice.
      const groups = new Map<string, Prediction[]>();
      for (const p of predictions) {
        const g = `${p.promptVersionId}|${p.endpoint}|${p.settingsHash}`;
        groups.set(g, [...(groups.get(g) ?? []), p]);
      }
      for (const list of groups.values()) {
        const {promptVersionId, endpoint, settingsHash} = list[0];
        const segs = await segmentsOf(promptVersionId, endpoint, settingsHash);
        const known = new Set(segs.flatMap(s => s.predictionIds));
        const fresh: Prediction[] = [];
        for (const p of list) {
          // Only ids a pointer names are looked up: no read per answer. (Answers saved as
          // documents before were loaded by the run, which never labels them again.)
          const there = known.has(p.id) ? await find(p.id, p, segs) : null;
          if (there) out.set(p.id, {prediction: there, saved: false});
          else if (!fresh.some(f => f.id === p.id)) fresh.push(p);
        }
        if (!fresh.length) continue;
        const projectId = fresh[0].projectId ?? 'none';
        const key = `answers/${projectId}/${promptVersionId}/${newId('seg')}.jsonl`;
        await objects.put(key, utf8.encode(fresh.map(p => `${JSON.stringify(p)}\n`).join('')), {contentType: 'application/x-ndjson'});
        // The pointer after the file: a file whose pointer was never written is never read.
        await repo.insert(SEGMENTS, {id: newId('ps'), projectId, promptVersionId, endpoint, settingsHash, key, predictionIds: fresh.map(p => p.id), createdAt: new Date().toISOString()} satisfies PredictionSegment);
        for (const p of fresh) out.set(p.id, {prediction: p, saved: true});
      }
      // An id given twice is saved once: only its first place says saved.
      const first = new Set<string>();
      return predictions.map(p => {
        const r = out.get(p.id)!;
        if (!r.saved || !first.has(p.id)) return (first.add(p.id), r);
        return {prediction: r.prediction, saved: false};
      });
    },
    async predictionsFor(promptVersionId, endpoint, settingsHash) {
      const segs = await segmentsOf(promptVersionId, endpoint, settingsHash);
      const all = [...(await docs.predictionsFor(promptVersionId, endpoint, settingsHash)), ...(await Promise.all(segs.map(read))).flat()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // Two runners that saved the same answer at once (a model limit above 1 per endpoint) left it
      // in two segments: it counts once, the first saved.
      const seen = new Set<string>();
      return all.filter(p => !seen.has(p.id) && !!seen.add(p.id));
    },
    async deletePredictions(where) {
      await removeSegments(await repo.find<PredictionSegment>(SEGMENTS, where));
      await docs.deletePredictions(where);
    },
  };
}

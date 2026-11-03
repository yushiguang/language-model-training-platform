import {hashString} from '../core/template';
import type {Answer, DatasetSnapshot, Example, GoldLabel, Schema} from '../core/types';
import {newId} from '../data/repo';
import type {RawExample} from '../platform/interfaces';
import {emitChange, getApp, now} from './app';
import {getProject, updateProject} from './projects';

async function saveSnapshot(projectId: string, raws: RawExample[], source: DatasetSnapshot['source'], sourceName: string, invalid = 0): Promise<DatasetSnapshot> {
  const {repo, user} = getApp();
  const project = (await getProject(projectId))!;
  const prev = await repo.find<DatasetSnapshot>('dataset_snapshots', {project_id: projectId});
  const snap: DatasetSnapshot = {
    id: newId('ds'),
    projectId,
    number: prev.length + 1,
    source,
    sourceName,
    createdAt: now(),
    counts: {rows: raws.length + invalid, valid: raws.length, invalid, video: raws.filter(r => r.type === 'video').length, photoText: raws.filter(r => r.type === 'photo_text').length},
    split: null,
  };
  await repo.insert('dataset_snapshots', snap);
  for (const r of raws) {
    const ex: Example = {id: newId('ex'), snapshotId: snap.id, externalId: r.externalId, type: r.type, title: r.title, features: r.features, split: null, optimiserHalf: false};
    await repo.insert('examples', ex);
  }
  await updateProject({...project, snapshotId: snap.id});
  await repo.audit(projectId, (await user()).name, 'dataset.create', {source, rows: raws.length});
  emitChange();
  return snap;
}

/** The MVP mocks automatic sampling: it picks from the prepared file of examples. */
export async function sampleDataset(projectId: string, n: number, onProgress: (fetched: number) => void, signal?: AbortSignal) {
  const raws = await getApp().platform.examples.sample(n, onProgress, signal);
  return saveSnapshot(projectId, raws, 'sample', 'Sampled from the platform');
}

/** Upload: JSONL of full examples, or CSV/JSONL of ids looked up in the example source. */
export async function uploadDataset(projectId: string, file: File): Promise<{snapshot?: DatasetSnapshot; error?: string}> {
  const name = file.name;
  if (!/\.(csv|jsonl|json)$/i.test(name)) return {error: `"${name}" can't be used. Upload a CSV or JSONL file instead. You can save a sheet as CSV from your spreadsheet app.`};
  const text = await file.text();
  const raws: RawExample[] = [];
  const ids: string[] = [];
  let invalid = 0;
  if (/\.csv$/i.test(name)) {
    const [head, ...rows] = text.trim().split(/\r?\n/);
    const col = head.split(',').map(s => s.trim().toLowerCase()).findIndex(h => h === 'video_id' || h === 'id' || h === 'external_id');
    if (col === -1) return {error: 'The file needs a video_id column.'};
    for (const row of rows) {
      const id = row.split(',')[col]?.trim();
      if (id) ids.push(id);
      else invalid++;
    }
  } else {
    for (const line of text.split(/\r?\n/).filter(l => l.trim())) {
      try {
        const o = JSON.parse(line);
        if (o.features && o.type) raws.push({externalId: String(o.externalId ?? o.id ?? o.video_id), type: o.type, title: o.title ?? '', features: o.features});
        else if (o.video_id ?? o.id) ids.push(String(o.video_id ?? o.id));
        else invalid++;
      } catch {
        invalid++;
      }
    }
  }
  if (ids.length) {
    const found = await getApp().platform.examples.lookup(ids);
    invalid += ids.length - found.length;
    raws.push(...found);
  }
  if (!raws.length) return {error: 'No usable rows in this file.'};
  return {snapshot: await saveSnapshot(projectId, raws, 'upload', name, invalid)};
}

/** Order is fixed by a hash of the ids, so the same snapshot always splits the same way. */
export async function applySplit(projectId: string, snapshotId: string, evalSize: number, testSize: number): Promise<void> {
  const {repo} = getApp();
  const snap = (await repo.get<DatasetSnapshot>('dataset_snapshots', snapshotId))!;
  const examples = await repo.find<Example>('examples', {snapshot_id: snapshotId});
  const ordered = [...examples].sort((a, b) => hashString(a.externalId).localeCompare(hashString(b.externalId)));
  ordered.forEach((ex, i) => {
    ex.split = i < evalSize ? 'eval' : i < evalSize + testSize ? 'test' : 'train';
    ex.optimiserHalf = ex.split === 'eval' && i % 2 === 0;
  });
  for (const ex of ordered) await repo.setSplit(ex.id, ex.split, ex);
  await repo.update('dataset_snapshots', {...snap, split: {eval: evalSize, test: testSize, train: examples.length - evalSize - testSize}});
  emitChange();
  void projectId;
}

export async function saveGold(projectId: string, exampleId: string, schemaVersion: number, answer: Answer, revealed: boolean, source: GoldLabel['source'] = 'labeled'): Promise<GoldLabel> {
  const {repo, user} = getApp();
  const g: GoldLabel = {id: newId('gl'), projectId, exampleId, schemaVersion, answer, source, revealed, createdAt: now(), createdBy: (await user()).name};
  await repo.insert('gold_labels', g);
  emitChange();
  return g;
}

/** Upload labels: JSONL lines of {externalId, answer}, or the labels bundled with the sample file. */
export async function uploadGold(projectId: string, schema: Schema, schemaVersion: number, examples: Example[], lines: {externalId: string; answer: Record<string, string[]>}[]): Promise<{saved: number; skipped: number}> {
  const byExt = new Map(examples.map(e => [e.externalId, e]));
  let saved = 0;
  let skipped = 0;
  for (const l of lines) {
    const ex = byExt.get(l.externalId);
    const ok = ex && schema.fields.every(f => (l.answer[f.name] ?? []).every(v => f.values.some(x => x.name === v)) && (l.answer[f.name] ?? []).length > 0);
    if (!ex || !ok || ex.split === 'train') {
      if (ex?.split !== 'train') skipped++;
      continue;
    }
    await saveGold(projectId, ex.id, schemaVersion, l.answer, false, 'uploaded');
    saved++;
  }
  return {saved, skipped};
}

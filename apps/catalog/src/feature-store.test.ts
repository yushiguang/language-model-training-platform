import assert from 'node:assert/strict';
import test from 'node:test';
import type {ExampleFeatures, ObjectStorePort} from '@yushiguang/sprint-contracts';
import {featureDocId} from '@yushiguang/sprint-domain';
import {localDocRuntime, memoryObjectStore} from '@yushiguang/sprint-platform';
import {createCatalog} from './catalog.ts';
import {docFeatureStore, objectFeatureStore} from './feature-store.ts';

const doc = (snapshotId: string, externalId: string, text = `about ${externalId}`): ExampleFeatures => ({id: featureDocId(snapshotId, externalId), snapshotId, externalId, type: 'video', features: {Description: {text}}, fetchedAt: ''});

test('objectFeatureStore: one batch is one segment file of JSON lines; each example gets its own byte range', async () => {
  const objects = memoryObjectStore();
  const store = objectFeatureStore(objects, docFeatureStore(localDocRuntime('fs-1')));
  const refs = await store.putBatch('ds_1', [doc('ds_1', 'a', 'ü – long'), doc('ds_1', 'b'), doc('ds_1', 'c')]);
  assert.equal(objects.keys().length, 1);
  const key = objects.keys()[0];
  assert.match(key, /^features\/ds_1\/seg_.+\.jsonl$/);
  assert.deepEqual(Object.keys(refs), ['a', 'b', 'c']);
  assert.ok(Object.values(refs).every(r => r?.key === key));
  assert.equal(refs.b!.offset, refs.a!.length, 'ranges follow each other, counted in bytes');
  const line = new TextDecoder().decode((await objects.getRange(key, refs.a!.offset, refs.a!.length))!);
  assert.deepEqual(JSON.parse(line), doc('ds_1', 'a', 'ü – long'));
  assert.deepEqual(await store.putBatch('ds_1', []), {}, 'an empty batch writes nothing');
  assert.equal(objects.keys().length, 1);
});

test('objectFeatureStore: a batch read takes one range per segment; old examples come from the documents; missing ones are left out', async () => {
  const objects = memoryObjectStore();
  const reads: [string, number, number][] = [];
  const watched: ObjectStorePort = {...objects, getRange: (k, o, l) => (reads.push([k, o, l]), objects.getRange(k, o, l))};
  const db = localDocRuntime('fs-2');
  const legacy = docFeatureStore(db);
  await legacy.putBatch('ds_1', [doc('ds_1', 'old')]);
  const store = objectFeatureStore(watched, legacy);
  const one = await store.putBatch('ds_1', ['a', 'b', 'c', 'd'].map(x => doc('ds_1', x)));
  const two = await store.putBatch('ds_1', ['e', 'f'].map(x => doc('ds_1', x)));
  const got = await store.getBatch([
    {snapshotId: 'ds_1', externalId: 'b', featureRef: one.b!},
    {snapshotId: 'ds_1', externalId: 'd', featureRef: one.d!},
    {snapshotId: 'ds_1', externalId: 'f', featureRef: two.f!},
    {snapshotId: 'ds_1', externalId: 'old'},
    {snapshotId: 'ds_1', externalId: 'gone'},
    {snapshotId: 'ds_1', externalId: 'lost', featureRef: {key: 'features/ds_1/none.jsonl', offset: 0, length: 10}},
  ]);
  assert.deepEqual(Object.keys(got).sort(), ['ds_1:b', 'ds_1:d', 'ds_1:f', 'ds_1:old']);
  assert.deepEqual(got['ds_1:d'], {Description: {text: 'about d'}});
  assert.equal(reads.length, 3, 'one read per segment file (two here, and the missing one)');
  const first = reads.find(r => r[0] === one.b!.key)!;
  assert.deepEqual(first.slice(1), [one.b!.offset, one.d!.offset + one.d!.length - one.b!.offset], 'from the first wanted line to the last');
});

test('objectFeatureStore: deleting removes the segment files whole, and old documents too', async () => {
  const objects = memoryObjectStore();
  const db = localDocRuntime('fs-3');
  const legacy = docFeatureStore(db);
  await legacy.putBatch('ds_1', [doc('ds_1', 'old')]);
  const store = objectFeatureStore(objects, legacy);
  const refs = {...(await store.putBatch('ds_1', [doc('ds_1', 'a'), doc('ds_1', 'b')])), ...(await store.putBatch('ds_1', [doc('ds_1', 'c')]))};
  await store.deleteBatch([...['a', 'b', 'c'].map(x => ({snapshotId: 'ds_1', externalId: x, featureRef: refs[x]!})), {snapshotId: 'ds_1', externalId: 'old'}]);
  assert.deepEqual(objects.keys(), []);
  assert.deepEqual(await legacy.getBatch([{snapshotId: 'ds_1', externalId: 'old'}]), {});
});

test('docFeatureStore: a batch tried again writes only what is not there yet; refs are null', async () => {
  const db = localDocRuntime('fs-4');
  const store = docFeatureStore(db);
  assert.deepEqual(await store.putBatch('ds_1', [doc('ds_1', 'a')]), {a: null});
  assert.deepEqual(await store.putBatch('ds_1', [doc('ds_1', 'a'), doc('ds_1', 'b')]), {a: null, b: null});
  const c = createCatalog(db);
  assert.equal((await c.find('example_features', {snapshotId: 'ds_1'})).length, 2);
});

test('the catalog over object storage: exampleFeatures reads by featureRef (and old examples by id), deleteProject leaves no segment', async () => {
  const objects = memoryObjectStore();
  const db = localDocRuntime('fs-5');
  const features = objectFeatureStore(objects, docFeatureStore(db));
  const c = createCatalog(db, {features});
  await c.insert('projects', {id: 'pr_o', tenantId: 'default', name: 'O', createdAt: '', createdBy: 'me', setupVersionId: null, snapshotId: 'ds_o', approvedNodes: []});
  await c.insert('dataset_snapshots', {id: 'ds_o', projectId: 'pr_o', number: 1, source: 'sources', sourceName: '', createdAt: '', counts: {rows: 3, valid: 3, invalid: 0, video: 3, photoText: 0}, split: null});
  const refs = await features.putBatch('ds_o', [doc('ds_o', 'a'), doc('ds_o', 'b')]);
  await c.insert('example_features', doc('ds_o', 'old'));
  await c.insertMany('examples', [
    {id: 'ex_a', snapshotId: 'ds_o', externalId: 'a', type: 'video', title: '', split: 'eval', optimiserHalf: false, featureRef: refs.a!},
    {id: 'ex_b', snapshotId: 'ds_o', externalId: 'b', type: 'video', title: '', split: 'eval', optimiserHalf: true, featureRef: refs.b!},
    {id: 'ex_old', snapshotId: 'ds_o', externalId: 'old', type: 'video', title: '', split: 'eval', optimiserHalf: true},
  ]);
  const got = await c.exampleFeatures(await c.findByIds('examples', ['ex_a', 'ex_b', 'ex_old']));
  assert.deepEqual(got, {ex_a: {Description: {text: 'about a'}}, ex_b: {Description: {text: 'about b'}}, ex_old: {Description: {text: 'about old'}}});
  await c.deleteProject('pr_o');
  assert.deepEqual(objects.keys(), []);
  assert.equal((await c.find('example_features', {})).length, 0);
});

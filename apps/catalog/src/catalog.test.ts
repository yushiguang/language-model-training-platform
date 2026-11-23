import assert from 'node:assert/strict';
import test from 'node:test';
import type {PromptVersion} from '@yushiguang/sprint-contracts';
import {localDocRuntime} from '@yushiguang/sprint-platform';
import {LABEL_VALUES} from '@yushiguang/sprint-contracts';
import {catalogKinds, createCatalog} from './catalog.ts';

const base = {projectId: 'pr_1', structured: {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, label: {name: '', kind: 'single' as const, values: []}, ruleGroups: [], images: []}, template: 't', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user' as const, change: '', schemaVersion: 1};

test('catalog numbers prompt versions from what is stored: minors under the parent, majors after the highest', async () => {
  const c = createCatalog(localDocRuntime('cat-1'));
  const v1 = await c.createPromptVersion({...base, parentId: null, kind: 'minor'});
  const v11 = await c.createPromptVersion({...base, parentId: v1.id, kind: 'minor'});
  const v12 = await c.createPromptVersion({...base, parentId: v1.id, kind: 'minor'});
  const v2 = await c.createPromptVersion({...base, parentId: v12.id, kind: 'major'});
  const label = (v: PromptVersion) => `${v.major}.${v.minor}`;
  assert.deepEqual([v1, v11, v12, v2].map(label), ['1.0', '1.1', '1.2', '2.0']);
  // An Optimiser run that reserved major 3: its changes are 3.1, 3.2; a user's new major is 4.
  await c.insert('optimisation_runs', {id: 'op_1', projectId: 'pr_1', major: 3} as never);
  const o1 = await c.createPromptVersion({...base, parentId: v2.id, kind: 'minor', inMajor: 3});
  const o2 = await c.createPromptVersion({...base, parentId: o1.id, kind: 'minor', inMajor: 3});
  const u = await c.createPromptVersion({...base, parentId: v2.id, kind: 'major'});
  assert.deepEqual([o1, o2, u].map(label), ['3.1', '3.2', '4.0']);
});

test('catalog patch changes only the given fields; findByIds returns the asked records', async () => {
  const c = createCatalog(localDocRuntime('cat-2'));
  await c.insert('projects', {id: 'pr_1', tenantId: 'default', name: 'P', createdAt: '', createdBy: 'me', setupVersionId: null, snapshotId: null, approvedNodes: []});
  await c.patch('projects', 'pr_1', {snapshotId: 'ds_1'});
  await c.patch('projects', 'pr_1', {approvedNodes: ['prompt_design']});
  const p = await c.get('projects', 'pr_1');
  assert.equal(p?.snapshotId, 'ds_1');
  assert.deepEqual(p?.approvedNodes, ['prompt_design']);

  await c.insertMany(
    'examples',
    Array.from({length: 40}, (_, i) => ({id: `ex_${i}`, snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, title: '', features: {}, split: null, optimiserHalf: false})),
  );
  const got = await c.findByIds('examples', ['ex_3', 'ex_35', 'missing']);
  assert.deepEqual(got.map(e => e.id).sort(), ['ex_3', 'ex_35']);
});

test('every catalog kind is a declared telemetry collection, so no metric falls back to "other"', () => {
  const missing = catalogKinds().filter(k => !LABEL_VALUES.collection.includes(k));
  assert.deepEqual(missing, []);
});

test('frozen features (#32): exampleFeatures answers plain JSON that survives a loopback; deleting a project removes the features documents by id, never scanning them', async () => {
  const {loopback} = await import('@yushiguang/sprint-platform');
  const {featureDocId} = await import('@yushiguang/sprint-domain');
  const db = localDocRuntime('cat-frozen');
  // Every read of the features collection, as the store sees it.
  const featureReads: string[] = [];
  const watched = {
    ...db,
    batch: () => db.batch(),
    collection<T extends object>(name: string) {
      const c = db.collection<T>(name);
      if (name !== 'example_features') return c;
      return {...c, name: c.name, add: c.add.bind(c), get: c.get.bind(c), set: c.set.bind(c), update: c.update.bind(c), delete: c.delete.bind(c), query: c.query.bind(c), subscribe: c.subscribe.bind(c), find: (where?: Parameters<typeof c.find>[0], order?: Parameters<typeof c.find>[1]) => (featureReads.push(JSON.stringify(where ?? {})), c.find(where, order))};
    },
  } as typeof db;
  const c = createCatalog(watched);
  await c.insert('projects', {id: 'pr_f', tenantId: 'default', name: 'F', createdAt: '', createdBy: 'me', setupVersionId: null, snapshotId: 'ds_f', approvedNodes: []});
  await c.insert('dataset_snapshots', {id: 'ds_f', projectId: 'pr_f', number: 1, source: 'sources', sourceName: '', createdAt: '', counts: {rows: 3, valid: 3, invalid: 0, video: 3, photoText: 0}, split: null});
  const ids = ['a', 'b', 'c'];
  await c.insertMany('examples', ids.map(x => ({id: `ex_${x}`, snapshotId: 'ds_f', externalId: x, type: 'video' as const, title: '', split: 'eval' as const, optimiserHalf: false})));
  await c.insertMany('example_features', ids.map(x => ({id: featureDocId('ds_f', x), snapshotId: 'ds_f', externalId: x, type: 'video' as const, features: {Description: {text: `about ${x}`}}, fetchedAt: ''})));
  const examples = await c.findByIds('examples', ['ex_a', 'ex_b']);
  const direct = await c.exampleFeatures(examples);
  const remote = await loopback(c).exampleFeatures(examples);
  assert.deepEqual(remote, direct, 'the same answer over JSON');
  assert.deepEqual(remote, {ex_a: {Description: {text: 'about a'}}, ex_b: {Description: {text: 'about b'}}});
  featureReads.length = 0;
  await c.deleteProject('pr_f');
  assert.equal((await c.findByIds('example_features', ids.map(x => featureDocId('ds_f', x)))).length, 0, 'the features are gone');
  assert.equal((await c.find('examples', {snapshotId: 'ds_f'})).length, 0);
  assert.ok(featureReads.length > 0 && featureReads.every(q => !q.includes('snapshotId')), `features are found by id only: ${featureReads.join(' ')}`);
});

test('catalog page reads one window of the matching records in order, with the total', async () => {
  const c = createCatalog(localDocRuntime('cat-page'));
  await c.insertMany(
    'examples',
    Array.from({length: 25}, (_, i) => ({id: `ex_${i}`, snapshotId: i < 20 ? 'ds_1' : 'ds_2', number: 20 - i, externalId: String(i), type: 'video' as const, title: '', split: null, optimiserHalf: false})),
  );
  const first = await c.page('examples', {where: {snapshotId: 'ds_1'}, order: 'number', limit: 5});
  assert.equal(first.total, 20);
  assert.deepEqual(first.items.map(e => e.number), [1, 2, 3, 4, 5]);
  const next = await c.page('examples', {where: {snapshotId: 'ds_1'}, order: 'number', offset: 15, limit: 10});
  assert.deepEqual(next.items.map(e => e.number), [16, 17, 18, 19, 20]);
  // A range of numbers, as a label set reads its samples.
  const range = await c.page('examples', {where: {type: 'and', filters: [{type: 'field', field: 'snapshotId', op: '==', value: 'ds_1'}, {type: 'field', field: 'number', op: '>=', value: 4}, {type: 'field', field: 'number', op: '<=', value: 6}]}, order: 'number'});
  assert.deepEqual(range.items.map(e => e.number), [4, 5, 6]);
  assert.equal(range.total, 3);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type {PromptVersion} from '@tsp/contracts';
import {localDocRuntime} from '@tsp/platform';
import {createCatalog} from './catalog.ts';

const base = {projectId: 'pr_1', template: 't', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user' as const, change: '', schemaVersion: 1};

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
  await c.insert('projects', {id: 'pr_1', name: 'P', createdAt: '', createdBy: 'me', setupVersionId: null, snapshotId: null, approvedNodes: []});
  await c.patch('projects', 'pr_1', {snapshotId: 'ds_1'});
  await c.patch('projects', 'pr_1', {approvedNodes: ['setup']});
  const p = await c.get('projects', 'pr_1');
  assert.equal(p?.snapshotId, 'ds_1');
  assert.deepEqual(p?.approvedNodes, ['setup']);

  await c.insertMany(
    'examples',
    Array.from({length: 40}, (_, i) => ({id: `ex_${i}`, snapshotId: 'ds_1', externalId: String(i), type: 'video' as const, title: '', features: {}, split: null, optimiserHalf: false})),
  );
  const got = await c.findByIds('examples', ['ex_3', 'ex_35', 'missing']);
  assert.deepEqual(got.map(e => e.id).sort(), ['ex_3', 'ex_35']);
});

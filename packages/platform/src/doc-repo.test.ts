import assert from 'node:assert/strict';
import test from 'node:test';
import {localDocRuntime} from './standins/local-db.ts';
import {DocFieldValue, DocFilter, DocRepo} from './doc-repo.ts';

test('DocRepo inserts, gets, and updates records while preserving _appId', async () => {
  const repo = new DocRepo(localDocRuntime('test-1'));
  await repo.insert('projects', {
    id: 'pr_1',
    name: 'First',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'Alice',
    setupVersionId: null,
    snapshotId: null,
    approvedNodes: [],
  });

  const got = await repo.get<{id: string; name: string}>('projects', 'pr_1');
  assert.equal(got?.name, 'First');
  assert.equal((got as Record<string, unknown>)?._appId, undefined);

  await repo.update('projects', {
    id: 'pr_1',
    name: 'Renamed',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'Alice',
    setupVersionId: 'sv_1',
    snapshotId: null,
    approvedNodes: ['setup'],
  });

  const updated = await repo.get<{id: string; name: string; setupVersionId: string}>('projects', 'pr_1');
  assert.equal(updated?.name, 'Renamed');
  assert.equal(updated?.setupVersionId, 'sv_1');
});

test('DocRepo translates snake_case filter keys and order clauses', async () => {
  const repo = new DocRepo(localDocRuntime('test-2'));
  await repo.insert('eval_reports', {
    id: 'er_1',
    projectId: 'pr_1',
    promptVersionId: 'pv_1',
    endpoint: 'A',
    contextId: 'ctx_1',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await repo.insert('eval_reports', {
    id: 'er_2',
    projectId: 'pr_1',
    promptVersionId: 'pv_1',
    endpoint: 'A',
    contextId: 'ctx_1',
    createdAt: '2026-01-02T00:00:00Z',
  });
  await repo.insert('eval_reports', {
    id: 'er_3',
    projectId: 'pr_2',
    promptVersionId: 'pv_2',
    endpoint: 'B',
    contextId: 'ctx_2',
    createdAt: '2026-01-03T00:00:00Z',
  });

  const rows = await repo.find<{id: string; createdAt: string}>(
    'eval_reports',
    {project_id: 'pr_1', prompt_version_id: 'pv_1', endpoint: 'A', context_id: 'ctx_1'},
    'created_at desc',
  );
  assert.deepEqual(
    rows.map(r => r.id),
    ['er_2', 'er_1'],
  );
});

test('DocRepo inserts many and patches many records via batch', async () => {
  const repo = new DocRepo(localDocRuntime('test-3'));
  await repo.insertMany('examples', [{
    id: 'ex_1',
    snapshotId: 'ds_1',
    externalId: '100',
    type: 'video',
    title: 'Sample 1',
    features: {},
    split: null,
    optimiserHalf: false,
  }, {
    id: 'ex_2',
    snapshotId: 'ds_1',
    externalId: '101',
    type: 'video',
    title: 'Sample 2',
    features: {},
    split: null,
    optimiserHalf: false,
  }]);

  await repo.patchMany('examples', [
    {id: 'ex_1', patch: {split: 'eval', optimiserHalf: true}},
    {id: 'ex_2', patch: {split: 'train', optimiserHalf: false}},
  ]);

  const ex1 = await repo.get<{id: string; split: string; optimiserHalf: boolean}>('examples', 'ex_1');
  const ex2 = await repo.get<{id: string; split: string; optimiserHalf: boolean}>('examples', 'ex_2');
  assert.equal(ex1?.split, 'eval');
  assert.equal(ex1?.optimiserHalf, true);
  assert.equal(ex2?.split, 'train');
  assert.equal(ex2?.optimiserHalf, false);

});

test('DocRepo supports DocFilter (OR/contains/in/comparisons), DocFieldValue atomic patch, pagination, and delete', async () => {
  const repo = new DocRepo(localDocRuntime('test-4'));
  await repo.insert('labeling_runs', {
    id: 'lr_1',
    projectId: 'pr_1',
    endpoint: 'A',
    state: 'running',
    done: 2,
    tags: ['initial'],
    startedAt: '2026-01-01T00:00:00Z',
  });
  await repo.insert('labeling_runs', {
    id: 'lr_2',
    projectId: 'pr_1',
    endpoint: 'B',
    state: 'paused',
    done: 10,
    tags: ['fast', 'retry'],
    startedAt: '2026-01-02T00:00:00Z',
  });
  await repo.insert('labeling_runs', {
    id: 'lr_3',
    projectId: 'pr_1',
    endpoint: 'A',
    state: 'done',
    done: 20,
    tags: ['final'],
    startedAt: '2026-01-03T00:00:00Z',
  });

  // Atomic partial update via DocFieldValue
  await repo.patch<{id: string; done: number; tags: string[]}>('labeling_runs', 'lr_1', {
    done: DocFieldValue.increment(3),
    tags: DocFieldValue.arrayUnion('initial', 'boosted'),
  });
  const patched = await repo.get<{id: string; done: number; tags: string[]}>('labeling_runs', 'lr_1');
  assert.equal(patched?.done, 5);
  assert.deepEqual(patched?.tags, ['initial', 'boosted']);

  // Composite OR + comparison filter + pagination
  const page = await repo.query<{id: string; state: string; done: number}>('labeling_runs', {
    where: DocFilter.and(
      DocFilter.where('project_id', '==', 'pr_1'),
      DocFilter.or(DocFilter.where('state', '==', 'paused'), DocFilter.where('done', '>=', 15)),
    ),
    order: 'started_at desc',
    limit: 1,
    offset: 0,
  });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 'lr_3');

  // Delete record
  await repo.delete('labeling_runs', 'lr_2');
  const deleted = await repo.get('labeling_runs', 'lr_2');
  assert.equal(deleted, null);
});

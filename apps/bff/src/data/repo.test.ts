import assert from 'node:assert/strict';
import test from 'node:test';
import {localDocRuntime} from '../../../../packages/infra/src/standins/local-db.ts';
import {Repo} from './repo.ts';

test('Repo inserts, gets, and updates records while preserving _appId', async () => {
  const repo = new Repo(localDocRuntime('test-1'));
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

test('Repo translates snake_case filter keys and order clauses', async () => {
  const repo = new Repo(localDocRuntime('test-2'));
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

test('Repo deduplicates training rows and updates example split', async () => {
  const repo = new Repo(localDocRuntime('test-3'));
  await repo.insert('examples', {
    id: 'ex_1',
    snapshotId: 'ds_1',
    externalId: '100',
    type: 'video',
    title: 'Sample',
    features: {},
    split: null,
    optimiserHalf: false,
  });

  await repo.setSplit('ex_1', 'eval', {
    id: 'ex_1',
    snapshotId: 'ds_1',
    externalId: '100',
    type: 'video',
    title: 'Sample',
    features: {},
    split: 'eval',
    optimiserHalf: true,
  });

  const ex = await repo.get<{id: string; split: string; optimiserHalf: boolean}>('examples', 'ex_1');
  assert.equal(ex?.split, 'eval');
  assert.equal(ex?.optimiserHalf, true);

  await repo.insertTrainingRows([
    {trainingSetId: 'ts_1', exampleId: 'ex_1'},
    {trainingSetId: 'ts_1', exampleId: 'ex_1'},
    {trainingSetId: 'ts_1', exampleId: 'ex_2'},
  ]);
  const rows = await repo.trainingRows<{trainingSetId: string; exampleId: string}>('ts_1');
  assert.equal(rows.length, 2);
});

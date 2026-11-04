import assert from 'node:assert/strict';
import test from 'node:test';
import type {ProjectState} from '@tsp/contracts';
import {AUTO_START_PROJECT_CAP_USD, autoSpendUsd, autoStartCheck, dueStarts} from './auto-start.ts';

const version = {id: 'pv_1', template: 'Label {{Title}}', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user', createdAt: '2026-11-04T00:00:00Z', schemaVersion: 1} as unknown as ProjectState['versions'][number];
const state = (over: Partial<ProjectState> = {}): ProjectState =>
  ({
    project: {id: 'pr_1'},
    setup: {schema: {policy: '', fields: []}, models: [{endpoint: 'A', maxOutputTokens: 512, temperature: 0}], thresholds: null, autoStart: true},
    snapshot: {split: {eval: 2, test: 0, train: 0}},
    examples: [
      {id: 'ex_1', split: 'eval', features: {Title: 'a'}, type: 'video'},
      {id: 'ex_2', split: 'eval', features: {Title: 'b'}, type: 'video'},
    ],
    gold: new Map(),
    versions: [version],
    reports: [],
    runs: [],
    testRuns: [],
    optimisation: [],
    trainingSets: [],
    facts: {goldEvalDone: 0},
    endpoints: [{id: 'A', priceIn: 1, priceOut: 4}],
    ...over,
  }) as unknown as ProjectState;

test('a new version is due for scoring on each chosen model', () => {
  const due = dueStarts(state());
  assert.deepEqual(due.map(d => `${d.what}:${d.endpoint}`), ['score:A']);
  assert.ok(due[0].estimateUsd > 0);
});

test('the switch off means every start asks', () => {
  const s = state({setup: {...state().setup!, autoStart: false}});
  assert.deepEqual(autoStartCheck(s, 0.01), {allowed: false, reason: 'off'});
  assert.deepEqual(autoStartCheck(state(), 0.01), {allowed: true, reason: null});
});

test('missing autoStart on an older setup record counts as on', () => {
  const s = state({setup: {...state().setup!, autoStart: undefined}});
  assert.equal(autoStartCheck(s, 0.01).allowed, true);
});

test('fixed caps ask even with the switch on: above $1 once, or after $5 of automatic spend', () => {
  assert.deepEqual(autoStartCheck(state(), 1.01), {allowed: false, reason: 'over_single_cap'});
  const spent = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: AUTO_START_PROJECT_CAP_USD, auto: true}] as ProjectState['runs']});
  assert.equal(autoSpendUsd(spent), AUTO_START_PROJECT_CAP_USD);
  assert.deepEqual(autoStartCheck(spent, 0.01), {allowed: false, reason: 'over_project_cap'});
  // Spend from starts the user clicked does not count.
  const clicked = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 9}] as ProjectState['runs']});
  assert.equal(autoStartCheck(clicked, 0.01).allowed, true);
});

test('a paused scoring run is due to resume, and costs only what is left', () => {
  const s = state({runs: [{id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'paused', done: 1, total: 2, costUsd: 0}] as ProjectState['runs']});
  const due = dueStarts(s);
  assert.deepEqual(due.map(d => d.what), ['resume']);
  assert.ok(Math.abs(due[0].estimateUsd * 2 - dueStarts(state())[0].estimateUsd) < 1e-9);
});

test('final run plan: test examples with gold or an answer are never labeled again', async () => {
  const {finalRunPlan} = await import('./workflow.ts');
  const s = state({
    examples: [
      {id: 't1', split: 'test', features: {Title: 'a'}, type: 'video'},
      {id: 't2', split: 'test', features: {Title: 'b'}, type: 'video'},
      {id: 't3', split: 'test', features: {Title: 'c'}, type: 'video'},
      {id: 'r1', split: 'train', features: {Title: 'd'}, type: 'video'},
    ] as unknown as ProjectState['examples'],
    gold: new Map([['t1', {answer: {}}]]) as unknown as ProjectState['gold'],
  });
  const p = finalRunPlan(s, version, 'A', new Set(['t1', 't2']));
  assert.deepEqual(p.test.withGold, ['t1']);
  assert.deepEqual(p.test.withAnswer, ['t2']);
  assert.deepEqual(p.test.toLabel, ['t3']);
  assert.equal(p.total(false).count, 1);
  assert.equal(p.total(true).count, 2);
  assert.ok(p.total(true).costUsd > p.total(false).costUsd);
});

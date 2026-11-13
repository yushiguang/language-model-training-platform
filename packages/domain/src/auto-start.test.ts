import assert from 'node:assert/strict';
import test from 'node:test';
import type {ProjectState} from '@tsp/contracts';
import {autoSpendUsd, dueStarts} from './auto-start.ts';

const version = {id: 'pv_1', template: 'Label {{Title}}', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user', createdAt: '2026-11-04T00:00:00Z', schemaVersion: 1} as unknown as ProjectState['versions'][number];
const state = (over: Partial<ProjectState> = {}): ProjectState =>
  ({
    project: {id: 'pr_1'},
    setup: {schema: {fields: []}, models: [{endpoint: 'A', maxOutputTokens: 512, temperature: 0}], thresholds: null},
    snapshot: {split: {eval: 2, test: 0, train: 0}},
    examples: [
      {id: 'ex_1', split: 'eval', features: {Title: 'a'}, type: 'video'},
      {id: 'ex_2', split: 'eval', features: {Title: 'b'}, type: 'video'},
      {id: 'ex_3', split: 'eval', features: {Title: 'c'}, type: 'video'},
      {id: 'ex_4', split: 'eval', features: {Title: 'd'}, type: 'video'},
    ],
    gold: {},
    versions: [version],
    reports: [],
    runs: [],
    optimisation: [],
    facts: {examples: 4, goldEvalDone: 4, goldHalves: {optimiser: 2, heldOut: 2}, settingsConfirmed: true},
    endpoints: [{id: 'A', priceIn: 1, priceOut: 4}],
    ...over,
  }) as unknown as ProjectState;

test('a new version is due for scoring on each chosen model', () => {
  const due = dueStarts(state());
  assert.deepEqual(due.map(d => `${d.what}:${d.endpoint}`), ['score:A']);
  assert.ok(due[0].estimateUsd > 0);
});

test('automatic spend counts runs started by code and try_prompt spend, not runs the user clicked', () => {
  const clicked = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 9, autoCostUsd: 0}] as ProjectState['runs']});
  assert.equal(autoSpendUsd(clicked), 0);
  const resumed = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 9, autoCostUsd: 4.5}] as ProjectState['runs']});
  assert.equal(autoSpendUsd(resumed), 4.5);
  assert.equal(autoSpendUsd(state({otherAutoSpendUsd: 0.25})), 0.25);
});

test('a paused scoring run is due to resume, and costs only what is left', () => {
  const s = state({runs: [{id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'paused', done: 2, total: 4, costUsd: 0}] as ProjectState['runs']});
  const due = dueStarts(s);
  assert.deepEqual(due.map(d => d.what), ['resume']);
  assert.ok(Math.abs(due[0].estimateUsd * 2 - dueStarts(state())[0].estimateUsd) < 1e-9);
});

test('nothing starts by itself before settings are confirmed and enough gold labels exist (spec 2.5)', () => {
  const facts = state().facts;
  assert.deepEqual(dueStarts(state({facts: {...facts, settingsConfirmed: false}})), []);
  assert.deepEqual(dueStarts(state({facts: {...facts, goldEvalDone: 1, goldHalves: {optimiser: 1, heldOut: 0}}})), []);
  assert.deepEqual(dueStarts(state({facts: {...facts, goldHalves: {optimiser: 3, heldOut: 1}}})), []);
  assert.equal(dueStarts(state()).length, 1);
});

test('the Optimiser is never due by itself, and its labeling waits for Retry', () => {
  const scored = state({
    setup: {schema: {fields: []}, models: [{endpoint: 'A', maxOutputTokens: 512, temperature: 0}], thresholds: {macroF1: 0.8}} as unknown as ProjectState['setup'],
    runs: [{id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 0}] as ProjectState['runs'],
  });
  assert.deepEqual(dueStarts(scored), []);
  const cand = {...version, id: 'pv_2', madeBy: 'optimiser'} as ProjectState['versions'][number];
  const paused = state({
    versions: [cand, version],
    runs: [
      {id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 0},
      {id: 'lt_2', promptVersionId: 'pv_2', endpoint: 'A', state: 'paused', done: 1, total: 2, costUsd: 0},
    ] as ProjectState['runs'],
    optimisation: [{id: 'op_1', state: 'paused', history: [{versionId: 'pv_2'}]}] as unknown as ProjectState['optimisation'],
  });
  assert.deepEqual(dueStarts(paused), []);
});

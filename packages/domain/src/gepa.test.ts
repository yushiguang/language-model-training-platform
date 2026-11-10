import assert from 'node:assert/strict';
import test from 'node:test';
import type {Example, Schema} from '@tsp/contracts';
import {compareDryRun, dryRunSize, exampleBrief, exampleScore, mergePair, paretoFront, pickDryRun, pickParent, promptKeys, wrongExamples} from './gepa.ts';

const schema: Schema = {fields: [{name: 'a', kind: 'single', values: []}, {name: 'b', kind: 'multi', values: []}]};

test('an example scores the share of fields right; an invalid answer scores 0', () => {
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p', 'q']}, {a: ['x'], b: ['q', 'p']}), 1);
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p']}, {a: ['x'], b: []}), 0.5);
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p']}, null), 0);
});

test('dry run: half of the optimiser half, at most 20', () => {
  assert.equal(dryRunSize(60), 20);
  assert.equal(dryRunSize(40), 20);
  assert.equal(dryRunSize(30), 15);
  assert.equal(dryRunSize(14), 7);
  assert.equal(dryRunSize(1), 1);
});

test('helpers read the wrong examples worst first, at most 8, with text features cut short and no images', () => {
  const ex = (i: number): Example => ({id: `e${i}`, snapshotId: 's', externalId: `ex-${i}`, type: 'photo_text', title: '', features: {Title: `title ${i}`, Body: 'x'.repeat(500), Cover: 'https://img/1.jpg', Pics: ['https://img/2.jpg'], Unused: 'not in the prompt'}, split: 'eval', optimiserHalf: true});
  const exs = Array.from({length: 12}, (_, i) => ex(i));
  const gold = new Map(exs.map(e => [e.id, {a: ['x'], b: ['p']}]));
  // e0..e3 right, e4..e7 half right, e8..e11 wrong.
  const pred = new Map(exs.map((e, i) => [e.id, i < 4 ? {a: ['x'], b: ['p']} : i < 8 ? {a: ['x'], b: []} : null]));
  const out = wrongExamples(schema, exs, promptKeys({template: '{{Title}} {{Body}} {{Cover}}', features: {video: [], photo_text: ['Pics'], metadata: []}}), gold, pred);
  assert.equal(out.length, 8);
  assert.deepEqual(out.slice(0, 4).map(e => e.externalId), ['ex-8', 'ex-9', 'ex-10', 'ex-11']);
  assert.deepEqual(Object.keys(out[0].features).sort(), ['Body', 'Title']);
  assert.ok(out[0].features.Body.length <= 300);
  assert.equal(out[0].predicted, null);
  assert.equal(exampleBrief(exs[0], ['Title'], {a: ['x']}, null, 'other').rightIn, 'other');
});

test('the Pareto front keeps every version that is best on some example, weighted by wins', () => {
  const pool = [
    {id: 'v1', scores: new Map([['e1', 1], ['e2', 0], ['e3', 0.5]])},
    {id: 'v2', scores: new Map([['e1', 0.5], ['e2', 1], ['e3', 0.5]])},
    {id: 'v3', scores: new Map([['e1', 0.5], ['e2', 0.5], ['e3', 0]])},
  ];
  const front = paretoFront(pool, ['e1', 'e2', 'e3']);
  assert.deepEqual(front, [{id: 'v1', wins: 2}, {id: 'v2', wins: 2}]);
  assert.equal(pickParent(front, () => 0.1), 'v1');
  assert.equal(pickParent(front, () => 0.9), 'v2');
  assert.deepEqual(mergePair(pool, front), ['v1', 'v2']);
  assert.equal(pickParent([], () => 0.5), null);
});

test('a version another one matches or beats on every example is not on the front', () => {
  const pool = [
    {id: 'v1', scores: new Map([['e1', 0], ['e2', 1]])},
    {id: 'v2', scores: new Map([['e1', 1], ['e2', 1]])},
  ];
  assert.deepEqual(paretoFront(pool, ['e1', 'e2']), [{id: 'v2', wins: 2}]);
});

test('the dry run takes the examples the parent gets wrong first', () => {
  const scores = new Map([['e1', 1], ['e2', 0.5], ['e3', 1], ['e4', 0]]);
  const picked = pickDryRun(['e1', 'e2', 'e3', 'e4'], scores, 3, () => 0.5);
  assert.deepEqual(new Set(picked.slice(0, 2)), new Set(['e2', 'e4']));
  assert.equal(picked.length, 3);
});

test('a change goes on only when it passes more dry-run examples than its parent', () => {
  const gold = {a: ['x'], b: ['p']};
  const r = compareDryRun(schema, 'v1', [
    {gold, candidate: {a: ['x'], b: ['p']}, parent: {a: ['y'], b: ['p']}},
    {gold, candidate: {a: ['x'], b: ['p']}, parent: {a: ['x'], b: ['p']}},
    {gold, candidate: null, parent: {a: ['x'], b: []}},
  ]);
  assert.equal(r.passed, 2);
  assert.equal(r.parentPassed, 1);
  assert.equal(r.better, true);
  assert.deepEqual(r.fields, [{field: 'a', passed: 2, parentPassed: 2}, {field: 'b', passed: 2, parentPassed: 2}]);
  assert.equal(compareDryRun(schema, 'v1', [{gold, candidate: gold, parent: gold}]).better, false);
});

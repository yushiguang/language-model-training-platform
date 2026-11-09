import assert from 'node:assert/strict';
import test from 'node:test';
import type {Schema} from '@tsp/contracts';
import {compareDryRun, dryRunSize, exampleScore, mergePair, paretoFront, pickDryRun, pickParent} from './gepa.ts';

const schema: Schema = {fields: [{name: 'a', kind: 'single', values: []}, {name: 'b', kind: 'multi', values: []}]};

test('an example scores the share of fields right; an invalid answer scores 0', () => {
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p', 'q']}, {a: ['x'], b: ['q', 'p']}), 1);
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p']}, {a: ['x'], b: []}), 0.5);
  assert.equal(exampleScore(schema, {a: ['x'], b: ['p']}, null), 0);
});

test('dry run: 10 examples, or half of the optimiser half when it has fewer than 20', () => {
  assert.equal(dryRunSize(50), 10);
  assert.equal(dryRunSize(20), 10);
  assert.equal(dryRunSize(14), 7);
  assert.equal(dryRunSize(1), 1);
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

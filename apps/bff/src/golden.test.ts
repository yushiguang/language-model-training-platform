import assert from 'node:assert/strict';
import test from 'node:test';
import {Normalizer, pick, withOutcomes, type BffFixture} from './golden.ts';

test('golden: generated ids are named in the order a run first shows them, walking keys in order; times become $time', () => {
  const n = new Normalizer();
  const a = 'pr_0123456789abcdef';
  const b = 'sv_fedcba9876543210';
  assert.deepEqual(n.value({z: a, a: b, at: '2026-11-19T10:00:00.000Z', name: 'pr_w', text: `Project ${a} is gone`}), {a: '$id:1', at: '$time', name: 'pr_w', text: 'Project $id:2 is gone', z: '$id:2'});
  assert.equal(n.text('src_builtin_0123456789abcdef'), '$id:3', 'a two-part prefix');
  assert.deepEqual(n.args([{projectId: '$id:2'}, 'v $id:1']), [{projectId: a}, `v ${b}`]);
  assert.throws(() => n.args('$id:9'), /has not been seen/);
});

test('golden: only keeps dotted parts of a result, and # counts', () => {
  const r = {examples: [1, 2, 3], snapshot: {counts: {rows: 3}}, gold: {a: 1}};
  assert.deepEqual(pick(r, ['examples#', 'snapshot.counts.rows', 'gold#', 'missing.part']), {'examples#': 3, 'snapshot.counts.rows': 3, 'gold#': 1, 'missing.part': null});
  assert.deepEqual(pick([1, 2], ['#', '0']), {'#': 2, '0': 1});
});

test('golden: recording writes each call step\'s outcome and leaves settle steps alone', () => {
  const fx: BffFixture = {name: 'x', guards: ['g'], world: {users: {u: {id: 'u', name: 'U'}}, reply: ''}, steps: [{call: 'listProjects', expect: 'old'}, {settle: true}, {call: 'getProject', args: ['p'], expectError: 'old'}]};
  const out = withOutcomes(fx, [{expect: []}, {}, {expect: null}]);
  assert.deepEqual(out.steps, [{call: 'listProjects', expect: []}, {settle: true}, {call: 'getProject', args: ['p'], expect: null}]);
});

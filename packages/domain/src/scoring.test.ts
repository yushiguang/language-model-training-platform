import assert from 'node:assert/strict';
import test from 'node:test';
import type {Thresholds} from '@yushiguang/sprint-contracts';
import {basisChanges, labelSetProgress, scoreBasis} from './scoring.ts';

const ex = (n: number) => ({id: `ex_${n}`, number: n, optimiserHalf: n % 2 === 0});

test('a label set is finished when every live sample in its range has a gold label; samples outside sets do not count', () => {
  // Sample 3 was removed (not passed in); 9 and 10 are in no set.
  const live = [1, 2, 4, 5, 6, 7, 8, 9, 10].map(ex);
  const gold = Object.fromEntries([1, 2, 4, 5, 6].map(n => [`ex_${n}`, true]));
  const sets = [{first: 6, last: 8}, {first: 1, last: 5}];
  assert.deepEqual(labelSetProgress(live, gold, sets), {ranges: [{first: 1, last: 5}, {first: 6, last: 8}], labelSets: 2, labelSetsDone: 1, samples: 7, labeled: 5, ready: false});
  const all = {...gold, ex_7: true, ex_8: true};
  assert.equal(labelSetProgress(live, all, sets).ready, true, 'the removed sample 3 and the unassigned 9, 10 are not waited for');
  // A set whose samples were all removed is finished.
  assert.equal(labelSetProgress(live, all, [...sets, {first: 3, last: 3}]).labelSetsDone, 3);
});

test('with no label set yet, the rule from before label sets holds: scores on the labeled samples', () => {
  const live = [1, 2, 3].map(ex);
  assert.deepEqual(labelSetProgress(live, {ex_1: 1, ex_2: 1}, []), {ranges: null, labelSets: 0, labelSetsDone: 0, samples: 3, labeled: 2, ready: true});
  assert.equal(labelSetProgress(live, {}, []).ready, false, 'nothing to score on');
});

test('the score basis names what changed: samples, else gold labels, and thresholds', () => {
  const t: Thresholds = {mode: 'custom', macroF1: 0.8, valueF1: null, invalidRate: null, accuracy: null, minEval: 10};
  const gold = {ex_1: {id: 'g1'}, ex_2: {id: 'g2'}, ex_3: {id: 'g3'}};
  const a = scoreBasis(1, [ex(1), ex(2)], gold, t);
  assert.deepEqual(scoreBasis(1, [ex(2), ex(1)], gold, {...t, precision: null}), a, 'order and a missing versus null precision do not matter');
  assert.notEqual(scoreBasis(2, [ex(1), ex(2)], gold, t).contextId, a.contextId, 'the label schema is part of the id');
  assert.deepEqual(basisChanges(a.basis, scoreBasis(1, [ex(1), ex(2)], {...gold, ex_2: {id: 'g9'}}, t).basis), ['gold']);
  assert.deepEqual(basisChanges(a.basis, scoreBasis(1, [ex(1), ex(2), ex(3)], gold, {...t, macroF1: 0.7}).basis), ['samples', 'thresholds']);
  assert.deepEqual(basisChanges(undefined, a.basis), [], 'a report made before the basis was kept says nothing');
});

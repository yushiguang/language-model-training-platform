import assert from 'node:assert/strict';
import test from 'node:test';
import type {Example, Schema} from '@sprint/contracts';
import {compareDryRun, dryRunSize, exampleBrief, exampleScore, mergePair, paretoFront, pickDryRun, pickParent, promptKeys, wrongExamples} from './gepa.ts';
import {toFeatures} from './template.ts';

test('an example scores 1 when its answer matches the gold label; an invalid answer scores 0', () => {
  assert.equal(exampleScore(['x'], ['x']), 1);
  assert.equal(exampleScore(['x'], ['y']), 0);
  assert.equal(exampleScore(['x'], null), 0);
});

test('a multi-select answer earns part of the score for the values it gets right', () => {
  assert.equal(exampleScore(['a', 'b'], ['b', 'a']), 1);
  assert.equal(exampleScore(['a', 'b'], ['a']), 2 / 3);
  assert.equal(exampleScore(['a', 'b'], ['a', 'c']), 0.5);
  assert.equal(exampleScore(['a'], []), 0);
});

test('dry run: half of the optimiser half, at most 20', () => {
  assert.equal(dryRunSize(60), 20);
  assert.equal(dryRunSize(40), 20);
  assert.equal(dryRunSize(30), 15);
  assert.equal(dryRunSize(14), 7);
  assert.equal(dryRunSize(1), 1);
});

test('helpers read the wrong examples, invalid answers first, at most 8, with text features cut short and no images', () => {
  const ex = (i: number): Example => ({id: `e${i}`, snapshotId: 's', externalId: `ex-${i}`, type: 'photo_text', title: '', features: toFeatures({Title: `title ${i}`, Body: 'x'.repeat(500), Cover: 'https://img/1.jpg', Pics: ['https://img/2.jpg'], Unused: 'not in the prompt'}), split: 'eval', optimiserHalf: true});
  const exs = Array.from({length: 12}, (_, i) => ex(i));
  const gold = new Map(exs.map(e => [e.id, ['x']]));
  // e0..e3 right, e4..e7 wrong, e8..e11 invalid.
  const pred = new Map(exs.map((e, i) => [e.id, i < 4 ? ['x'] : i < 8 ? ['y'] : null]));
  const out = wrongExamples(exs, promptKeys({template: '{{Title}} {{Body}} {{Cover}}', features: {video: [], photo_text: ['Pics'], metadata: []}}), gold, pred);
  assert.equal(out.length, 8);
  assert.deepEqual(out.slice(0, 4).map(e => e.externalId), ['ex-8', 'ex-9', 'ex-10', 'ex-11']);
  assert.deepEqual(Object.keys(out[0].features).sort(), ['Body', 'Title']);
  assert.ok(out[0].features.Body.length <= 300);
  assert.equal(out[0].predicted, null);
  assert.equal(exampleBrief(exs[0], ['Title'], ['x'], null, 'other').rightIn, 'other');
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

test('the dry run picks at random, up to half from the focus examples', () => {
  let i = 0;
  const rand = () => (i++ * 0.37) % 1;
  const ids = Array.from({length: 20}, (_, k) => `e${k}`);
  const picked = pickDryRun(ids, 6, new Set(['e3', 'e7', 'e9', 'e11', 'e15']), rand);
  assert.equal(picked.length, 6);
  assert.equal(new Set(picked).size, 6);
  assert.equal(picked.slice(0, 3).filter(id => ['e3', 'e7', 'e9', 'e11', 'e15'].includes(id)).length, 3);
  assert.equal(pickDryRun(['e1', 'e2'], 5).length, 2);
});

test('a dry run drops a change only when it scores lower than the version it came from; a tie goes on', () => {
  const r = compareDryRun('v1', [
    {gold: ['x'], candidate: ['x'], parent: ['y']},
    {gold: ['x'], candidate: ['x'], parent: ['x']},
    {gold: ['x'], candidate: null, parent: ['x']},
  ]);
  assert.deepEqual([r.passed, r.parentPassed, r.better, r.tied, r.regressed], [2, 2, false, true, false]);
  assert.equal(compareDryRun('v1', [{gold: ['x'], candidate: ['x'], parent: ['x']}]).tied, true);
  assert.equal(compareDryRun('v1', [{gold: ['x'], candidate: ['x'], parent: ['y']}]).better, true);
  assert.equal(compareDryRun('v1', [{gold: ['x'], candidate: ['y'], parent: ['x']}]).regressed, true);
  // Multi-select: getting one more value right is progress even with no exact match.
  const m = compareDryRun('v1', [{gold: ['a', 'b'], candidate: ['a'], parent: ['c']}]);
  assert.deepEqual([m.passed, m.parentPassed, m.better], [0, 0, true]);
});

test("helpers read the model's reason and the invalid reason; filtered answers are left out", async () => {
  const {answersForHelpers} = await import('./gepa.ts');
  const {parseOutput, REASON_LINE} = await import('./labels.ts');
  assert.match(REASON_LINE, /"reason"/);
  const named: Schema = {name: 'a', kind: 'single', values: [{name: 'x', definition: ''}, {name: 'q', definition: ''}]};
  assert.deepEqual(parseOutput('{"reason": " The clip shows steps. ", "a": "x"}', named), {answer: ['x'], reason: null, note: 'The clip shows steps.'});
  assert.deepEqual(parseOutput('{"reason": "It is new.", "a": "nope"}', named), {answer: null, reason: '"nope" isn\'t a value of a', note: 'It is new.'});
  assert.equal(parseOutput('{"a": "x"}', named).note, undefined);
  const ex = (i: number): Example => ({id: `e${i}`, snapshotId: 's', externalId: `ex-${i}`, type: 'video', title: '', features: toFeatures({Title: `t${i}`}), split: 'eval', optimiserHalf: true});
  const exs = [0, 1, 2].map(ex);
  const gold = new Map(exs.map(e => [e.id, ['x']]));
  const said = answersForHelpers([
    {exampleId: 'e0', answer: ['q'], invalidReason: null, reason: 'Looks like q.'},
    {exampleId: 'e1', answer: null, invalidReason: 'Not valid JSON'},
    {exampleId: 'e2', answer: null, invalidReason: 'Stopped by the safety filter', filtered: true},
  ]);
  const out = wrongExamples(exs, ['Title'], gold, said.predicted, undefined, said.notes);
  assert.deepEqual(out.map(e => [e.externalId, e.reason, e.invalid]), [['ex-1', undefined, 'Not valid JSON'], ['ex-0', 'Looks like q.', undefined]]);
});

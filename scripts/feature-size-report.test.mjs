import assert from 'node:assert/strict';
import test from 'node:test';
import {parseLines, report} from './feature-size-report.mjs';

test('feature size report (#32): sizes, the share above the threshold and the fields that go over it', () => {
  const small = n => ({externalId: `s${n}`, type: 'video', features: {Description: {text: 'x'.repeat(100)}}});
  const big = {externalId: 'b', type: 'video', features: {ASR: {text: 'y'.repeat(2000)}, Description: {text: 'z'}}};
  const {items, bad} = parseLines([...Array.from({length: 9}, (_, i) => JSON.stringify(small(i))), JSON.stringify(big), 'not json', ''].join('\n'));
  assert.equal(bad, 1);
  const r = report(items, 1000);
  assert.equal(r.documents, 10);
  assert.ok(r.median < 1000 && r.largest > 2000);
  assert.equal(r.shareAbove, 0.1);
  assert.deepEqual(r.fieldsOver, [{key: 'ASR', count: 1}]);
  assert.equal(r.fieldShareAbove, 1 / 11);
});

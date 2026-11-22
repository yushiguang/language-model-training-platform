import assert from 'node:assert/strict';
import test from 'node:test';
import {jobConcurrencyKey, parseConcurrencyKey} from './job-keys.ts';

test('job concurrency keys: built from the tenant and target, read back; ids that would break a key are refused', () => {
  assert.equal(jobConcurrencyKey('t1', {kind: 'model', endpointId: 'm7'}), 'model:t1:m7');
  assert.equal(jobConcurrencyKey('t1', {kind: 'compute'}), 'compute:t1');
  assert.deepEqual(parseConcurrencyKey('model:t1:m7'), {tenantId: 't1', target: {kind: 'model', endpointId: 'm7'}});
  assert.deepEqual(parseConcurrencyKey('model:t1:a:b'), {tenantId: 't1', target: {kind: 'model', endpointId: 'a:b'}}, 'an endpoint id may hold a colon');
  assert.deepEqual(parseConcurrencyKey('compute:t1'), {tenantId: 't1', target: {kind: 'compute'}});
  for (const bad of ['compute:', 'compute:t1:x', 'model:t1', 'model::m7', 'gpt-5.x', '']) assert.equal(parseConcurrencyKey(bad), null, bad);
  assert.throws(() => jobConcurrencyKey('a:b', {kind: 'compute'}), /no ':'/);
  assert.throws(() => jobConcurrencyKey('', {kind: 'compute'}));
  assert.throws(() => jobConcurrencyKey('t1', {kind: 'model', endpointId: ''}));
});

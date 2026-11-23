import assert from 'node:assert/strict';
import test from 'node:test';
import type {ObjectStorePort} from '@yushiguang/sprint-contracts';
import {memoryObjectStore} from './object-store.ts';

/**
 * The object store's rules (`ObjectStorePort`, docs/design/server.md 6), written against the port
 * so that a deployment's store (S3-compatible) can run the same cases: copy `objectStoreCases` and
 * call it with a factory of that store. Each case gets a fresh store (or a fresh key prefix).
 */
export function objectStoreCases(name: string, make: () => ObjectStorePort | Promise<ObjectStorePort>) {
  const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

  test(`${name}: a string is stored as UTF-8 and read back whole`, async () => {
    const s = await make();
    assert.deepEqual(await s.put('t/a.jsonl', '{"a":"é"}\n'), {key: 't/a.jsonl', size: 11}, 'size in bytes, not characters');
    assert.equal(text(await s.get('t/a.jsonl')), '{"a":"é"}\n');
    assert.equal(await s.get('t/missing'), null);
  });

  test(`${name}: bytes are stored as given, and a put replaces the object`, async () => {
    const s = await make();
    await s.put('t/b.bin', new Uint8Array([1, 2, 3]), {contentType: 'application/octet-stream'});
    assert.deepEqual([...(await s.get('t/b.bin'))!], [1, 2, 3]);
    await s.put('t/b.bin', new Uint8Array([9]));
    assert.deepEqual([...(await s.get('t/b.bin'))!], [9]);
  });

  test(`${name}: a range reads those bytes, cut at the end; past the end is empty`, async () => {
    const s = await make();
    await s.put('t/r.jsonl', 'line-one\nline-two\n');
    assert.equal(text(await s.getRange('t/r.jsonl', 9, 9)), 'line-two\n');
    assert.equal(text(await s.getRange('t/r.jsonl', 14, 100)), 'two\n', 'cut at the end');
    assert.equal(text(await s.getRange('t/r.jsonl', 18, 4)), '', 'at the end');
    assert.equal(text(await s.getRange('t/r.jsonl', 40, 4)), '', 'past the end');
    assert.equal(text(await s.getRange('t/r.jsonl', 0, 0)), '');
    assert.equal(await s.getRange('t/missing', 0, 4), null);
    await assert.rejects(s.getRange('t/r.jsonl', -1, 4));
    await assert.rejects(s.getRange('t/r.jsonl', 0, -4));
  });

  test(`${name}: what a read returns is a copy`, async () => {
    const s = await make();
    const body = new Uint8Array([1, 2]);
    await s.put('t/c.bin', body);
    body[0] = 7;
    (await s.get('t/c.bin'))![1] = 7;
    assert.deepEqual([...(await s.get('t/c.bin'))!], [1, 2]);
  });

  test(`${name}: delete skips a missing key; deleteBatch counts the ones that existed`, async () => {
    const s = await make();
    await s.delete('t/never');
    await s.put('t/d1', 'a');
    await s.put('t/d2', 'b');
    await s.put('t/d3', 'c');
    await s.delete('t/d3');
    assert.equal(await s.get('t/d3'), null);
    assert.equal(await s.deleteBatch(['t/d1', 't/d2', 't/d2', 't/never']), 2);
    assert.equal(await s.get('t/d1'), null);
    assert.equal(await s.deleteBatch([]), 0);
  });
}

objectStoreCases('memoryObjectStore', memoryObjectStore);

test('memoryObjectStore lists its keys for tests', async () => {
  const s = memoryObjectStore();
  await s.put('b', 'x');
  await s.put('a', 'y');
  assert.deepEqual(s.keys(), ['a', 'b']);
});

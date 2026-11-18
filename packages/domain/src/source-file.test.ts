import assert from 'node:assert/strict';
import test from 'node:test';
import {MAX_SOURCE_FILE_ROWS, readItemIdFile, seededShuffle} from './source-file.ts';

test('data source files (#29): one item id per row in CSV, TXT or JSONL; bad rows and repeats are counted', () => {
  assert.deepEqual(readItemIdFile('a.txt', 'item_id\nv1\n\nv2\nv1\nno spaces allowed\n'), {ids: ['v1', 'v2'], rows: 4, bad: 1, repeats: 1});
  assert.deepEqual(readItemIdFile('a.csv', 'creator,item_id\nx,"v1"\ny,\nz,v2\n'), {ids: ['v1', 'v2'], rows: 3, bad: 1, repeats: 0});
  assert.deepEqual(readItemIdFile('a.csv', 'v1\nv2\n'), {ids: ['v1', 'v2'], rows: 2, bad: 0, repeats: 0}, 'one column needs no header');
  assert.deepEqual(readItemIdFile('a.jsonl', '{"item_id":"v1"}\n"v2"\nnot json\n{"other":1}\n{"id":7}\n'), {ids: ['v1', 'v2', '7'], rows: 5, bad: 2, repeats: 0});
  assert.match((readItemIdFile('a.csv', 'creator,title\nx,y') as {error: string}).error, /item_id column/);
  assert.match((readItemIdFile('a.xlsx', 'v1') as {error: string}).error, /CSV, JSONL or TXT/);
  assert.match((readItemIdFile('a.txt', '\n\n') as {error: string}).error, /No item IDs/);
  assert.match((readItemIdFile('a.txt', Array.from({length: MAX_SOURCE_FILE_ROWS + 1}, (_, i) => `v${i}`).join('\n')) as {error: string}).error, /more than 100,000 rows/);
});

test('seeded shuffle (#30): the same seed gives the same order, another seed another; nothing is lost', () => {
  const ids = Array.from({length: 50}, (_, i) => `v${i}`);
  const a = seededShuffle(ids, 'seed_1');
  assert.deepEqual(a, seededShuffle(ids, 'seed_1'));
  assert.notDeepEqual(a, seededShuffle(ids, 'seed_2'));
  assert.notDeepEqual(a, ids);
  assert.deepEqual([...a].sort(), [...ids].sort());
});

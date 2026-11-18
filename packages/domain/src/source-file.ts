import {csvCells} from './label-file.ts';
import {hashString} from './template.ts';

/**
 * Data sources (#29, #30): reading a file of item ids, and the order a source hands its items out
 * in. Pure: the workflow stores what these decide.
 */

/** The most rows one data source file may have. */
export const MAX_SOURCE_FILE_ROWS = 100_000;

const ID_KEYS = ['item_id', 'id', 'external_id', 'externalid', 'video_id'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A JSONL object's id: the first id key it has, in the order of `ID_KEYS`, in any case. */
function idOf(o: Record<string, unknown>): unknown {
  const keys = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
  for (const k of ID_KEYS) if (keys.has(k)) return o[keys.get(k)!];
  return undefined;
}

/**
 * One file's ids, in file order. `rows`: the rows read (a header and blank lines are not rows);
 * `bad`: rows with no usable id; `repeats`: rows whose id came earlier in the same file.
 */
export type ItemIdFile = {ids: string[]; rows: number; bad: number; repeats: number} | {error: string};

/**
 * Reads a data source file: one item id per row (#29).
 *
 * - TXT: one id per line; a first line that is only a header such as `item_id` is skipped.
 * - CSV: the id is the `item_id` (or `id`, `external_id`, `externalId`, `video_id`) column, in any
 *   case; the other columns are ignored. With one column and no such header, every line is an id.
 * - JSONL: `{"item_id": "..."}` per line (or any of the keys above, in any case), or a bare JSON
 *   string or number.
 */
export function readItemIdFile(name: string, text: string): ItemIdFile {
  if (!/\.(csv|txt|jsonl)$/i.test(name)) return {error: 'Upload a CSV, JSONL or TXT file of item IDs.'};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const cells: string[] = [];
  let bad = 0;
  if (/\.jsonl$/i.test(name)) {
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as unknown;
        const id = typeof o === 'string' || typeof o === 'number' ? o : o && typeof o === 'object' ? idOf(o as Record<string, unknown>) : undefined;
        if (typeof id === 'string' || typeof id === 'number') cells.push(String(id).trim());
        else bad++;
      } catch {
        bad++;
      }
    }
  } else if (/\.txt$/i.test(name)) {
    // A whole line is one id: only a line that is just an id key is a header.
    const header = ID_KEYS.includes((lines[0] ?? '').trim().toLowerCase());
    for (const line of header ? lines.slice(1) : lines) cells.push(line.trim());
  } else {
    const head = csvCells(lines[0] ?? '').map(h => h.trim().toLowerCase());
    const named = head.findIndex(h => ID_KEYS.includes(h));
    if (head.length > 1 && named === -1) return {error: 'The file needs an item_id column.'};
    const col = Math.max(0, named);
    for (const line of named === -1 ? lines : lines.slice(1)) cells.push((csvCells(line)[col] ?? '').trim());
  }
  const rows = cells.length + bad;
  if (rows > MAX_SOURCE_FILE_ROWS) return {error: 'The file has more than 100,000 rows. Split it into smaller files.'};
  const seen = new Set<string>();
  const ids: string[] = [];
  let repeats = 0;
  for (const c of cells) {
    if (!ID.test(c)) bad++;
    else if (seen.has(c)) repeats++;
    else {
      seen.add(c);
      ids.push(c);
    }
  }
  if (!ids.length) return {error: 'No item IDs in this file.'};
  return {ids, rows, bad, repeats};
}

/**
 * The ids in an order fixed by `seed` (#30): shuffled once when a file is imported, so a
 * continuous cut of a source is a fair sample even when the file was sorted (by time, by creator).
 * The same seed always gives the same order.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  let s = parseInt(hashString(seed).slice(0, 8), 16) >>> 0;
  // mulberry32
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

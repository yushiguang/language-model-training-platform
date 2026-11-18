/**
 * Reads an "Upload labels" file (#31): one row per item, the item id and its answer. Pure: the
 * workflow matches the rows to the dataset and checks the answers against the label.
 *
 * - CSV with a header: an id column (`item_id`, `id`, `external_id` or `video_id`) and an answer
 *   column (`answer`, `label`, or the label's own name). Several values in one cell are separated
 *   by `|` or `;`. Quoted cells may hold commas and doubled quotes.
 * - JSONL (or `.json` with one object per line): `{"item_id": "...", "answer": "Value" | ["V1", "V2"]}`;
 *   the id may also be `externalId`, `id` or `video_id`, and the answer `label`, the label's name,
 *   or `{"<label>": ...}`.
 *
 * Rows are numbered from 1 as a person counts lines in the file (a CSV header is row 1).
 */

export interface LabelFileRow {
  row: number;
  externalId: string;
  answer: unknown;
}

export type LabelFile = {rows: LabelFileRow[]; bad: {row: number; reason: string}[]} | {error: string};

const ID_KEYS = ['item_id', 'id', 'external_id', 'externalid', 'video_id'];

/** Splits one CSV line into cells: commas outside quotes, `""` inside quotes is a quote. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out.map(s => s.trim());
}

export function readLabelFile(name: string, text: string, labelName: string): LabelFile {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const rows: LabelFileRow[] = [];
  const bad: {row: number; reason: string}[] = [];
  if (/\.csv$/i.test(name)) {
    const head = csvCells(lines[0] ?? '').map(h => h.toLowerCase());
    const idCol = head.findIndex(h => ID_KEYS.includes(h));
    const ansCol = head.findIndex(h => h === 'answer' || h === 'label' || h === labelName.toLowerCase());
    if (idCol === -1 || ansCol === -1) return {error: 'The file needs an item_id column and an answer column.'};
    lines.slice(1).forEach((line, i) => {
      if (!line.trim()) return;
      const cells = csvCells(line);
      const id = cells[idCol] ?? '';
      const values = (cells[ansCol] ?? '')
        .split(/[|;]/)
        .map(v => v.trim())
        .filter(Boolean);
      if (!id) bad.push({row: i + 2, reason: 'The row has no item id'});
      else rows.push({row: i + 2, externalId: id, answer: values.length === 1 ? values[0] : values});
    });
    return {rows, bad};
  }
  if (/\.(jsonl|json)$/i.test(name)) {
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        bad.push({row: i + 1, reason: 'The row is not valid JSON'});
        return;
      }
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        bad.push({row: i + 1, reason: 'The row is not an object'});
        return;
      }
      const idKey = Object.keys(o).find(k => ID_KEYS.includes(k.toLowerCase()));
      const id = idKey ? String(o[idKey] ?? '').trim() : '';
      const answer = 'answer' in o ? o.answer : 'label' in o ? o.label : labelName in o ? o[labelName] : undefined;
      if (!id) bad.push({row: i + 1, reason: 'The row has no item id'});
      else rows.push({row: i + 1, externalId: id, answer});
    });
    return {rows, bad};
  }
  return {error: "This file can't be used. Upload a CSV or JSONL file of item IDs and answers."};
}

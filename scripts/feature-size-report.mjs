#!/usr/bin/env node
/**
 * Feature size report (#32): how large the frozen features documents of a real sample would be,
 * to set `dataset.overflowFieldBytes` (a field larger than it goes to object storage).
 *
 *   node scripts/feature-size-report.mjs sample.jsonl [--threshold 100000] [--json]
 *
 * Each line of the sample is one item: `{"externalId": "...", "type": "video", "features": {...}}`
 * (a bare features object works too). Reads the file only; nothing leaves the machine. Prints the
 * document size distribution (median, p90, p99, largest), the share of documents and of fields
 * above the threshold, and the fields that most often go over it.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** The q-quantile (0..1) of sorted numbers, nearest rank. */
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : 0);

/** The report over parsed items, as data. */
export function report(items, threshold = 100_000) {
  const docs = [];
  const over = new Map();
  let fields = 0;
  let fieldsOver = 0;
  for (const item of items) {
    // A line that is not an object (null, a number) is not an item: it is left out.
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    // An item record (it has an `externalId` or a `features` key) holds its features under
    // `features`, which may be null (kept with none); anything else is a bare features object.
    const record = 'externalId' in item || 'features' in item;
    const features = record ? (item.features && typeof item.features === 'object' ? item.features : {}) : item;
    // The document as the store keeps it: the features, the item's kind and when it was fetched.
    const externalId = record ? String(item.externalId ?? '') : '';
    const doc = {id: `ds_xxxxxxxxxxxx:${externalId}`, snapshotId: 'ds_xxxxxxxxxxxx', externalId, type: record ? (item.type ?? 'video') : 'video', features, fetchedAt: '2026-01-01T00:00:00.000Z'};
    docs.push(bytes(doc));
    for (const [k, v] of Object.entries(features)) {
      fields++;
      if (bytes(v) > threshold) {
        fieldsOver++;
        over.set(k, (over.get(k) ?? 0) + 1);
      }
    }
  }
  const sorted = [...docs].sort((a, b) => a - b);
  return {
    documents: docs.length,
    threshold,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    largest: sorted.at(-1) ?? 0,
    shareAbove: docs.length ? docs.filter(n => n > threshold).length / docs.length : 0,
    fieldShareAbove: fields ? fieldsOver / fields : 0,
    fieldsOver: [...over].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({key, count})),
  };
}

/** Parses JSON lines; a line that does not parse is counted, not fatal. */
export function parseLines(text) {
  const items = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return {items, bad};
}

const kb = n => `${(n / 1000).toFixed(1)} KB`;
const pct = x => `${(x * 100).toFixed(2)}%`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--threshold');
  if (!file) {
    console.error('Usage: node scripts/feature-size-report.mjs sample.jsonl [--threshold 100000] [--json]');
    process.exit(2);
  }
  const t = args.indexOf('--threshold');
  const threshold = t >= 0 ? Number(args[t + 1]) : 100_000;
  if (!(threshold > 0)) {
    console.error('--threshold takes a number of bytes.');
    process.exit(2);
  }
  const {items, bad} = parseLines(readFileSync(file, 'utf8'));
  const r = {...report(items, threshold), badLines: bad};
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`Documents: ${r.documents}${bad ? ` (${bad} lines did not parse)` : ''}`);
    console.log(`Size: median ${kb(r.median)}, p90 ${kb(r.p90)}, p99 ${kb(r.p99)}, largest ${kb(r.largest)}`);
    console.log(`Above ${kb(threshold)}: ${pct(r.shareAbove)} of documents, ${pct(r.fieldShareAbove)} of fields`);
    for (const f of r.fieldsOver.slice(0, 10)) console.log(`  ${f.key}: over the threshold in ${f.count} documents`);
  }
}

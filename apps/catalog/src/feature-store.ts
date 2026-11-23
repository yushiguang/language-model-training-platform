import type {DocRuntime, ExampleFeatures, FeatureItem, FeatureRef, FeatureStorePort, Features, ObjectStorePort} from '@yushiguang/sprint-contracts';
import {featureDocId} from '@yushiguang/sprint-domain';
import {DocRepo, newId} from '@yushiguang/sprint-platform';

/** `in` filters accept up to 30 values per query. */
const IN_MAX = 30;

/**
 * Frozen features as one document per example (#32), read by `featureDocId`: the store when the
 * platform has no object storage, and where examples saved before it are still found.
 */
export function docFeatureStore(db: DocRuntime): FeatureStorePort {
  const repo = new DocRepo(db);
  const byIds = async (ids: string[]) => {
    const out: ExampleFeatures[] = [];
    for (let i = 0; i < ids.length; i += IN_MAX) out.push(...(await repo.find<ExampleFeatures>('example_features', {type: 'field', field: 'id', op: 'in', value: ids.slice(i, i + IN_MAX)})));
    return out;
  };
  return {
    async putBatch(_snapshotId, docs) {
      // A batch tried again after a failure on the way back writes only what is not there yet.
      const there = new Set((await byIds(docs.map(d => d.id))).map(d => d.id));
      await repo.insertMany('example_features', docs.filter(d => !there.has(d.id)));
      return Object.fromEntries(docs.map(d => [d.externalId, null]));
    },
    async getBatch(items) {
      const wanted = new Set(items.map(i => featureDocId(i.snapshotId, i.externalId)));
      return Object.fromEntries((await byIds([...wanted])).filter(d => wanted.has(d.id)).map(d => [d.id, d.features]));
    },
    async deleteBatch(items) {
      const ids = items.map(i => featureDocId(i.snapshotId, i.externalId));
      for (let i = 0; i < ids.length; i += IN_MAX) await repo.deleteWhere('example_features', {type: 'field', field: 'id', op: 'in', value: ids.slice(i, i + IN_MAX)});
    },
  };
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Frozen features in object storage (docs/design/server.md 6): each batch is one segment file,
 * `features/<snapshotId>/<segment>.jsonl`, one `ExampleFeatures` per line; each example keeps the
 * line's byte range (`featureRef`). Reading a batch reads each segment once, as one range from
 * its first wanted line to its last. Items without a `featureRef` (saved before) go to `legacy`.
 */
export function objectFeatureStore(objects: ObjectStorePort, legacy: FeatureStorePort): FeatureStorePort {
  return {
    async putBatch(snapshotId, docs) {
      if (!docs.length) return {};
      const key = `features/${snapshotId}/${newId('seg')}.jsonl`;
      const refs: Record<string, FeatureRef> = {};
      const lines: Uint8Array[] = [];
      let offset = 0;
      for (const d of docs) {
        const line = utf8.encode(`${JSON.stringify(d)}\n`);
        refs[d.externalId] = {key, offset, length: line.length};
        lines.push(line);
        offset += line.length;
      }
      const body = new Uint8Array(offset);
      let at = 0;
      for (const l of lines) {
        body.set(l, at);
        at += l.length;
      }
      await objects.put(key, body, {contentType: 'application/x-ndjson'});
      return refs;
    },

    async getBatch(items) {
      const old = items.filter(i => !i.featureRef);
      const bySegment = new Map<string, FeatureRef[]>();
      for (const i of items) if (i.featureRef) bySegment.set(i.featureRef.key, [...(bySegment.get(i.featureRef.key) ?? []), i.featureRef]);
      const out: Record<string, Features> = old.length ? await legacy.getBatch(old) : {};
      await Promise.all(
        [...bySegment].map(async ([key, refs]) => {
          const start = Math.min(...refs.map(r => r.offset));
          const end = Math.max(...refs.map(r => r.offset + r.length));
          const span = await objects.getRange(key, start, end - start);
          if (!span) return;
          for (const r of refs) {
            const bytes = span.subarray(r.offset - start, r.offset - start + r.length);
            if (bytes.length !== r.length) continue;
            const doc = JSON.parse(fromUtf8.decode(bytes)) as ExampleFeatures;
            out[featureDocId(doc.snapshotId, doc.externalId)] = doc.features;
          }
        }),
      );
      return out;
    },

    /** Removes the segment files these items are in, whole: a dataset's features go together. */
    async deleteBatch(items) {
      const keys = [...new Set(items.flatMap(i => (i.featureRef ? [i.featureRef.key] : [])))];
      if (keys.length) await objects.deleteBatch(keys);
      const old = items.filter(i => !i.featureRef);
      if (old.length) await legacy.deleteBatch(old);
    },
  };
}

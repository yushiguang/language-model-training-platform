import type {ObjectStorePort} from '@yushiguang/sprint-contracts';

const utf8 = new TextEncoder();

/**
 * The object-storage stand-in: objects in a map in this process. Right for tests and one process;
 * a server deployment backs `ObjectStorePort` with S3-compatible storage. Reads return copies, so
 * code never counts on sharing bytes with the store.
 */
export function memoryObjectStore(): ObjectStorePort & {keys(): string[]} {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      const bytes = typeof body === 'string' ? utf8.encode(body) : body.slice();
      objects.set(key, bytes);
      return {key, size: bytes.length};
    },
    async get(key) {
      return objects.get(key)?.slice() ?? null;
    },
    async getRange(key, offset, length) {
      if (offset < 0 || length < 0 || !Number.isFinite(offset) || !Number.isFinite(length)) throw new RangeError(`A byte range needs a non-negative offset and length (got ${offset}, ${length}).`);
      const bytes = objects.get(key);
      return bytes ? bytes.slice(offset, offset + length) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async deleteBatch(keys) {
      for (const k of keys) objects.delete(k);
    },
    /** The stored keys, for tests that check nothing is left behind. */
    keys: () => [...objects.keys()].sort(),
  };
}

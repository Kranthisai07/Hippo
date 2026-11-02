import type { R2BucketLike } from "../src/r2";

// A fake of the R2 binding that behaves as docs/VERIFIED.md 10.15 says: get gives null for a missing key, put takes bytes
// or a string, delete takes one key or up to 1000.
export function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const deleteCalls: number[] = [];
  const bucket: R2BucketLike = {
    async get(key) {
      const v = objects.get(key);
      return v
        ? {
            arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
            text: async () => new TextDecoder().decode(v),
          }
        : null;
    },
    async put(key, value) {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length > 1000) throw new Error("fake: more than 1000 keys");
      deleteCalls.push(list.length);
      for (const k of list) objects.delete(k);
    },
  };
  return { bucket, objects, deleteCalls };
}

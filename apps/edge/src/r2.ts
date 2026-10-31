import type { ObjectStore } from "../../api/src/api/storage";
import type { IndexStore } from "../../api/src/api/fixtureIngest";

// Object storage and the clause index on a Cloudflare R2 bucket. The method names and shapes below are the ones in
// docs/VERIFIED.md 10.15 (checked against developers.cloudflare.com): `get` gives null for a missing key, `put` takes a
// Uint8Array or a string, and `delete` takes up to 1000 keys per call.

/** The part of an R2 bucket binding used here. `get` is called without options, so it gives a body or null. */
export interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
  put(key: string, value: Uint8Array | string): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

const R2_DELETE_MAX = 1000;

export function createR2ObjectStore(bucket: R2BucketLike): ObjectStore {
  return {
    async put(key, bytes) {
      await bucket.put(key, bytes);
    },
    async get(key) {
      const found = await bucket.get(key);
      return found ? new Uint8Array(await found.arrayBuffer()) : null;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += R2_DELETE_MAX) await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
    },
  };
}

/** A household id is ours (hh_ plus a hash), but it ends up in a key, so anything else is refused. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const indexKey = (householdId: string): string => {
  if (!SAFE_ID.test(householdId)) throw new Error("household id is not usable in an object key");
  return `index/${householdId}.json`;
};

/**
 * The serialized clause index of a household, one object each. shortcut: a whole object is written per change, and R2
 * allows one write a second to the same key (docs/VERIFIED.md 10), which the 30 saves an hour limit keeps far below.
 */
export function createR2IndexStore(bucket: R2BucketLike): IndexStore {
  return {
    async load(householdId) {
      const found = await bucket.get(indexKey(householdId));
      return found ? found.text() : null;
    },
    async put(householdId, serialized) {
      await bucket.put(indexKey(householdId), serialized);
    },
  };
}

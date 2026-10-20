import type { Repository } from "core/src/contracts";
import { loadIndex, type ClauseIndex } from "core/src/retrieval";

/** Where the serialized clause index of a household lives (S3 in production, a Map in the demo). */
export interface IndexSource {
  load(householdId: string): Promise<string | null>;
}

export function createMemoryIndexSource(): IndexSource & { put(householdId: string, serialized: string): void } {
  const blobs = new Map<string, string>();
  return {
    put: (householdId, serialized) => void blobs.set(householdId, serialized),
    load: async (householdId) => blobs.get(householdId) ?? null,
  };
}

interface Entry {
  version: string;
  index: ClauseIndex | null;
}

export interface IndexCache {
  /** The household's clause index, or null when it has no documents. Reloaded only when the index version changes. */
  get(repo: Repository, householdId: string): Promise<ClauseIndex | null>;
  /** How many times an index was loaded from its source (for tests and logs). */
  readonly loads: number;
}

/**
 * Cache keyed by household and index version. The version is read from the repository on every call (one small read
 * per document), the index itself is only deserialized when that version changes, so a warm process does not rebuild.
 */
export function createIndexCache(source: IndexSource): IndexCache {
  const entries = new Map<string, Entry>();
  let loads = 0;

  async function versionOf(repo: Repository, householdId: string): Promise<string> {
    const docs = await repo.listDocs(householdId, { status: "active" });
    const metas = await Promise.all(docs.map((d) => repo.getChunkMeta(householdId, d.id)));
    return metas
      .flatMap((m) => (m ? [`${m.docId}@${m.indexVersion}`] : []))
      .sort()
      .join(",");
  }

  return {
    get loads() {
      return loads;
    },
    async get(repo, householdId) {
      const version = await versionOf(repo, householdId);
      const hit = entries.get(householdId);
      if (hit && hit.version === version) return hit.index;
      if (version === "") {
        entries.set(householdId, { version, index: null });
        return null;
      }
      const serialized = await source.load(householdId);
      loads++;
      const index = serialized ? loadIndex(serialized) : null;
      entries.set(householdId, { version, index });
      return index;
    },
  };
}

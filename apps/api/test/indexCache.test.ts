import { chunkPages, buildIndex, searchIndex, serializeIndex } from "core/src/retrieval";
import { createMemoryRepository } from "core/src/repository";
import { describe, expect, it } from "vitest";
import { createIndexCache, createMemoryIndexSource } from "../src/mcp/indexCache";
import { A, B, seeded } from "./helpers";

const doc = (id: string) => ({
  id,
  s3Key: "x",
  filename: `${id}.pdf`,
  docType: "warranty" as const,
  status: "active" as const,
  uploadedAt: "2026-10-21T00:00:00.000Z",
  assetIds: [],
});

describe("index cache", () => {
  it("loads the household index once and serves later calls from memory", async () => {
    const { repo, indexSource } = await seeded();
    let loads = 0;
    const cache = createIndexCache({ load: (h) => (loads++, indexSource.load(h)) });
    const first = await cache.get(repo, A);
    const second = await cache.get(repo, A);
    const third = await cache.get(repo, A);
    expect(loads).toBe(1);
    expect(cache.loads).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first!.chunks.size).toBeGreaterThan(10);
  });

  it("rebuilds when the index version of a document changes", async () => {
    const { repo, indexSource } = await seeded();
    const cache = createIndexCache(indexSource);
    const before = await cache.get(repo, A);
    const meta = (await repo.getChunkMeta(A, "doc-lease"))!;
    await repo.putChunkMeta(A, { ...meta, indexVersion: meta.indexVersion + 1 });
    const chunks = chunkPages("doc-new", [{ page: 1, text: "Section 1. Pets\nNo pets are allowed in the building." }]);
    indexSource.put(A, serializeIndex(buildIndex([...before!.chunks.values(), ...chunks])));
    const after = await cache.get(repo, A);
    expect(cache.loads).toBe(2);
    expect(after).not.toBe(before);
    expect(searchIndex(after!, "pets allowed building", { minScore: 0 }).length).toBeGreaterThan(0);
  });

  it("rebuilds when a document is added", async () => {
    const { repo, indexSource } = await seeded();
    const cache = createIndexCache(indexSource);
    await cache.get(repo, A);
    await repo.putDoc(A, doc("doc-extra"));
    await repo.putChunkMeta(A, { docId: "doc-extra", s3Key: "x", indexVersion: 1, chunkCount: 1 });
    await cache.get(repo, A);
    expect(cache.loads).toBe(2);
  });

  it("ignores documents that are not active", async () => {
    const { repo, indexSource } = await seeded();
    const cache = createIndexCache(indexSource);
    await cache.get(repo, A);
    await repo.putDoc(A, { ...doc("doc-pending"), status: "extracting" });
    await repo.putChunkMeta(A, { docId: "doc-pending", s3Key: "x", indexVersion: 1, chunkCount: 1 });
    await cache.get(repo, A);
    expect(cache.loads).toBe(1);
  });

  it("keeps one index per household", async () => {
    const { repo, indexSource } = await seeded();
    const other = createMemoryRepository();
    await other.putDoc(B, doc("doc-b"));
    await other.putChunkMeta(B, { docId: "doc-b", s3Key: "x", indexVersion: 1, chunkCount: 1 });
    indexSource.put(
      B,
      serializeIndex(
        buildIndex(chunkPages("doc-b", [{ page: 1, text: "Section 1. Telescope\nThe telescope lens is covered." }])),
      ),
    );
    const cache = createIndexCache(indexSource);
    const a = await cache.get(repo, A);
    const b = await cache.get(other, B);
    expect(a).not.toBe(b);
    expect(b!.chunks.size).toBe(1);
    expect(await cache.get(repo, A)).toBe(a);
    expect(cache.loads).toBe(2);
  });

  it("returns null for a household with no documents and does not load anything", async () => {
    const { repo, indexSource } = await seeded();
    const cache = createIndexCache(indexSource);
    expect(await cache.get(repo, "hh_empty")).toBeNull();
    expect(cache.loads).toBe(0);
  });

  it("returns null when the source has nothing for a household that has documents", async () => {
    const repo = createMemoryRepository();
    await repo.putDoc(A, doc("doc-a"));
    await repo.putChunkMeta(A, { docId: "doc-a", s3Key: "x", indexVersion: 1, chunkCount: 1 });
    const cache = createIndexCache(createMemoryIndexSource());
    expect(await cache.get(repo, A)).toBeNull();
  });

  it("a reloaded index answers the same as the one that was built", async () => {
    const { repo, indexSource } = await seeded();
    const loaded = (await createIndexCache(indexSource).get(repo, A))!;
    const hits = searchIndex(loaded, "water damage improper installation");
    expect(hits[0]!.chunk.docId).toBe("doc-warranty_dishwasher");
    expect(hits[0]!.chunk.page).toBe(3);
  });
});

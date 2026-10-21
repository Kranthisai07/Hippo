import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRepository } from "core/src/repository";
import { createMemoryObjectStore } from "../../api/src/api/storage";
import { MODEL_ID_MISSING } from "../src/ingest/bedrock";
import { createPipelineIngest } from "../src/ingest";
import { fixtureBytes, HH, NOW } from "./ingest.helpers";

const built: string[] = [];
vi.mock("@aws-sdk/client-bedrock-runtime", async (orig) => ({
  ...(await orig<object>()),
  BedrockRuntimeClient: class {
    constructor() {
      built.push("bedrock");
    }
  },
}));
vi.mock("@aws-sdk/client-textract", async (orig) => ({
  ...(await orig<object>()),
  TextractClient: class {
    constructor() {
      built.push("textract");
    }
  },
}));

afterEach(() => {
  built.length = 0;
  vi.unstubAllGlobals();
});

describe("nothing live is called by default", () => {
  it("fixture mode builds no AWS client and never calls fetch, even for a photo", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network is off");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const repo = createMemoryRepository();
    const objectStore = createMemoryObjectStore();
    const ingest = createPipelineIngest({ repo, objectStore, now: () => NOW }, {});
    for (const [id, name] of [
      ["a", "warranty_dishwasher_photo.jpg"],
      ["b", "lease.pdf"],
    ] as const) {
      await objectStore.put(`uploads/${HH}/${id}/original`, fixtureBytes(name));
      await repo.putDoc(HH, {
        id,
        s3Key: `uploads/${HH}/${id}/original`,
        filename: name,
        docType: "other",
        status: "uploaded",
        uploadedAt: "2026-10-21T00:00:00Z",
        assetIds: [],
      });
      await ingest({ householdId: HH, docId: id });
      expect((await repo.getDoc(HH, id))?.status).toBe("needs_review");
    }
    expect(built).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the live flag without a model id refuses to start and builds nothing", () => {
    const base = { repo: createMemoryRepository(), objectStore: createMemoryObjectStore(), now: () => NOW };
    expect(() => createPipelineIngest(base, { HIPPO_LIVE_AI: "1" })).toThrow(MODEL_ID_MISSING);
    expect(built).toEqual([]);
  });

  it("only HIPPO_LIVE_AI=1 builds the clients", () => {
    const base = { repo: createMemoryRepository(), objectStore: createMemoryObjectStore(), now: () => NOW };
    createPipelineIngest(base, { HIPPO_LIVE_AI: "true", HIPPO_BEDROCK_MODEL_ID: "m" });
    expect(built).toEqual([]);
    createPipelineIngest(base, {
      HIPPO_LIVE_AI: "1",
      HIPPO_BEDROCK_MODEL_ID: "m",
      HIPPO_MAX_BEDROCK_CALLS_PER_DAY: "3",
    });
    expect(built.sort()).toEqual(["bedrock", "textract"]);
  });
});

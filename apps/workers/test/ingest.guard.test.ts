import { describe, expect, it, vi } from "vitest";
import { createMemoryRepository } from "core/src/repository";
import { createMemoryObjectStore } from "../../api/src/api/storage";
import { createPipelineIngest } from "../src/ingest";
import { NOW } from "./ingest.helpers";

// No real AWS client is ever built here.
vi.mock("@aws-sdk/client-bedrock-runtime", async (orig) => ({
  ...(await orig<object>()),
  BedrockRuntimeClient: class {},
}));
vi.mock("@aws-sdk/client-textract", async (orig) => ({ ...(await orig<object>()), TextractClient: class {} }));

// Round 3 review: an unset or unparsable HIPPO_MAX_BEDROCK_CALLS_PER_DAY meant "no limit", so a typo in the one guard
// that protects someone's money switched it off. An invalid cost guard now refuses to start.
const base = () => ({ repo: createMemoryRepository(), objectStore: createMemoryObjectStore(), now: () => NOW });
const live = (extra: Record<string, string> = {}) => ({
  HIPPO_LIVE_AI: "1",
  HIPPO_BEDROCK_MODEL_ID: "test-model-id",
  ...extra,
});

describe("the Bedrock call cap is required and must be valid in live mode", () => {
  it("refuses to start when it is not set", () => {
    expect(() => createPipelineIngest(base(), live())).toThrow(/HIPPO_MAX_BEDROCK_CALLS_PER_DAY/);
  });

  it.each(["abc", "0", "-1", "5.5", "", " ", "1e3", "0x10", "NaN", "Infinity", "３", "99999999999"])(
    "refuses to start with %j",
    (value) => {
      expect(() => createPipelineIngest(base(), live({ HIPPO_MAX_BEDROCK_CALLS_PER_DAY: value }))).toThrow(
        /HIPPO_MAX_BEDROCK_CALLS_PER_DAY/,
      );
    },
  );

  it.each(["1", "3", " 3 ", "200"])("starts with %j", (value) => {
    expect(() => createPipelineIngest(base(), live({ HIPPO_MAX_BEDROCK_CALLS_PER_DAY: value }))).not.toThrow();
  });
});

describe("the page cap", () => {
  it.each(["abc", "0", "-1", "5.5", "", "1e3"])(
    "an invalid HIPPO_MAX_PAGES %j refuses to start, in either mode",
    (value) => {
      expect(() => createPipelineIngest(base(), { HIPPO_MAX_PAGES: value })).toThrow(/HIPPO_MAX_PAGES/);
      expect(() =>
        createPipelineIngest(base(), live({ HIPPO_MAX_BEDROCK_CALLS_PER_DAY: "3", HIPPO_MAX_PAGES: value })),
      ).toThrow(/HIPPO_MAX_PAGES/);
    },
  );

  it("is optional: unset keeps the default", () => {
    expect(() => createPipelineIngest(base(), {})).not.toThrow();
    expect(() => createPipelineIngest(base(), live({ HIPPO_MAX_BEDROCK_CALLS_PER_DAY: "3" }))).not.toThrow();
  });

  it("a valid value is accepted", () => {
    expect(() => createPipelineIngest(base(), { HIPPO_MAX_PAGES: "10" })).not.toThrow();
  });
});

describe("fixture mode needs no call cap", () => {
  it("starts without any cost variable", () => {
    expect(() => createPipelineIngest(base(), {})).not.toThrow();
  });
});

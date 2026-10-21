import type { Repository } from "core/src/contracts";
import type { IndexStore, OnUploaded } from "../../../api/src/api/fixtureIngest";
import type { ObjectStore } from "../../../api/src/api/storage";
import { createBedrockExtractor, createLiveBedrockClient, MODEL_ID_MISSING } from "./bedrock";
import { createFixtureExtractor, createFixtureOcr } from "./fixtures";
import { createIngest } from "./ingest";
import { createLiveTextractClient, createTextractOcr } from "./textract";

export { createIngest, type IngestDeps } from "./ingest";
export { IngestFailure, type Extractor, type Kind } from "./types";

type Env = Record<string, string | undefined>;

export interface PipelineBase {
  repo: Repository;
  objectStore: ObjectStore;
  indexStore?: IndexStore | undefined;
  now: () => number;
  log?: (line: string) => void;
}

/**
 * The pipeline as the API's `onUploaded` hook, configured from the environment.
 *  - Default (fixture mode): OCR and the model are the demo stand-ins in ./fixtures. No network, no AWS client.
 *  - HIPPO_LIVE_AI=1: Textract and Bedrock Converse for real. Costs money and needs written permission from K.
 *    HIPPO_BEDROCK_MODEL_ID is required (no default; use an id printed in docs/VERIFIED.md 3.1), and a missing one
 *    refuses to start. HIPPO_BEDROCK_STRUCTURED=1 asks for schema constrained output (Haiku 4.5 or Sonnet 4.6 only).
 *  - HIPPO_MAX_PAGES (pages per document) and HIPPO_MAX_BEDROCK_CALLS_PER_DAY are the cost guards.
 */
export function createPipelineIngest(base: PipelineBase, env: Env): OnUploaded {
  const positive = (name: string): number | undefined => {
    const n = Number(env[name]);
    return env[name] !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const maxPages = positive("HIPPO_MAX_PAGES");
  const common = { ...base, ...(maxPages === undefined ? {} : { maxPages }) };
  if (env.HIPPO_LIVE_AI !== "1") {
    return createIngest({ ...common, ocr: createFixtureOcr(), extractor: createFixtureExtractor() });
  }
  const modelId = env.HIPPO_BEDROCK_MODEL_ID?.trim();
  if (!modelId) throw new Error(MODEL_ID_MISSING);
  const maxCallsPerDay = positive("HIPPO_MAX_BEDROCK_CALLS_PER_DAY");
  return createIngest({
    ...common,
    ocr: createTextractOcr(createLiveTextractClient(env.AWS_REGION)),
    extractor: createBedrockExtractor({
      client: createLiveBedrockClient(env.AWS_REGION),
      modelId,
      structuredOutput: env.HIPPO_BEDROCK_STRUCTURED === "1",
      ...(maxCallsPerDay === undefined ? {} : { maxCallsPerDay }),
    }),
  });
}

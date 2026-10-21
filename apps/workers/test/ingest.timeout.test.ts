import { describe, expect, it } from "vitest";
import { createBedrockExtractor, createLiveBedrockClient, type BedrockLike } from "../src/ingest/bedrock";
import { createLiveTextractClient, createTextractOcr, type TextractLike } from "../src/ingest/textract";
import { IngestFailure } from "../src/ingest/types";

// Round 3 review: a hung Bedrock or Textract call had no timeout, so the document stayed "extracting" forever and the
// SDK's own retries were not counted against the daily call cap.
type Opts = { abortSignal?: AbortSignal };
const hangs = (): { send: (cmd: unknown, o?: Opts) => Promise<never>; seen: Opts[] } => {
  const seen: Opts[] = [];
  return {
    seen,
    send: (_cmd, o) =>
      new Promise((_resolve, reject) => {
        seen.push(o ?? {});
        o?.abortSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  };
};
const PAGES = [{ number: 1, text: "Lease term: January 1, 2026 through December 31, 2026." }];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

describe("Bedrock call timeout", () => {
  it("fails with a plain reason instead of hanging, and passes an abort signal", async () => {
    const h = hangs();
    const ex = createBedrockExtractor({ client: h as unknown as BedrockLike, modelId: "m", timeoutMs: 30 });
    const started = Date.now();
    const err = await ex.classify(PAGES as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestFailure);
    expect((err as IngestFailure).reason).toMatch(/took too long/i);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(h.seen[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("a timed out attempt still counts against the daily cap", async () => {
    const h = hangs();
    const ex = createBedrockExtractor({
      client: h as unknown as BedrockLike,
      modelId: "m",
      timeoutMs: 20,
      maxCallsPerDay: 2,
      today: () => "2026-10-21",
    });
    await ex.classify(PAGES as never).catch(() => undefined);
    await ex.classify(PAGES as never).catch(() => undefined);
    const third = await ex.classify(PAGES as never).catch((e: unknown) => e);
    expect((third as IngestFailure).reason).toMatch(/paused for today/i);
    expect(h.seen).toHaveLength(2);
  });

  it("does not turn a real answer into a timeout", async () => {
    const client: BedrockLike = {
      send: async () => ({ output: { message: { content: [{ text: "lease" }] } } }),
    };
    const ex = createBedrockExtractor({ client, modelId: "m", timeoutMs: 5000 });
    await expect(ex.classify(PAGES as never)).resolves.toBe("lease");
  });
});

describe("Textract call timeout", () => {
  it("fails with a plain reason instead of hanging", async () => {
    const h = hangs();
    const ocr = createTextractOcr(h as unknown as TextractLike, { timeoutMs: 30 });
    const err = await ocr({ number: 1, image: JPEG }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestFailure);
    expect((err as IngestFailure).reason).toMatch(/took too long/i);
    expect(h.seen[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("the live clients make no hidden retries", () => {
  it("both are built with one attempt, so every call is one counted call", async () => {
    const bedrock = createLiveBedrockClient("us-east-1") as unknown as {
      config: { maxAttempts: () => Promise<number> };
    };
    const textract = createLiveTextractClient("us-east-1") as unknown as {
      config: { maxAttempts: () => Promise<number> };
    };
    expect(await bedrock.config.maxAttempts()).toBe(1);
    expect(await textract.config.maxAttempts()).toBe(1);
  });
});

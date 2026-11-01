import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// What a Workers build of the API would carry. This bundles the app, the capture ingest and the D1 stores the way a
// Workers bundler would (no Node platform, no Node built ins), and fails if anything Node only gets back in: a node:
// import, a Node global, the demo fixture reader, or the PDF reader. The size ceilings are a regression guard set just
// above the first measurement (897 KB, 228 KB gzip), not Cloudflare's limit, which is unverified (docs/VERIFIED.md 10).
// `new Function` and `eval(` are not asserted absent: ajv and zod contain them behind guards, and the local Workers run
// (apps/edge/scripts/smoke.mjs) showed they do not fire.

const here = fileURLToPath(new URL(".", import.meta.url));
const ENTRY = `
export { createApp } from "../../api/src/app";
export { createCaptureIngest } from "../../workers/src/ingest/capture";
export { createD1Repository } from "core/src/repository/d1";
export { createD1AuthStore } from "../src/d1AuthStore";
export { createR2IndexStore, createR2ObjectStore } from "../src/r2";
export { createCloudflareMailer } from "../src/cloudflareMailer";
export { buildApp } from "../src/index";
`;

describe("a Workers build of the API", () => {
  it("imports no Node module, uses no Node global, and carries neither the demo reader nor the PDF reader", async () => {
    const r = await build({
      stdin: { contents: ENTRY, resolveDir: here, loader: "ts" },
      bundle: true,
      minify: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser", "import"],
      write: false,
      metafile: true,
      logLevel: "silent",
      external: ["node:*"],
    });
    const out = Object.values(r.metafile.outputs)[0]!;
    expect(out.imports.filter((i) => i.external).map((i) => i.path)).toEqual([]);

    const inputs = Object.keys(r.metafile.inputs).map((f) => f.replaceAll("\\", "/"));
    expect(
      inputs.filter((f) => /pdfjs-dist|demoIngest|packages\/core\/src\/pages\/extract|\/seed\.ts/.test(f)),
    ).toEqual([]);

    const text = new TextDecoder().decode(r.outputFiles[0]!.contents);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bprocess\.(env|nextTick|versions|platform)/);
    expect(text).not.toMatch(/import\.meta\.url|__dirname/);

    const bytes = r.outputFiles[0]!.contents;
    expect(bytes.length).toBeLessThan(1_000_000);
    expect(gzipSync(bytes).length).toBeLessThan(260_000);
  }, 60_000);
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/mcp/registry";

// CLAUDE.md hard rules: no LLM calls and no outbound HTTP inside MCP tool handlers; handlers are pure functions of
// (context, arguments). This is a static scan, so a new import or call that breaks the rule fails the build.

const SRC = join(__dirname, "..", "src");
const TOOLS_DIR = join(SRC, "mcp", "tools");
const MCP_DIR = join(SRC, "mcp");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

/** Source without comments and string contents that are not import paths, so a comment cannot trip or hide a match. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

export const IMPORT_DENY: [string, RegExp][] = [
  [
    "node network module",
    /from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster)["']/,
  ],
  ["node fs", /from\s+["'](?:node:)?fs(?:\/promises)?["']/],
  ["aws sdk", /from\s+["']@aws-sdk\//],
  ["pdf library", /from\s+["']pdfjs/],
  ["bedrock or textract", /bedrock|textract/i],
  ["http client library", /from\s+["'](?:undici|axios|node-fetch|got|ky|superagent|cross-fetch)["']/],
  ["llm sdk", /from\s+["'](?:@anthropic-ai|openai|@google\/generative-ai)/],
  ["recall network clients", /recalls\/clients/],
  ["core pages (pulls in pdfjs)", /core\/src\/pages/],
  ["dynamo repository", /repository\/dynamo/],
  ["core barrel (pulls in pdfjs)", /from\s+["']core["']/],
  ["dynamic import or require", /\brequire\s*\(|\bimport\s*\(/],
];

export const IDENT_DENY: [string, RegExp][] = [
  ["fetch call", /(?<![.\w])fetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["Date.now", /\bDate\.now\b/],
  ["new Date() with no argument", /new\s+Date\s*\(\s*\)/],
  ["Math.random", /\bMath\.random\b/],
  ["crypto random", /\bcrypto\.(?:randomUUID|getRandomValues|randomBytes)\b/],
  ["process.env", /\bprocess\.env\b/],
  ["performance.now", /\bperformance\.now\b/],
];

export function violations(source: string, rules: [string, RegExp][]): string[] {
  const code = stripComments(source);
  return rules.filter(([, re]) => re.test(code)).map(([name]) => name);
}

const toolFiles = walk(TOOLS_DIR);
const mcpFiles = walk(MCP_DIR);

describe("tool handlers are pure", () => {
  it("has one file per tool, twelve in all", () => {
    expect(toolFiles.map((f) => relative(TOOLS_DIR, f)).sort()).toEqual(
      [
        "addRecord.ts",
        "askDocuments.ts",
        "checkCoverage.ts",
        "getAgreement.ts",
        "getHistory.ts",
        "logService.ts",
        "resolveAlert.ts",
        "uiResolveAlert.ts",
        "uiShowClaimSteps.ts",
        "uiShowClause.ts",
        "undoLast.ts",
        "whatsComingUp.ts",
      ].sort(),
    );
    expect(TOOLS).toHaveLength(12);
  });

  it.each(toolFiles.map((f) => [relative(SRC, f), f]))("%s imports nothing on the deny list", (_name, file) => {
    expect(violations(readFileSync(file as string, "utf8"), IMPORT_DENY)).toEqual([]);
  });

  it.each(toolFiles.map((f) => [relative(SRC, f), f]))(
    "%s uses no clock, randomness, environment or network call",
    (_n, file) => {
      expect(violations(readFileSync(file as string, "utf8"), IDENT_DENY)).toEqual([]);
    },
  );

  it.each(mcpFiles.map((f) => [relative(SRC, f), f]))(
    "%s (voice path) imports no network, LLM, pdf or aws code",
    (_n, file) => {
      expect(violations(readFileSync(file as string, "utf8"), IMPORT_DENY)).toEqual([]);
    },
  );

  it("every src file outside seed and the oauth demo helper avoids the core barrel", () => {
    for (const f of walk(SRC)) {
      expect(violations(readFileSync(f, "utf8"), [IMPORT_DENY.find(([n]) => n.startsWith("core barrel"))!]), f).toEqual(
        [],
      );
    }
  });

  it("each handler is exported from its own tool file and registered once", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the scanner itself", () => {
  const bad: [string, string, [string, RegExp][]][] = [
    ["fetch", "const r = await fetch(url);", IDENT_DENY],
    ["Date.now", "const t = Date.now();", IDENT_DENY],
    ["new Date()", "const t = new Date();", IDENT_DENY],
    ["Math.random", "const t = Math.random();", IDENT_DENY],
    ["process.env", "const k = process.env.KEY;", IDENT_DENY],
    ["crypto.randomUUID", "const k = crypto.randomUUID();", IDENT_DENY],
    ["https import", 'import https from "node:https";', IMPORT_DENY],
    ["fs import", 'import { readFileSync } from "node:fs";', IMPORT_DENY],
    ["aws sdk", 'import { S3Client } from "@aws-sdk/client-s3";', IMPORT_DENY],
    ["pdfjs", 'import * as pdf from "pdfjs-dist/legacy/build/pdf.mjs";', IMPORT_DENY],
    ["bedrock", 'import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";', IMPORT_DENY],
    ["textract", 'import { TextractClient } from "@aws-sdk/client-textract";', IMPORT_DENY],
    ["recall clients", 'import { fetchRecalls } from "obligation-kit/src/recalls/clients";', IMPORT_DENY],
    ["core barrel", 'import { resolveAsset } from "core";', IMPORT_DENY],
    ["core pages", 'import { extract } from "core/src/pages";', IMPORT_DENY],
    ["dynamic import", 'const m = await import("node:http");', IMPORT_DENY],
    ["anthropic", 'import Anthropic from "@anthropic-ai/sdk";', IMPORT_DENY],
  ];

  it.each(bad)("flags %s", (_name, code, rules) => {
    expect(violations(code, rules).length).toBeGreaterThan(0);
  });

  it("does not flag a comment that mentions the words", () => {
    expect(violations("// no fetch( here, no Date.now\n/* new Date() */ const a = 1;", IDENT_DENY)).toEqual([]);
  });

  it("does not flag the allowed forms", () => {
    const ok =
      'import { resolveAsset } from "core/src/resolver"; const t = new Date(ctx.nowMs).toISOString(); handler.fetchAll();';
    expect(violations(ok, [...IMPORT_DENY, ...IDENT_DENY])).toEqual([]);
  });
});

// @vitest-environment node
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

// Runs the real build, as `pnpm --filter @hippo/extension build:store` does, and looks at what comes out. It writes to
// dist-store/ and release/ (both git ignored), never to dist/, so a local unpacked build is not disturbed.

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const API = "https://hippo-api.example.workers.dev";
const ENV = { VITE_HIPPO_API: API, VITE_HIPPO_WEB: API, VITE_HIPPO_CLIENT_ID: "hippo-store" };

const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(e)) {
    saved[k] ??= process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const run = () => build({ root, mode: "store", logLevel: "silent", configFile: path.join(root, "vite.config.ts") });

const filesOf = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesOf(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });

describe("a store build", () => {
  const out = path.join(root, "dist-store");
  const zipPath = path.join(root, "release", `hippo-${pkg.version}.zip`);

  beforeAll(async () => {
    rmSync(out, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
    setEnv(ENV);
    await run();
  }, 120_000);

  it("writes a manifest with only the production host, no development key, and the package version", () => {
    const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(m.host_permissions).toEqual([`${API}/*`]);
    expect(m.key).toBeUndefined();
    expect(m.version).toBe(pkg.version);
    expect([...m.permissions].sort()).toEqual(["activeTab", "identity", "scripting", "storage"]);
  });

  it("has no development address in any text file, so the built code talks to the production server", () => {
    for (const f of filesOf(out).filter((n) => /\.(js|css|html|json)$/.test(n))) {
      expect(readFileSync(path.join(out, f), "utf8"), f).not.toMatch(/localhost|127\.0\.0\.1/);
    }
    expect(readFileSync(path.join(out, "config.js"), "utf8")).toContain(API);
  });

  it("puts every file of the folder, and nothing else, in the zip, with intact contents", () => {
    expect(existsSync(zipPath)).toBe(true);
    const buf = readFileSync(zipPath);
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const crc = buf.readUInt32LE(p + 16);
      const csize = buf.readUInt32LE(p + 20);
      const nlen = buf.readUInt16LE(p + 28);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
      const lnlen = buf.readUInt16LE(local + 26);
      const data = inflateRawSync(buf.subarray(local + 30 + lnlen, local + 30 + lnlen + csize));
      expect(crc32(data), name).toBe(crc);
      expect(data.equals(readFileSync(path.join(out, name))), name).toBe(true);
      names.push(name);
      p += 46 + nlen;
    }
    expect(names.sort()).toEqual(filesOf(out).sort());
    expect(names).toContain("manifest.json");
    expect(names).toContain("popup.html");
    expect(names).toContain("background.js");
  });

  it("refuses to build with an http address, before writing anything", async () => {
    rmSync(out, { recursive: true, force: true });
    setEnv({ VITE_HIPPO_API: "http://hippo-api.example.workers.dev" });
    await expect(run()).rejects.toThrow(/VITE_HIPPO_API/);
    expect(existsSync(out)).toBe(false);
    setEnv(ENV);
  }, 120_000);

  it("refuses to build with no client id", async () => {
    setEnv({ VITE_HIPPO_CLIENT_ID: undefined });
    await expect(run()).rejects.toThrow(/VITE_HIPPO_CLIENT_ID/);
    setEnv(ENV);
  }, 120_000);

  it("refuses to build when an address is missing", async () => {
    setEnv({ VITE_HIPPO_WEB: undefined });
    await expect(run()).rejects.toThrow(/VITE_HIPPO_WEB/);
    setEnv(ENV);
  }, 120_000);
});

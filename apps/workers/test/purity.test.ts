import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src", "daily");
const TESTS = __dirname;
const files = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
// Strip comments so a comment that talks about the clock does not trip the check.
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const logic = files(SRC).filter(([f]) => f !== "cli.ts");

describe("the clock and the network are injected", () => {
  it.each(logic)("%s does not read the real clock, random numbers or global fetch", (_f, src) => {
    const c = code(src);
    expect(c).not.toMatch(/Date\.now\s*\(/);
    expect(c).not.toMatch(/new Date\s*\(\s*\)/);
    expect(c).not.toMatch(/Math\.random/);
    expect(c).not.toMatch(/\bperformance\.now/);
    expect(c).not.toMatch(/(^|[^.\w])fetch\s*\(/m);
    expect(c).not.toMatch(/setTimeout/);
  });

  it("cli.ts is the only file that reads the real clock", () => {
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    expect(cli).toMatch(/Date\.now/);
  });

  it("only the digest step calls the sender", () => {
    for (const [f, src] of logic)
      if (f !== "digest.ts" && f !== "types.ts") expect(code(src), f).not.toMatch(/\.send\s*\(/);
  });

  it("only the recall step imports the network clients, by deep path", () => {
    for (const [f, src] of logic) {
      const uses = /recalls\/clients/.test(code(src)) || /from "obligation-kit\/src\/recalls\/clients"/.test(src);
      if (f === "recalls.ts" || f === "types.ts" || f === "recorded.ts") continue;
      expect(uses, f).toBe(false);
    }
    expect(readFileSync(join(SRC, "recalls.ts"), "utf8")).toContain('from "obligation-kit/src/recalls/clients"');
  });

  it("no LLM client and no AWS SDK in the job", () => {
    for (const [f, src] of logic) expect(src, f).not.toMatch(/@aws-sdk|anthropic|bedrock/i);
  });
});

describe("prose rules", () => {
  it.each([...files(SRC), ...files(TESTS)])("%s has no em or en dash", (_f, src) => {
    expect(src).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});

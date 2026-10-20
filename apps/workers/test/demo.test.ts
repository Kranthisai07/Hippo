import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport } from "../src/daily/format";
import { A, ANCHOR, makeWorld } from "./helpers";

describe("demo household at 2026-10-21", () => {
  it("prints a plain report with counts, recall requests and the email outcome", async () => {
    const w = await makeWorld();
    const out = formatReport(await w.run(ANCHOR, { sender: undefined }));
    expect(out).toContain("Hippo daily run for 2026-10-21");
    expect(out).toContain("requests: CPSC 1, NHTSA 2 of 20");
    expect(out).toContain(`household ${A}`);
    expect(out).toContain("obligations computed: 9");
    expect(out).toContain("deadline alerts: 7 created");
    expect(out).toContain("recall alerts created: 5");
    expect(out).toContain("email: skipped, dry_run");
  });

  it("the report holds no document text beyond the digest preview", async () => {
    const w = await makeWorld();
    const r = await w.run();
    expect(JSON.stringify(r.households[0]!.errors)).toBe("[]");
    expect(JSON.stringify(r)).not.toMatch(/\d{9,}/);
  });

  it("the cap line is printed when it was hit", async () => {
    const w = await makeWorld({ config: { maxNhtsaRequests: 1 } });
    expect(formatReport(await w.run(ANCHOR, { sender: undefined }))).toContain("CAP REACHED");
  });

  it("pnpm daily:run (the CLI, dry run, recorded fixtures) prints the expected digest", () => {
    const cwd = join(__dirname, "..");
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/daily/cli.ts", "--today", ANCHOR], {
      cwd,
      encoding: "utf8",
    });
    expect(out).toContain("recalls: recorded fixtures; email: dry run");
    expect(out).toContain("email: skipped, dry_run");
    expect(out).toContain("Subject: Hippo: Several things need you");
    expect(out).toMatch(/Lease notice deadline\n\s+\|\s+Due Nov 1, 11 days from now/);
    expect(out).toMatch(/Kestrel Learning cancel-by date\n\s+\|\s+Due Oct 26, 5 days from now/);
    expect(out).toMatch(/Car insurance renews\n\s+\|\s+Due Oct 30, 9 days from now/);
    expect(out).toContain("may affect your car");
    expect(out).not.toContain("console sender");
  }, 60_000);

  it("--send goes through the console sender only and prints that it sent", () => {
    const cwd = join(__dirname, "..");
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/daily/cli.ts", "--today", ANCHOR, "--send"], {
      cwd,
      encoding: "utf8",
    });
    expect(out).toContain("[console sender] to demo@example.com: Hippo: Several things need you");
    expect(out).toContain("email: sent (10 alerts)");
  }, 60_000);
});

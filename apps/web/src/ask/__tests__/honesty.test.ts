import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Decision D-054 says the /ask page states, on the page itself, that its cards are plain React and not the MCP Apps host
// bridge. The round 3 review found the footer did not say so. This keeps the promise from quietly disappearing.
describe("the /ask page says what its cards are", () => {
  // vitest runs from the package directory (apps/web); import.meta.url is not a file URL under jsdom.
  const page = readFileSync(join(process.cwd(), "src/ask/AskPage.tsx"), "utf8");

  it("names plain React and says it is not the MCP Apps host bridge", () => {
    expect(page).toMatch(/plain React/);
    expect(page).toMatch(/not the MCP Apps host bridge/);
  });

  it("keeps that note on the page, under the closed How this works disclosure", () => {
    expect(page).toMatch(/<details className="ha-how">\s*<summary>How this works<\/summary>/);
    expect(page.indexOf("not the MCP Apps host bridge")).toBeGreaterThan(page.indexOf("How this works"));
  });

  it("does not claim the cards are MCP Apps", () => {
    expect(page).not.toMatch(/MCP Apps (card|host|view)s? (are|is) (rendered|shown)/i);
  });
});

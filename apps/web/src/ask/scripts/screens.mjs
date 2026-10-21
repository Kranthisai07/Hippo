// Starts the Vite dev server, renders each card from real fixtures in Chromium, takes screenshots and runs axe-core.
// Run: pnpm --filter @hippo/web screens   (needs a Playwright chromium; set CHROME to override the path)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "__screens__");
mkdirSync(out, { recursive: true });
const axeSource = readFileSync(join(here, "..", "..", "..", "node_modules", "axe-core", "axe.min.js"), "utf8");
const chrome =
  process.env.CHROME ??
  join(process.env.USERPROFILE ?? "", "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

const vite = spawn(
  process.execPath,
  [join(here, "..", "..", "..", "node_modules", "vite", "bin", "vite.js"), "--port", "5199", "--strictPort"],
  {
    cwd: join(here, "..", "..", ".."),
    stdio: "ignore",
  },
);
const base = "http://localhost:5199/ask-preview.html";
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const shots = [
  ["coverage", /dishwasher is leaking/i],
  ["coming-up", /what is coming up/i],
  ["lease", /lease say/i],
];
const views = [
  { w: 1280, h: 720, scheme: "light" },
  { w: 1280, h: 720, scheme: "dark" },
  { w: 1920, h: 1080, scheme: "light" },
  { w: 390, h: 844, scheme: "light" },
];
let violations = 0;
const browser = await chromium.launch({ executablePath: chrome });
try {
  for (const v of views) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, colorScheme: v.scheme });
    const page = await ctx.newPage();
    for (const [name, button] of shots) {
      await page.goto(base);
      await page.getByRole("button", { name: button }).click();
      await page.getByTestId("result-card").waitFor();
      await page.waitForTimeout(400);
      const file = `${name}-${v.w}x${v.h}-${v.scheme}.png`;
      await page.screenshot({ path: join(out, file) });
      const box = await page.getByTestId("result-card").boundingBox();
      const speech = await page.getByTestId("speech").boundingBox();
      const fits = box.y + box.height <= v.h;
      console.log(
        `${file}: card bottom ${Math.round(box.y + box.height)} of ${v.h}${fits ? " (fits)" : " (scrolls)"}, speech top ${Math.round(speech.y)}`,
      );
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (scrollW > 0) console.log(`  horizontal overflow ${scrollW}px`);
      await page.evaluate(axeSource);
      const res = await page.evaluate(() =>
        globalThis.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }),
      );
      for (const x of res.violations) {
        violations++;
        console.log(`  AXE ${x.id} (${x.impact}): ${x.help}`);
        for (const n of x.nodes.slice(0, 3))
          console.log(`    ${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  vite.kill();
}
console.log(violations === 0 ? "axe: no violations" : `axe: ${violations} violations`);
process.exit(violations === 0 ? 0 : 1);

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demoSignIn } from "./helpers";

// The Gmail screens in a real browser: the consent page, the waiting page and the list, in light and dark at desktop and
// phone width, with axe. The server side of the scan is covered by the API tests against a fake Gmail; here the import
// routes are answered by the test, and the list is built from the real demo household (its subscriptions and dates).
const OUT = fileURLToPath(new URL("../docs/screens/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const VARIANTS = [
  { tag: "desktop-light", w: 1280, h: 720, scheme: "light" as const },
  { tag: "desktop-dark", w: 1280, h: 720, scheme: "dark" as const },
  { tag: "phone-light", w: 390, h: 844, scheme: "light" as const },
  { tag: "phone-dark", w: 390, h: 844, scheme: "dark" as const },
];

async function snap(page: Page, name: string) {
  for (const v of VARIANTS) {
    await page.emulateMedia({ colorScheme: v.scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(150);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(
      result.violations.map((x) => `${name} ${v.tag}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    ).toEqual([]);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(sw, `${name} ${v.tag} scrolls sideways`).toBeLessThanOrEqual(iw);
    await page.screenshot({ path: `${OUT}web-gmail-${name}-${v.tag}.png` });
  }
}

const counts = { scanned: 0, found: 0, duplicates: 0, skipped: 0, failed: 0, candidates: 0 };
const running = {
  id: "job-1",
  status: "running",
  finished: false,
  counts: { ...counts, scanned: 120, candidates: 340, found: 7 },
  error: null,
  revoked: false,
  spotted: [],
};
const done = {
  ...running,
  status: "done",
  finished: true,
  revoked: true,
  counts: { ...counts, scanned: 340, candidates: 340, found: 7, duplicates: 2 },
  spotted: [
    {
      kind: "lease",
      subject: "Your lease renewal",
      sender: "oakrealty.example",
      date: "2026-10-20",
      filename: "Lease.pdf",
    },
    {
      kind: "warranty",
      subject: "Warranty for your dishwasher",
      sender: "homeappliance.example",
      date: "2026-09-02",
      filename: null,
    },
  ],
};

test("connect, waiting and all set screens", async ({ page }) => {
  test.setTimeout(240_000);
  await demoSignIn(page);

  let phase: "running" | "done" = "running";
  await page.route("**/api/me", async (route) => {
    const real = await route.fetch();
    await route.fulfill({ response: real, json: { ...(await real.json()), gmail: "offer" } });
  });
  await page.route("**/api/import/**", async (route) => {
    // Never finishes while "running", so the waiting page stays up to be looked at.
    const body = phase === "running" ? running : done;
    if (route.request().method() === "POST" && phase === "running") return new Promise(() => undefined);
    await route.fulfill({ json: body });
  });

  await page.goto("/connect");
  await expect(page.getByRole("heading", { name: "Find your subscriptions in Gmail" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Gmail" })).toHaveAttribute("href", "/oauth/google/import/start");
  await snap(page, "connect");

  await page.goto("/import?job=job-1");
  await expect(page.getByRole("heading", { name: "Looking through your email" })).toBeVisible();
  await expect(page.getByText("Checked 120 of 340 emails. Found 7 subscriptions so far.")).toBeVisible();
  await snap(page, "waiting");

  phase = "done";
  await page.goto("/import?job=job-1");
  await expect(page.getByRole("heading", { name: "You are all set" })).toBeVisible();
  await expect(page.getByText("Hippo's access to your Gmail has ended.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documents Hippo spotted but cannot read yet" })).toBeVisible();
  // The demo household's subscriptions, grouped and ordered by the real function.
  await expect(page.getByRole("heading", { level: 3 }).first()).toBeVisible();
  await snap(page, "all-set");
});

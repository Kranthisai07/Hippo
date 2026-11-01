import { expect, test, type Page } from "@playwright/test";
import { demoSignIn, removeSeedLease, uploadLease } from "./helpers";

// Measures boxes instead of trusting the eye: the phone tab bar, the review bar, and sideways scroll on every page.
const WIDTHS = [320, 360, 390, 430, 768];

async function noSidewaysScroll(page: Page, where: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `${where} scrollWidth ${sw} > innerWidth ${iw}`).toBeLessThanOrEqual(iw);
}

test("phone tab bar fits at every width and the review bar is one row above it", async ({ page }) => {
  test.setTimeout(180_000);
  await demoSignIn(page);
  await removeSeedLease(page);
  await uploadLease(page);
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.locator("[data-field='noticeDaysToVacate']")).toBeVisible();

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(150);
    const nav = page.getByRole("navigation", { name: "Main" });
    const tabs = await nav.locator("a").all();
    expect(tabs).toHaveLength(5);
    const navBox = (await nav.boundingBox())!;
    for (const tab of tabs) {
      const name = (await tab.textContent())!.trim();
      const box = (await tab.boundingBox())!;
      expect(box.x, `${name} at ${w}`).toBeGreaterThanOrEqual(navBox.x - 0.5);
      expect(box.x + box.width, `${name} at ${w}`).toBeLessThanOrEqual(navBox.x + navBox.width + 0.5);
      // The visible label must sit inside its own tab and on one line.
      // A Range around the text gives the real ink box even when the span itself is clamped.
      const lb = await tab.evaluate((a) => {
        // The label the eye sees: the span wider than the 1px screen reader copy.
        const rects = [...a.querySelectorAll("span")].map((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return r.getBoundingClientRect();
        });
        const b = rects.filter((r) => r.width > 2).at(-1)!;
        return { x: b.x, width: b.width, height: b.height };
      });
      expect(lb.x, `${name} label left at ${w}`).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(lb.x + lb.width, `${name} label right at ${w}`).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(lb.height, `${name} label wraps at ${w}`).toBeLessThan(20);
    }
    // The review bar: count and button on one row, the dates under them in a row that scrolls sideways, clear of the tab bar.
    const bar = page.locator(".sticky-bar");
    const barBox = (await bar.boundingBox())!;
    const count = (await bar.locator("strong").boundingBox())!;
    const btn = (await bar.getByRole("button", { name: "Confirm all dates" }).boundingBox())!;
    expect(Math.abs(count.y + count.height / 2 - (btn.y + btn.height / 2)), `bar row at ${w}`).toBeLessThan(12);
    expect(barBox.y + barBox.height, `bar clears tabs at ${w}`).toBeLessThanOrEqual(navBox.y);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(w);
    // The dates are visible inside the bar, and the row scrolls itself instead of widening the page.
    const list = bar.getByRole("list");
    await expect(list).toBeVisible();
    const lb = (await list.boundingBox())!;
    expect(lb.x, `dates left at ${w}`).toBeGreaterThanOrEqual(barBox.x - 0.5);
    expect(lb.x + lb.width, `dates right at ${w}`).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
    await expect(list.getByRole("listitem").first()).toBeVisible();
    await noSidewaysScroll(page, `review ${w}`);
  }
});

test("no sideways scroll on any page at phone and desktop widths", async ({ page }) => {
  test.setTimeout(180_000);
  await demoSignIn(page);
  for (const w of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width: w, height: 800 });
    for (const path of ["/", "/upload", "/subscriptions", "/things", "/settings", "/ask", "/welcome", "/privacy"]) {
      await page.goto(path);
      await page.waitForTimeout(100);
      await noSidewaysScroll(page, `${path} ${w}`);
    }
  }
});

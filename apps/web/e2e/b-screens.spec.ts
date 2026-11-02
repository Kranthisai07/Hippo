import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demoSignIn, removeSeedLease, uploadLease } from "./helpers";

// Walks every page, runs axe on it in light and dark at desktop and phone width, and saves screenshots at 1280x720 and 390x844.
const OUT = fileURLToPath(new URL("../docs/screens/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const VARIANTS = [
  { tag: "desktop-light", w: 1280, h: 720, scheme: "light" as const, axe: true },
  { tag: "desktop-dark", w: 1280, h: 720, scheme: "dark" as const, axe: true },
  { tag: "phone-light", w: 390, h: 844, scheme: "light" as const, axe: true },
  { tag: "phone-dark", w: 390, h: 844, scheme: "dark" as const, axe: true },
];

async function snap(page: Page, name: string) {
  for (const v of VARIANTS) {
    await page.emulateMedia({ colorScheme: v.scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(150);
    if (v.axe) {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(
        result.violations.map((x) => `${name} ${v.tag}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
      ).toEqual([]);
    }
    await page.screenshot({ path: `${OUT}web-${name}-${v.tag}.png` });
  }
}

test("every page: accessibility check and screenshots", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await snap(page, "welcome");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.screenshot({ path: `${OUT}web-welcome-full-light.png`, fullPage: true });
  await page.goto("/signin");
  await snap(page, "signin");

  await demoSignIn(page);
  await removeSeedLease(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
  await expect(page.getByTestId("confirmed-item").first()).toBeVisible();
  await snap(page, "coming-up");
  // Single cards, used as crops on the public landing page (copy them to public/landing when the design changes).
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page
    .getByTestId("confirmed-item")
    .filter({ hasText: "Renews on" })
    .first()
    .screenshot({ path: `${OUT}card-renews.png` });
  await page
    .getByTestId("confirmed-item")
    .filter({ hasText: "Trial ends on" })
    .first()
    .screenshot({ path: `${OUT}card-trial.png` });

  await page.goto("/upload");
  await snap(page, "upload");
  await uploadLease(page);
  await snap(page, "upload-ready");

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.locator("[data-field='noticeDaysToVacate']")).toBeVisible();
  await expect(page.getByTestId("page-text")).toBeVisible();
  await snap(page, "review");

  await page.getByRole("button", { name: "Confirm all dates" }).click();
  await expect(page.getByTestId("deadline-card").first()).toBeVisible();
  await snap(page, "review-confirmed");

  await page.goto("/");
  await expect(page.getByTestId("confirmed-item").filter({ hasText: "Give notice by" })).toBeVisible();
  await snap(page, "coming-up-confirmed");

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "Subscriptions" })).toBeVisible();
  await expect(page.locator(".stat-value")).toBeVisible();
  await snap(page, "subscriptions");

  await page.goto("/things");
  await expect(page.getByRole("heading", { name: "Things" })).toBeVisible();
  await snap(page, "things");
  await page
    .getByRole("link")
    .filter({ hasText: /./ })
    .locator("xpath=self::a[starts-with(@href,'/things/')]")
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await snap(page, "thing-detail");

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  await snap(page, "settings");

  await page.goto("/ask");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await snap(page, "ask");

  // The signed in demo client: the coverage answer and the Coming up card, as cards.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addStyleTag({ content: ".ha-top{position:static !important}" });
  await page.getByRole("button", { name: /Sign in as the demo account/ }).click();
  await page.getByRole("button", { name: /My dishwasher is leaking, am I covered\?/ }).click();
  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await page
    .getByTestId("result-card")
    .first()
    .screenshot({ path: `${OUT}web-ask-coverage.png` });
  await page.getByRole("button", { name: /What is coming up\?/ }).click();
  await expect(page.getByTestId("recall-card").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await page
    .getByTestId("result-card")
    .first()
    .screenshot({ path: `${OUT}web-ask-coming.png` });
  await page
    .getByTestId("recall-card")
    .first()
    .screenshot({ path: `${OUT}card-recall.png` });

  await page.goto("/privacy");
  await snap(page, "privacy");
  await page.goto("/terms");
  await snap(page, "terms");
});

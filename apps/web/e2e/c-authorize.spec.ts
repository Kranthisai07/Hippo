import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The server rendered sign in page (the one the extension opens). Axe in light and dark, the states, the sizes.
const OUT = fileURLToPath(new URL("../docs/screens/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const AUTHORIZE =
  "http://localhost:8787/oauth/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: "hippo-demo",
    redirect_uri: "http://localhost:5173/callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: "http://localhost:8787/mcp",
    state: "e2e",
  }).toString();

const SIZES = [
  { tag: "320", w: 320, h: 640 },
  { tag: "500", w: 500, h: 760 },
  { tag: "1280", w: 1280, h: 720 },
];

async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(
      result.violations.map((x) => `${name} ${scheme}: ${x.id} ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    ).toEqual([]);
    for (const s of SIZES) {
      await page.setViewportSize({ width: s.w, height: s.h });
      // No sideways scroll at any size.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (s.tag !== "320") await page.screenshot({ path: `${OUT}auth-${name}-${s.tag}-${scheme}.png` });
    }
  }
}

test("sign in page: states, accessibility, sizes, and no policy violations", async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && problems.push(m.text()));
  await page.goto(AUTHORIZE);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Hippo for Chrome")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await check(page, "email");

  await page.getByLabel("Email").fill("sam@example.com");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
  await expect(page.getByLabel("Code from your email")).toBeFocused();
  await check(page, "code");

  await page.getByLabel("Code from your email").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("That code did not work.");
  await check(page, "wrong-code");

  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

  expect(problems).toEqual([]);
});

test("the error page", async ({ page }) => {
  await page.goto("http://localhost:8787/oauth/authorize?client_id=nobody");
  await expect(page.getByRole("heading", { level: 1, name: "Cannot continue" })).toBeVisible();
  await check(page, "error");
});

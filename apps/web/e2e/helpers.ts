import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

export const LEASE = fileURLToPath(new URL("../../../fixtures/docs/lease.pdf", import.meta.url));
export const ORIGIN = "http://localhost:5173";

export async function demoSignIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole("button", { name: "Use the demo account" }).click();
  await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
}

/** The seeded demo household already has a confirmed lease. Remove it so the first run is clean. */
export async function removeSeedLease(page: Page) {
  const res = await page.request.delete("/api/docs/doc-lease", { headers: { Origin: ORIGIN } });
  expect([204, 404]).toContain(res.status());
}

export async function uploadLease(page: Page) {
  await page.goto("/upload");
  await page.locator("#files").setInputFiles(LEASE);
  const row = page.getByTestId("upload-row");
  await expect(row.getByRole("link", { name: "Review" })).toBeVisible();
}

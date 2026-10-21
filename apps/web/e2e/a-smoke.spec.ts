import { expect, test } from "@playwright/test";
import { ORIGIN, demoSignIn, removeSeedLease, uploadLease } from "./helpers";

// Demo moment 1 end to end, then the 429 message and delete. The tests share one in-memory household and run in order.

test("upload the lease, confirm the notice date, see it on Coming up", async ({ page }) => {
  await demoSignIn(page);
  await removeSeedLease(page);
  await page.reload();
  await expect(page.getByText(/Give notice by 2026-11-01/)).toHaveCount(0);

  await uploadLease(page);

  // Before confirming: the date is waiting for the person and nothing alerts.
  await page.getByRole("link", { name: "Coming up" }).first().click();
  const waiting = page.getByTestId("unconfirmed-item").filter({ hasText: "Give notice by 2026-11-01" });
  await expect(waiting).toBeVisible();
  await expect(page.getByTestId("confirmed-item").filter({ hasText: "Give notice by" })).toHaveCount(0);
  await expect(waiting.getByRole("button", { name: "Done" })).toHaveCount(0);
  const alerts = await page.request.get("/api/alerts?open=true");
  const body = (await alerts.json()) as { alerts: { refId: string }[] };
  expect(body.alerts.filter((a) => a.refId.includes("notice_by"))).toHaveLength(0);

  // Review: the notice period with its quote and page 4.
  await waiting.getByRole("link", { name: "Review and confirm" }).click();
  const field = page.locator("[data-field='noticeDaysToVacate']");
  await expect(field).toContainText("Notice days to vacate");
  await expect(field).toContainText("60");
  await expect(field).toContainText("sixty (60) days");
  await expect(field.getByRole("button", { name: /Page 4/ })).toBeVisible();
  await expect(field).toContainText("Needs you");
  await field.getByRole("button", { name: /Page 4/ }).click();
  await expect(page.getByTestId("quote-mark")).toContainText("sixty (60) days");

  await page.getByRole("button", { name: "Confirm all dates" }).click();
  const card = page.getByTestId("deadline-card").filter({ hasText: "Give notice by" });
  await expect(card).toContainText("Give notice by Nov 1 (in 11 days)");
  await expect(card).toContainText("page 4");

  await page.getByRole("link", { name: "See it on Coming up" }).click();
  const done = page.getByTestId("confirmed-item").filter({ hasText: "Give notice by 2026-11-01" });
  await expect(done).toBeVisible();
  await expect(done).toContainText("in 11 days");
  await expect(done.getByRole("button", { name: "Done" })).toBeVisible();
});

test("the sign in 429 message is shown once and the buttons wait", async ({ page, context }) => {
  await context.clearCookies();
  const email = "slow@example.com";
  const first = await page.request.post("/oauth/magic-code", { headers: { Origin: ORIGIN }, data: { email } });
  expect(first.status()).toBe(200);
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByRole("alert")).toContainText(/wait \d+ seconds/);
  await expect(page.getByRole("button", { name: "Send me a code" })).toBeDisabled();
});

test("deleting the document removes its items", async ({ page }) => {
  await demoSignIn(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete lease.pdf" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByRole("status")).toContainText("Deleted lease.pdf");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coming up" })).toBeVisible();
  await expect(page.getByText(/Give notice by/)).toHaveCount(0);
});

// Manual end to end check: starts the real API (8787) and Vite (5173), signs in on /ask in Chromium, clicks through
// the three moments, saves screenshots and prints what happened. Stops both servers by PID. Run: pnpm --filter @hippo/web e2e
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "..");
const out = join(here, "..", "__screens__");
mkdirSync(out, { recursive: true });
const chrome =
  process.env.CHROME ??
  join(process.env.USERPROFILE ?? "", "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

const kids = [];
const start = (cmd, args, cwd) => {
  const c = spawn(cmd, args, { cwd, shell: true, stdio: "ignore" });
  kids.push(c.pid);
  return c;
};
const stopAll = () => {
  for (const pid of kids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
};
const waitFor = async (url) => {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up`);
};

try {
  start("pnpm", ["--filter", "@hippo/api", "start"], web);
  await waitFor("http://127.0.0.1:8787/.well-known/oauth-protected-resource");
  start("node", [join(web, "node_modules", "vite", "bin", "vite.js")], web);
  await waitFor("http://localhost:5173/");

  const browser = await chromium.launch({ executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:5173/ask");
  await page.screenshot({ path: join(out, "signed-out-1280x720.png") });
  await page.getByRole("button", { name: /sign in as the demo account/i }).click();
  await page.getByText(/Connected:/).waitFor({ timeout: 20000 });
  console.log("signed in, connected:", await page.getByText(/Connected:/).textContent());

  const say = async (name, file) => {
    await page.getByRole("button", { name }).click();
    await page.getByTestId("speech").waitFor();
    await page.waitForTimeout(500);
    console.log(
      `"${await page.locator(".ha-bubble--user p").textContent()}" -> ${await page.getByTestId("speech").textContent()}`,
    );
    await page.screenshot({ path: join(out, file) });
  };
  await say(/dishwasher is leaking/i, "e2e-coverage-1280x720.png");
  console.log("badge:", await page.getByTestId("badge").textContent());
  await page.getByRole("button", { name: /show clause, page 3/i }).click();
  await page.getByTestId("clause-view").waitFor();
  await page.getByRole("button", { name: /claim steps/i }).click();
  await page.getByTestId("claim-steps").waitFor();
  console.log("show clause and claim steps both answered");
  await say(/what is coming up/i, "e2e-coming-up-1280x720.png");
  await page
    .getByTestId("coming-item")
    .first()
    .getByRole("button", { name: /^dismiss/i })
    .click();
  await page
    .getByTestId("coming-item")
    .first()
    .getByTestId("status")
    .getByText(/dismissed/i)
    .waitFor();
  console.log("dismiss worked");
  await page
    .getByTestId("recall-card")
    .first()
    .getByRole("button", { name: /not mine/i })
    .click();
  await page
    .getByTestId("recall-card")
    .first()
    .getByTestId("status")
    .getByText(/not mine/i)
    .waitFor();
  console.log("recall not mine worked");
  await say(/lease say/i, "e2e-lease-1280x720.png");
  await say(/car insurance renew/i, "e2e-agreement-1280x720.png");
  await say(/had the car serviced/i, "e2e-service-1280x720.png");
  await say(/undo that/i, "e2e-undo-1280x720.png");
  const logText = await page.locator(".ha-log").textContent();
  console.log(
    "protocol log mentions:",
    ["initialize", "tools/list", "tools/call"].filter((m) => logText.includes(m)).join(", "),
  );
  console.log("token visible in page text:", /eyJ/.test(await page.content()));
  console.log("localStorage keys:", await page.evaluate(() => Object.keys(localStorage).length));
  console.log("console or page errors:", errors.length ? errors.join(" | ") : "none");
  await browser.close();
} finally {
  stopAll();
}

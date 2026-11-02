// Builds the Chrome Web Store images from real material: the built popup (with a mocked chrome API and demo data),
// the demo billing page in fixtures/pages, and the web app screens in apps/web/docs/screens.
// Run: pnpm --filter @hippo/extension build && node apps/extension/store/make-assets.mjs
// Output: apps/extension/store/assets/*.png (sizes from docs/VERIFIED.md 10.19). Demo data only, no real person.
import { chromium } from "../../web/node_modules/@playwright/test/index.mjs";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const dist = path.join(root, "apps/extension/dist");
const screens = path.join(root, "apps/web/docs/screens");
const out = path.join(here, "assets");
mkdirSync(out, { recursive: true });

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const serve = (dir, index) =>
  http
    .createServer((q, r) => {
      const p = q.url.split("?")[0];
      const f = path.join(dir, p === "/" ? index : p);
      if (!f.startsWith(dir) || !existsSync(f)) return void r.writeHead(404).end();
      r.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
    })
    .listen(0);
const popupSrv = serve(dist, "popup.html");
const fixSrv = serve(path.join(root, "fixtures/pages"), "kestrel_trial.html");
const popupUrl = `http://localhost:${popupSrv.address().port}/popup.html`;
const fixUrl = `http://localhost:${fixSrv.address().port}/`;
const fontUrl = `http://localhost:${popupSrv.address().port}/geist-latin-wght-normal.woff2`;

const subs = [
  {
    agreementId: "a1",
    docId: "d1",
    vendor: "Kestrel Learning",
    plan: "Premium",
    amount: 9.99,
    cycle: "monthly",
    nextChargeDate: "2026-10-28",
    confirmed: false,
    source: { docName: "kestrel_trial.html", page: null },
  },
  {
    agreementId: "a2",
    docId: "d2",
    vendor: "Fernwood Streaming",
    plan: "Standard",
    amount: 15.99,
    cycle: "monthly",
    nextChargeDate: "2026-11-03",
    confirmed: true,
    source: { docName: "subscription_fernwood.pdf", page: 1 },
  },
  {
    agreementId: "a3",
    docId: "d3",
    vendor: "Lantern Cloud Storage",
    plan: "Plus",
    amount: 4.99,
    cycle: "monthly",
    nextChargeDate: "2026-11-12",
    confirmed: true,
    source: { docName: "lantern_pricing.html", page: null },
  },
];

const browser = await chromium.launch();

async function popupShot(file, { page: hasPage, list, scheme = "light", save = false }) {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 700 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const pg = await ctx.newPage();
  await pg.addInitScript(
    ({ hasPage, list }) => {
      window.chrome = {
        runtime: {
          sendMessage: async (m) => ({ ok: true, signedIn: true, token: m.type === "token" ? "t" : undefined }),
          id: "x",
        },
        tabs: { query: async () => [{ id: 1 }], create: () => {} },
        scripting: {
          executeScript: async () =>
            hasPage
              ? [
                  {
                    result: {
                      title: "Billing",
                      host: "kestrel.example",
                      text: "Your Premium plan renews on Oct 28. ".repeat(60),
                    },
                  },
                ]
              : [],
        },
        action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
      };
      const real = window.fetch;
      window.fetch = async (u, i) =>
        String(u).includes("/ext/subscriptions")
          ? new Response(JSON.stringify({ subscriptions: list, monthlyTotal: 20.98 }), { status: 200 })
          : String(u).includes("/ext/captures")
            ? new Response(JSON.stringify({ saved: true, reviewUrl: "/review/d1" }), { status: 200 })
            : real(u, i);
    },
    { hasPage, list },
  );
  await pg.goto(popupUrl);
  await pg.waitForSelector("main:not([aria-busy])");
  await pg.waitForTimeout(300);
  if (save) {
    await pg.getByRole("button", { name: "Save", exact: true }).click();
    await pg.waitForSelector("[role=status]");
    await pg.waitForTimeout(300);
  }
  const h = Math.ceil(await pg.evaluate(() => document.querySelector("main").getBoundingClientRect().height)) + 8;
  await pg.setViewportSize({ width: 360, height: h });
  await pg.screenshot({ path: file });
  await ctx.close();
}

const popupA = path.join(out, "_popup-save.png");
const popupB = path.join(out, "_popup-list.png");
await popupShot(popupA, { page: true, list: subs.slice(1) });
await popupShot(popupB, { page: true, list: subs, save: true });

const bctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, colorScheme: "light" });
const bp = await bctx.newPage();
await bp.goto(fixUrl);
await bp.screenshot({ path: path.join(out, "_billing.png") });
await bctx.close();

const b64 = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
const MARK = `<span class="mark"><svg width="30" height="30" viewBox="0 0 32 32" fill="none"><path d="M7 22c0-6 4-10 9-10s9 4 9 10" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="18" r="1.8" fill="#fff"/><circle cx="20" cy="18" r="1.8" fill="#fff"/></svg></span>`;
const CSS = `
@font-face{font-family:G;src:url(${fontUrl});font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{font-family:G,system-ui,sans-serif;color:#0d1a18;background:radial-gradient(900px 500px at 15% 0%,#d9eeea,transparent 70%),#f3f6f5;overflow:hidden;position:relative}
.mark{width:46px;height:46px;border-radius:14px;background:#0b6b61;display:inline-grid;place-items:center}
.brand{display:flex;align-items:center;gap:12px;font-weight:650;font-size:26px;letter-spacing:-.01em}
h1{font-weight:700;letter-spacing:-.025em;line-height:1.08}
p.sub{color:#405450}
.card{background:#fff;border:1px solid #d3dcd9;border-radius:20px;box-shadow:0 28px 70px rgb(13 42 38/.18),0 6px 18px rgb(13 42 38/.08);overflow:hidden}
img{display:block}
`;

async function compose(file, w, h, html) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.setContent(`<style>${CSS}</style><body style="width:${w}px;height:${h}px">${html}</body>`);
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(200);
  await pg.screenshot({ path: path.join(out, file) });
  await ctx.close();
}

// Layout helpers: caption on the left or top, picture in a card.
const shot = (n, title, sub, picHtml) => `
<div style="position:absolute;left:64px;top:72px;width:430px">
  <div class="brand">${MARK}Hippo</div>
  <h1 style="font-size:50px;margin-top:40px">${title}</h1>
  <p class="sub" style="font-size:21px;line-height:1.45;margin-top:20px">${sub}</p>
</div>${picHtml}`;

const wide = (f) =>
  `<div class="card" style="position:absolute;left:500px;top:50%;transform:translateY(-50%);width:720px"><img src="${b64(f)}" style="width:720px"></div>`;
const billing = `<div class="card" style="position:absolute;left:520px;top:90px;width:700px"><img src="${b64(path.join(out, "_billing.png"))}" style="width:700px"></div>
<div class="card" style="position:absolute;left:880px;top:150px;width:300px"><img src="${b64(popupA)}" style="width:300px"></div>`;
const listOnly = `<div class="card" style="position:absolute;left:700px;top:60px;width:360px"><img src="${b64(popupB)}" style="width:360px"></div>`;

await compose(
  "screenshot-1-save.png",
  1280,
  800,
  shot(
    1,
    "Save a billing page in one click",
    "Nothing is read until you click, and nothing is sent until you press Save.",
    billing,
  ),
);
await compose(
  "screenshot-2-list.png",
  1280,
  800,
  shot(2, "Your subscriptions in one list", "See what you pay each month and what still needs your review.", listOnly),
);
await compose(
  "screenshot-3-review.png",
  1280,
  800,
  shot(
    3,
    "Every date shows where it came from",
    "Check each value against the exact words and page in your document.",
    wide(path.join(screens, "web-review-desktop-light.png")),
  ),
);
await compose(
  "screenshot-4-coming.png",
  1280,
  800,
  shot(
    4,
    "Nothing alerts you until you confirm",
    "Hippo only reminds you about dates you have reviewed.",
    wide(path.join(screens, "web-coming-up-desktop-light.png")),
  ),
);
await compose(
  "screenshot-5-subscriptions.png",
  1280,
  800,
  shot(
    5,
    "The whole picture, on any screen",
    "Subscriptions, deadlines and things, in the app and in the popup.",
    wide(path.join(screens, "web-subscriptions-desktop-light.png")),
  ),
);

await compose(
  "promo-small-440x280.png",
  440,
  280,
  `<div style="position:absolute;left:32px;top:30px;width:230px"><div class="brand" style="font-size:22px">${MARK}Hippo</div><h1 style="font-size:27px;margin-top:22px">Save a subscription page in one click</h1></div>
   <div class="card" style="position:absolute;left:288px;top:34px;width:170px;border-radius:14px"><img src="${b64(popupB)}" style="width:170px"></div>`,
);
await compose(
  "promo-marquee-1400x560.png",
  1400,
  560,
  `<div style="position:absolute;left:80px;top:80px;width:620px"><div class="brand">${MARK}Hippo</div><h1 style="font-size:60px;margin-top:36px">The paperwork you never read twice, watched for you.</h1><p class="sub" style="font-size:22px;margin-top:20px">Save a billing page in one click. Review each date. Get reminded only for what you confirmed.</p></div>
   <div class="card" style="position:absolute;left:800px;top:50px;width:320px"><img src="${b64(popupB)}" style="width:320px"></div>`,
);

await browser.close();
popupSrv.close();
fixSrv.close();
console.log("assets written to", out);

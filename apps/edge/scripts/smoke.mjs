// Smoke test of the Worker under `wrangler dev --local`, with the extension's real sign in path. Usage:
//   node scripts/smoke.mjs <base url> <wrangler log file>
// The Worker prints the sign in code to its log when no email binding exists (never in production), and this script reads
// it from the file `wrangler dev` writes to. Nothing here needs an account, and nothing leaves this machine.
import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [base, logFile] = process.argv.slice(2);
if (!base || !logFile) throw new Error("usage: node scripts/smoke.mjs <base url> <wrangler log file>");

let failures = 0;
const step = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = new URL(base).origin;
// A new set of people every run, so the local database from an earlier run cannot change the result.
const run = Date.now().toString(36);
const who = (name) => `${name}-${run}@example.com`;

const fixturePage = (name) => {
  const html = readFileSync(new URL(`../../../fixtures/pages/${name}.html`, import.meta.url), "utf8");
  return /<body>([\s\S]*)<\/body>/
    .exec(html)[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replaceAll("&gt;", ">");
};

async function codeFor(email, since) {
  for (let i = 0; i < 40; i++) {
    const text = readFileSync(logFile, "utf8").slice(since);
    const m = new RegExp(`sign in code for ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (\\d{6})`).exec(text);
    if (m) return m[1];
    await sleep(250);
  }
  throw new Error(`no sign in code for ${email} in the log`);
}

async function signIn(email, sessionCookie) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirect = "http://localhost:5173/callback";
  const params = {
    client_id: "hippo-demo",
    redirect_uri: redirect,
    response_type: "code",
    scope: "mcp:tools",
    state: "smoke-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  };
  const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const cookie = [
    ...page.headers.getSetCookie().map((c) => c.split(";")[0]),
    ...(sessionCookie ? [sessionCookie] : []),
  ].join("; ");
  const post = (extra) =>
    fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...params, csrf, ...extra }),
    });
  let done;
  if (sessionCookie) {
    // Already signed in on the web: the authorize page accepts the session instead of another emailed code.
    done = await post({ action: "continue" });
  } else {
    const since = readFileSync(logFile, "utf8").length;
    await post({ action: "send", email });
    const code = await codeFor(email, since);
    done = await post({ action: "login", email, code });
  }
  const location = done.headers.get("location");
  const authCode = location && new URL(location).searchParams.get("code");
  if (!authCode) throw new Error(`login gave no code (status ${done.status})`);
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirect,
      client_id: "hippo-demo",
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error(`token exchange failed (${tokenRes.status})`);
  return tokens;
}

const call = (token, path, body) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// 1. The Worker is up, with the headers every response carries.
const health = await fetch(`${base}/healthz`);
step("healthz is 200", health.status === 200);
step(
  "every response has nosniff and a request id",
  health.headers.get("x-content-type-options") === "nosniff" &&
    /^[0-9a-f-]{36}$/.test(health.headers.get("x-request-id") ?? ""),
);
const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
step(
  "OAuth metadata names this issuer and a revocation endpoint",
  meta.issuer === origin && meta.revocation_endpoint === `${origin}/oauth/revoke`,
);

// 2. No token, no data.
const denied = await fetch(`${base}/ext/subscriptions`);
step(
  "/ext/subscriptions without a token is 401, with a request id",
  denied.status === 401 && !!denied.headers.get("x-request-id"),
);

// 3. The extension's path: emailed code (here: from the log), PKCE, token.
const alice = await signIn(who("alice"));
step("alice signs in by code and PKCE and gets tokens", !!alice.access_token && !!alice.refresh_token);

// 4. Save a page, list it.
const saved = await call(alice.access_token, "/ext/captures", {
  title: "Billing | Fernwood Plus",
  host: "account.fernwood-plus.example",
  text: fixturePage("fernwood_billing"),
});
step("saving a billing page is 201", saved.status === 201, `status ${saved.status}`);
const mine = await (await call(alice.access_token, "/ext/subscriptions")).json();
step(
  "alice lists one subscription, not yet confirmed",
  mine.subscriptions?.length === 1 && mine.subscriptions[0].confirmed === false,
);
const again = await call(alice.access_token, "/ext/captures", {
  title: "Billing | Fernwood Plus",
  host: "account.fernwood-plus.example",
  text: fixturePage("fernwood_billing"),
});
step("saving the same page again is 409, not a second copy", again.status === 409, `status ${again.status}`);

// 5. Another person sees nothing of hers.
const bob = await signIn(who("bob"));
const theirs = await (await call(bob.access_token, "/ext/subscriptions")).json();
step("bob lists nothing", Array.isArray(theirs.subscriptions) && theirs.subscriptions.length === 0);

// 6. Refresh rotates, and showing the old token again ends the family.
const refreshBody = (rt) =>
  new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: "hippo-demo",
    resource: `${origin}/mcp`,
  });
const rotated = await (
  await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshBody(alice.refresh_token),
  })
).json();
step("a refresh gives a new refresh token", !!rotated.refresh_token && rotated.refresh_token !== alice.refresh_token);
const reuse = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: refreshBody(alice.refresh_token),
});
step("showing the old refresh token again is refused", reuse.status === 400);
const afterReuse = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: refreshBody(rotated.refresh_token),
});
step("and it ended the whole family", afterReuse.status === 400);

// 7. Uploads are off, plainly.
const mcp = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${bob.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
  }),
});
const mcpText = await mcp.text();
step(
  "/mcp initialize works on Workers",
  mcp.status === 200,
  `status ${mcp.status} ${mcp.status === 200 ? "" : mcpText.slice(0, 160)}`,
);
const tools = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${bob.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
const toolsText = await tools.text();
step(
  "/mcp tools/list works on Workers",
  tools.status === 200 && toolsText.includes("whats_coming_up"),
  `status ${tools.status} ${tools.status === 200 ? "" : toolsText.slice(0, 160)}`,
);

// Tools are called with arguments, which is where input validation runs (a library that builds code at run time could
// fail here even though listing the tools worked).
const callTool = (name, args) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bob.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
  });
const good = await callTool("whats_coming_up", { window_days: 30 });
const goodText = await good.text();
step(
  "a tool call with valid arguments is answered",
  good.status === 200 && !goodText.includes("EvalError") && goodText.includes("result"),
  `status ${good.status} ${goodText.slice(0, 120)}`,
);
const bad = await callTool("whats_coming_up", { window_days: 9999, extra: 1 });
const badText = await bad.text();
step(
  "a tool call with invalid arguments is refused by validation, not by a crash",
  bad.status === 200 && /error|invalid|Invalid/.test(badText) && !badText.includes("EvalError"),
  `status ${bad.status} ${badText.slice(0, 120)}`,
);

// 8. A web session, the same person's tokens through it, and delete all data. (One emailed code per address a minute.)
const since = readFileSync(logFile, "utf8").length;
await fetch(`${base}/oauth/magic-code`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email: who("carol") }),
});
const sessionCode = await codeFor(who("carol"), since);
const session = await fetch(`${base}/oauth/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email: who("carol"), code: sessionCode }),
});
const cookie = session.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
step("carol gets a web session", session.status === 200 && cookie.includes("hippo_session"));
const carol = await signIn(who("carol"), cookie);
step("the session gives the extension tokens without a second code", !!carol.access_token);
const carolSaved = await call(carol.access_token, "/ext/captures", {
  title: "Billing | Fernwood Plus",
  host: "account.fernwood-plus.example",
  text: fixturePage("fernwood_billing"),
});
step("carol saves a page", carolSaved.status === 201, `status ${carolSaved.status}`);
const exported = await fetch(`${base}/api/export`, { headers: { cookie } });
const exportBody = await exported.json();
step(
  "her export holds that page and nothing of alice's",
  exported.status === 200 && exportBody.agreements?.length === 1,
);
const upload = await fetch(`${base}/api/uploads`, {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie },
  body: JSON.stringify({ filename: "a.pdf", contentType: "application/pdf", size: 5 }),
});
step("uploads answer a plain 503", upload.status === 503);
const wipe = await fetch(`${base}/api/data`, {
  method: "DELETE",
  headers: { "content-type": "application/json", origin, cookie },
  body: JSON.stringify({ confirm: "delete all my data" }),
});
step("delete all my data is 204", wipe.status === 204, `status ${wipe.status}`);
const after = await (await call(carol.access_token, "/ext/subscriptions")).json();
step("her list is empty afterwards", Array.isArray(after.subscriptions) && after.subscriptions.length === 0);
const aliceStill = await (await call(alice.access_token, "/ext/subscriptions")).json();
step(
  "alice's page is untouched by carol's delete (her access token still works until it expires)",
  aliceStill.subscriptions?.length === 1,
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

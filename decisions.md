# Decisions log

No decisions log exists on main (MEMORY.md is only in old worktrees), so this file starts one. Tagged `+claude`.

## 2026-10-31: extension logo and popup redesign (+claude)

- **Logo:** `apps/web/public/favicon.svg` is the only logo asset in the repo, so the extension uses it. PNG icons (16, 32, 48, 128) were drawn from its geometry with PIL at 16x supersampling, because no SVG rasterizer is installed and adding one for a one-off was not worth a new dependency. The SVG is copied to `public/icons/logo.svg` for the popup header. Its teal (#2f5d62) differs slightly from the web accent (#0b6b61); the logo is left as is.
- **Look:** the popup copies the subset of web tokens it needs (`apps/web/src/tokens.css`) so the two read as one product, including dark mode. Copied rather than imported because the extension build should not depend on web CSS internals.
- **Font:** `@fontsource-variable/geist` (already used by the web app) is bundled, because the extension CSP allows no remote fonts.
- **Toolbar badge:** set from the popup after the list loads, never from a background poll. This keeps the rule that the extension reads nothing in the background, and needs no new permission (`chrome.action` has none).
- **Next charge date:** shown as a date, not "in N days". The demo server date (2026-10-21) differs from the real clock, so a relative count would be wrong on demo data.
- **Locale:** dates are formatted as `en-US`, matching the reader's US dollars and English scope.
- **Test change:** "never as HTML" now checks `img[src=x]`, because the popup header legitimately contains an `<img>`.

## 2026-10-31: production hardening, step 1 (+claude)

- **One limiter:** `RateLimiter` (apps/api/src/api/limiter.ts) is a function over the auth store's existing atomic `tryHit`, so the memory version reuses tested code and a Durable Object or DynamoDB version can replace it with no route changes. It replaces the two ad hoc `Map` logs for uploads and captures. Chosen over a new library because the contract already existed and had tests.
- **Two layers:** a coarse per address limit in front of `/oauth` (120 a minute) and `/ext` (300 a minute), and exact per household limits behind it (captures 30 an hour, reads 60 a minute, uploads 30 an hour, exports 5 an hour). Per email send and guess limits stay inside packages/auth. Edge limits at Cloudflare are only approximate (docs/VERIFIED.md 10), so they are not the only layer.
- **Address source:** the proxy header is trusted only when `HIPPO_CLIENT_IP_HEADER` names it. Otherwise the socket address is used, because any client can send a header of its own.
- **CORS on /ext:** the preflight is answered before the bearer check (it carries no token, so it was a 401 before). Exact origin match, echoed back, never `*`, no credentials. A 401 from `unauthorized()` is a fresh Response, so the CORS headers are copied onto it by hand.
- **Fail closed:** `productionProblems` lists every unsafe setting. The in-memory Node entry refuses `HIPPO_ENV=production` outright, so production can only run from a host entry with durable storage.
- **Export:** `GET /api/export` reuses the masked views. Deleting data already existed (`DELETE /api/data`), so nothing new was built there.

## 2026-10-31: production hardening, step 2 (+claude)

- **Mailer:** a one method interface in packages/auth. A provider failure logs the error name only and the answer is unchanged, so an outage does not show which addresses were tried. `productionProblems` refuses production without a mailer. There was nothing to fix for "does this address exist": a household is derived on first login and every answer was already uniform, so a regression test was added instead of code.
- **Revocation:** `AuthStore.revokeUser(sub)` plus RFC 7009 `/oauth/revoke` and `/oauth/logout-all`. The extension revokes on Sign out because deleting the local copy alone leaves a refresh token valid for 30 days on the server. Access tokens stay stateless, so up to 15 minutes remain; a deny list was not worth the state it needs. A durable store must index sessions and refresh records by `sub` (D1 and Durable Object work, Phase 2).
- **Audit and access log:** audit events carry the hashed `sub` that auth already used, never the email. The access line has no query string, so a token in a URL cannot reach the log. The test helper keeps request lines apart from auth lines because the login helper reads the last auth line to find the demo code.
- **Quota:** 200 saved pages per household, counted from the document list (fine at this size, commented as a shortcut). New status 422 `limit_reached` so the popup's duplicate handling (409) is not triggered. A per day text counter was skipped: 30 pages an hour of at most 60,000 characters already bounds it.
- **Masking:** seven or more single digits joined by single separators are masked. Spelled out digits are not, and PRIVACY.md now says so instead of claiming more.


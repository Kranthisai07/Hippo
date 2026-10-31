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

## 2026-10-31: fixes from the reviewer round on k/hardening (+claude)

- **Revoke ignores `client_id`:** `consumeRefresh` is destructive, so checking the client after it burned the token on a mismatch and made its owner's next refresh look like reuse. Anyone holding a refresh token may end it: it is the credential. A non-consuming lookup was rejected because it adds another method every durable store must implement.
- **Mail timeout:** the mailer gets 5 seconds, then the answer goes out unchanged and the audit says `mail_failed`, not `code_sent`.
- **429 from the per address limit** now carries `Access-Control-Allow-Origin` for a listed origin, because it runs before the `/ext` CORS middleware.
- **Tests that passed for the wrong reason** were rewritten: the socket address test injects two addresses, and the wrong client revoke test checks that a descendant token dies.
- **Left as is:** the revoke versus rotation race needs a tombstone in a durable store (Phase 2); the quota is not atomic (bounded by 30 saves an hour); the production check only fires on `HIPPO_ENV=production`.

## 2026-10-31: Phase 2 slices 1 and 2, the repository on D1 without the AWS SDK (+claude)

- **Measured first:** bundling the repository plus the first D1 adapter for a Workers like target gave 331 KB (101 KB gzip), 95% of it the AWS SDK, and left runtime imports of `node:http`, `node:child_process`, `node:fs` and others. Cloudflare's size limits are unverified (docs/VERIFIED.md 10), but those Node imports alone made it the wrong build.
- **Change:** the repository logic moved unchanged to `items.ts` (`createItemRepository`) and talks to a six method `ItemClient` (put, get, delete, deleteIfExists, query, write). `dynamo.ts` keeps the SDK and implements `ItemClient` with the same commands as before (same paging, same 25 item batches with retries, same conditional delete). `d1.ts` implements it with SQL. Result: 7 KB (2.9 KB gzip) and no Node imports for D1.
- **Why an interface and not the first idea (a client that fakes the DynamoDB SDK):** the fake had to import the SDK command classes to recognise requests, which was the bloat. A narrow interface also made the D1 side simpler: no expression parsing, no page tokens, one `SELECT` per read.
- **What stayed the same:** `createDynamoRepository({ client, tableName })` and its exports (`TABLE_DEFINITION`, `TTL_SPECIFICATION`, `stripUndefined`), so callers and the CDK test are untouched.
- **D1 details that matter:** keys compare as raw bytes (SQLite BINARY), `begins_with` is `substr(...) = ?` not `LIKE`, every value is a bound parameter, `deleteIfExists` is a select plus a delete in one `batch` so racing callers cannot both win (D1 isolation is unverified, to be proven on real D1 in slice 6), writes go in chunks of 25 (D1's own batch limit is unverified). No TTL purge: `popUndo` checks expiry itself.
- **Verified vs not:** the shared 1070 line suite passes on D1 over `node:sqlite` and on the DynamoDB fake. The suite against real DynamoDB Local (needs Docker) was not run here, so the refactored SDK client is covered by the fake only until CI runs it.

## 2026-10-31: Phase 2 slice 3, the sign in store on D1 (+claude)

- **No Durable Object (for now):** every guarantee is one SQL statement, and SQLite runs one statement atomically. Nothing relies on a D1 batch being isolated or on a statement reporting rows changed, which Cloudflare does not document (docs/VERIFIED.md 10). A Durable Object stays the fallback behind the same `AuthStore` if the real D1 run disagrees. Fewer moving parts (no class, binding or RPC) was the reason to try SQL first.
- **How each race is closed:** consume = one `UPDATE ... SET winner = <random per call> WHERE winner IS NULL AND family not revoked`, then read the row: only the caller that finds its own value won. Revoke = a tombstone row for the family, and consume refuses any record of a tombstoned family whenever it was stored, so a token put during or after a revoke is dead (this closes the reviewer's rotation race, in the memory store too). `tryHit` = one conditional INSERT that carries the caller's random value, read back to learn who got the slot.
- **A design I dropped:** the first `tryHit` judged success by comparing the hit count before and after. Under interleaved callers another caller's insert could make a refused call look successful. The per call random value fixed it, and a mutation test (the old logic put back) fails the 30 parallel callers test.
- **The test model is deliberately worse than D1:** `createSqliteD1({ interleave: true })` makes each statement atomic but lets statements of different callers mix at every step and does not make a batch a transaction. The contract suite (`packages/auth/test/store.suite.ts`) runs on the memory store, D1 as documented, and D1 interleaved. I checked the suite can fail: putting back check-then-act consume, the count based `tryHit`, and consume without the tombstone check each fail it (13, 3 and 13 tests).
- **Also changed:** `deleteIfExists` in `d1.ts` used select-then-delete in a batch, which relied on batch isolation. It now claims the row with a random value in one UPDATE, then deletes. Cost: a Worker that dies between claim and delete leaves one undo record unpoppable until it expires.
- **Not proven:** that real D1 applies each statement atomically under concurrent requests, that reads in a batch see the primary (no stale read replica), and real batch limits. These are listed as open checks in docs/VERIFIED.md for the staging run.

## 2026-10-31: Phase 2 slice 4, the durable rate limiter (+claude)

- **No new store:** `RateLimiter` was already a wrapper over the auth store's atomic `tryHit`. It is now `limiterFromStore(store, now)`, used with the memory store here and the D1 store on Workers, so no route changed and no Durable Object was added. A Durable Object stays the fallback if real D1 disagrees (docs/VERIFIED.md 10.14).
- **Round trips are the cost to watch:** the limiter sits in front of every `/oauth` and `/ext` call, and `tryHit` was four separate D1 calls. The four statements (clean old hits, read the window, conditional insert with a per call random value, read it back) and the two of `consume` now go out as one `db.batch`, so a rate check is one trip and a consume is one (asserted in tests with a trip counter in the test database). A conditional delete is two trips (claim and read, then delete). The batch is not relied on as a transaction: each statement is safe alone, and the three mutants from slice 3 (check-then-act consume, count based `tryHit`, consume without the tombstone check) still fail the suite after batching.
- **Table growth:** a per address key that is never seen again would stay forever, so `purgeExpired` also deletes hits older than the longest window in use (default one hour).
- **Cost, unverified:** each check still reads and writes a few rows. Cloudflare's per row prices are in docs/VERIFIED.md 10 but the real rows per request are only known on staging. If it is too costly, the per address limit can move to Cloudflare's own rate limiting (approximate, per location) and the exact per household limits stay in D1.

## 2026-10-31: fixes from the reviewer round on slices 1 to 4 (+claude)

- **`purgeExpired` no longer takes a tombstone age.** Tombstones live as long as a refresh token can (`TTL.refreshMs`), because a shorter age brings revoked tokens back to life. Only the rate hit age stays a parameter.
- **The "no secret in the database" test was checking SQL text, not stored values.** The test database now dumps every table, with a positive control (a known value must show up in the dump), so a raw token in a row would be caught.
- **The DynamoDB fake now rejects a base table read without `ConsistentRead`.** Removing it from the real client's Get fails 121 tests; before, nothing would have noticed.
- **Written down, not changed:** the one window per rate key assumption (a comment in the code now says it is unenforced), the future timestamp difference in the minimum gap check between the D1 and memory stores, the narrow window in `revokeUser` between deleting sessions and tombstoning families, and that a late put into a revoked family logs a reuse event for what is really a rotation race.


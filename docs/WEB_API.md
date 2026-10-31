# Web JSON API (T3.1)

Status: built in `apps/api/src/api/` and tested (`apps/api/test/webApi.*.test.ts`). This file describes what the code does. If a route or shape must change, record the change in the team's decision log and tell K.

Run it locally: `pnpm --filter @hippo/api dev` (port 8787). Everything is in memory and nothing talks to AWS.

## Rules that hold for every route

- Auth: the session cookie `hippo_session` from `@hippo/auth` (`POST /oauth/session`, HttpOnly, SameSite=Lax). The household comes from the session only. No route has a household id in the path, query or body, and a body that carries an extra key (for example `householdId`) is a 400.
- Same origin, no CORS headers. In the browser the web app must call `/api` and `/oauth` on its own origin. In development, use a Vite proxy for `/api` and `/oauth` to `http://localhost:8787`. The browser then sends `Origin: http://localhost:5173`, which the server allows because it is in `HIPPO_ALLOWED_ORIGINS` (default `http://localhost:5173,http://localhost:3000`).
- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) need an `Origin` header that is the request's own origin, the issuer origin, or one of `HIPPO_ALLOWED_ORIGINS`. A missing or other Origin is 403 `forbidden_origin`. Reads need no Origin.
- A write that has a JSON body needs `Content-Type: application/json` (415 otherwise). `DELETE /api/docs/<id>` has no body, so it needs no content type. The only non JSON write is the raw upload `PUT`.
- JSON bodies are at most 64 KiB (413). Every body is validated strictly: an unknown key, a wrong type or a missing key is 400.
- Errors are `{ "error": { "code": string, "message": string } }`: 400 `invalid_request`, 401 `unauthenticated`, 403 `forbidden_origin`, 404 `not_found`, 409 `conflict`, 413 `too_large`, 415 `unsupported_type`, 429 `rate_limited`, 500 `internal`. The message is plain English for a person. It never contains document text or a value you sent, and there is never a stack trace.
- Another household's id and an id that does not exist give the same 404 with the same body.
- Every answer has `Cache-Control: no-store`.
- Document text is untrusted. Every string that came from a document (`value`, `quote`, page text, labels, file names) is returned as a plain JSON string and the web app must render it as text, never as HTML.
- Numbers from documents (policy and account numbers) arrive already masked to the last 4. Dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 UTC.
- Every list is bounded: docs, alerts and assets at most 200, obligations at most 400, service history at most 50.
- Types come from the packages: `Doc` (without `s3Key`, which is never returned), `Agreement`, `Asset`, `ObligationRecord`, `Alert`, `ServiceEvent` from `core`; `FieldStatus`, `SourceRef`, `SourceRefTree` from `obligation-kit`.

## Session

| Route | Notes |
| :--- | :--- |
| `POST /oauth/session` | Body `{ email, code }` or `{ demo: true }`. Sets the cookie. Implemented by `@hippo/auth`, not by this API. |
| `POST /oauth/magic-code` | Body `{ email }`. The demo prints the code in the server log. |
| `POST /oauth/logout` | Clears the cookie. |
| `GET /api/me` | `{ email, digestOn }`. `email` is the digest address if one is saved, otherwise the login email. |

## Upload and documents

Allowed types: `application/pdf`, `image/jpeg`, `image/png` (exact match, no parameters). HEIC (`image/heic`, `image/heif`, or a `.heic` name) is 415 and the message tells the person to convert it to JPEG first (Textract does not accept HEIC). Size 1 byte to 15 MB (15,728,640 bytes): 0 or less is 400, more is 413. At most 30 announced uploads per household per hour (429 with `Retry-After`).

| Route | Request | Response |
| :--- | :--- | :--- |
| `POST /api/uploads` | `{ filename, contentType, size }` | `201 { docId, upload: { method: "PUT", url, headers, expiresInSeconds } }` and a Doc in status `uploaded`. In production `url` would be a presigned S3 URL; locally it is `/api/uploads/<docId>/content` (900 seconds). Send the file with exactly `upload.headers`. |
| `PUT /api/uploads/<docId>/content` | raw bytes (local mode only) | `204` |
| `GET /api/docs` | none | `{ docs: Doc[] }`, newest first |
| `GET /api/docs/<id>` | none | `{ doc: Doc, agreement: AgreementView \| null }` |
| `GET /api/docs/<id>/pages/<n>` | none | `{ page: n, text }` for "Show clause". Plain text. 404 when the document or that page does not exist. |
| `DELETE /api/docs/<id>` | none | `204`. Removes the file, page text, extracted fields, obligations, deadline alerts and the clause index entries of that document. |

The file name is a display label only: path parts, control and invisible characters are removed, it is at most 100 characters, and the object key is `uploads/<householdId>/<docId>/original.<pdf|jpg|png>`, built from ids, never from the name.

The local `PUT` checks: the doc belongs to the session household and is still `uploaded` and has no file yet (else 409 on a second PUT, 404 for another household), the `Content-Type` equals the declared one (415), the body has exactly the declared size (more is 413 and reading stops, fewer is 400), and the first bytes look like the declared type (415). After the bytes are stored the server runs the `onUploaded` hook and then answers 204.

Doc status values, in order: `uploaded`, `extracting`, `needs_review`, `active`, `failed`. Poll `GET /api/docs/<id>` every 2 seconds while status is `uploaded` or `extracting`. With the local server the hook runs before the 204, so the doc is already `needs_review` or `failed` when the PUT returns. A `failed` doc has `failureReason` in plain words.

```ts
interface AgreementView {
  id: string;
  kind: "warranty" | "insurance" | "lease" | "subscription" | "service_plan";
  // One entry per field the document stated, in the display order of the extraction schema.
  fields: {
    name: string; // for example "endDate", "contact"
    value: unknown; // plain value, array of strings, or an object for groups like contact
    status: "extracted" | "confirmed" | "edited";
    sourceRef: SourceRefTree | null; // { page, quote } | { page, quote }[] | { [part]: { page, quote } }, or null
    isDate: boolean; // true for the fields the "Confirm all dates" button covers
  }[];
}
```

`isDate` is true for date typed fields and for the fields a deadline is computed from. For a lease that includes `noticeDaysToVacate` and `noticeDaysType`, because the notice-by date needs them. So "Confirm all dates" sends exactly the names with `isDate: true`, and the notice-by alert appears.

### The ingest hook (dev fixture ingest and the real worker)

```ts
type OnUploaded = (event: { householdId: string; docId: string }) => Promise<void> | void;
```

`createApp({ ..., web: { objectStore, uploader, onUploaded, indexStore, origins } })`, all optional. The default `onUploaded` is a fixture ingest (`apps/api/src/api/fixtureIngest.ts`) that stands in for the real ingest worker (T2.2):

- If the uploaded bytes are SHA-256 identical to a file in `fixtures/docs/` (`*.pdf`, `*.jpg`), it reads the hand written `fixtures/expected/<stem>.json`, validates `fields` with `ExtractionSchemas`, flattens them, creates the Agreement (every field `extracted`, none confirmed), creates the obligations (so the timeline shows them as `needsConfirmation` with no severity and no alert exists), links an asset only when there is exactly one sure match (`linkAssetHint` for warranties and service plans, `linkVehicleHint` for an insurance policy with one vehicle, else `assetIds` stays empty), stores the page text from `fixtures/expected/pages/<stem>.json` under `pageTextKey(householdId, docId)` as `{"pages": string[]}`, adds the clause chunks to the household index, and sets the Doc to `needs_review` with its page count.
- Any other file goes to `failed` with `failureReason` "This build can only read the demo documents until the real reader is connected."
- If the hook throws, the doc becomes `failed` ("We could not read this file. Try uploading it again.").

The real worker plugs in by passing its own `onUploaded` (or by running outside the API on the S3 event, in which case the doc moves from `uploaded` to `extracting` to `needs_review` and the web app polls). Whatever runs must write the page text object at `pageTextKey` in the same JSON shape, update the clause index, create the Agreement with every field `extracted`, and create obligations with `syncObligations` (`apps/api/src/obligations.ts`).

## Review and confirm

| Route | Request | Response |
| :--- | :--- | :--- |
| `PATCH /api/agreements/<id>/fields/<name>` | `{ value }` | `{ field: FieldView }` with `status: "edited"`. The value is checked against the same value schema as extraction (`ExtractionSchemas[kind]`); 400 if it does not fit (for example `2026-02-30`, a negative count, a text over 500 characters). The source quote is kept. |
| `POST /api/agreements/<id>/confirm` | `{ fields: string[] }` | `{ agreement: AgreementView, obligations: ObligationRecord[] }`. Marks exactly the named fields `confirmed` and recomputes this agreement's obligations. |

- An unknown field name in the path is 404. A group or list (for example `contact`, `coverageSummary`) cannot be edited as one value: 400 "has several parts". It can still be confirmed.
- `confirm` takes 1 to 100 names, each must be a field the agreement has (400 otherwise, and nothing is changed). There is no wildcard. `__proto__`, `constructor` and the like are just unknown names.
- An obligation only gets a severity, and so only an alert, when every field it depends on is `confirmed` or `edited`. An edit counts as a person's confirmation, so a `PATCH` also recomputes obligations.
- When every field is `confirmed` or `edited`, a `needs_review` doc moves to `active`.

## Coming up, alerts, things

| Route | Request | Response |
| :--- | :--- | :--- |
| `GET /api/obligations?from=&to=` | ISO dates, default today to +90 days, at most 400 days, `to` not before `from` | `{ items: { obligation: ObligationRecord, needsConfirmation: boolean, docId?: string, assetId?: string }[] }`, by due date. Unconfirmed obligations are included with `needsConfirmation: true` and `severity: null`. Done or dismissed alerts do not hide an obligation here; match `alerts` by `refId` if you need that. |
| `GET /api/alerts?open=true` | `open` is `true` or `false`, or leave it out for all | `{ alerts: Alert[] }`, high first. `open=true` leaves out alerts snoozed until a later date. |
| `POST /api/alerts/<id>/resolve` | `{ action: "done" \| "dismiss" \| "not_mine" \| "snooze_7d" }` | `{ alert: Alert }`. Uses the same function as the voice tool `resolve_alert`. `not_mine` is for recalls only (it also writes a suppression); on a deadline alert it is 400. `snooze_7d` sets `snoozedUntil` seven days out. |
| `GET /api/assets` | none | `{ assets: Asset[] }` by name |
| `GET /api/assets/<id>` | none | `{ asset: Asset, docs: Doc[], agreements: AgreementView[], history: ServiceEvent[] }` |

"Today" is the server clock (fixed at 2026-10-21 for the demo unless `HIPPO_TODAY=now`).

## Settings and data

| Route | Request | Response |
| :--- | :--- | :--- |
| `PUT /api/settings` | `{ digestOn: boolean, email?: string }` | `{ digestOn, email }`. The email is trimmed, lower cased and validated, at most 254 characters. Leaving it out keeps the saved one. |
| `GET /api/export` | none | One JSON download (`hippo-export.json`): settings, documents, agreements with their quotes, assets and alerts for the household, masked like every other read. At most 5 a hour (429 with `Retry-After`). |
| `DELETE /api/data` | `{ confirm: "delete all my data" }` (exactly) | `204`. Deletes everything for the household, its files and its clause index. The session stays valid. |

## Dev walkthrough (the lease demo)

```
pnpm --filter @hippo/api dev            # prints the demo login; HIPPO_DEMO_CODE=123456 pins the code
curl -c jar -H "Content-Type: application/json" -H "Origin: http://localhost:8787" -d '{"demo":true}' http://localhost:8787/oauth/session
# announce, then PUT the exact bytes of fixtures/docs/lease.pdf
curl -b jar -H "Content-Type: application/json" -H "Origin: http://localhost:8787" -d '{"filename":"lease.pdf","contentType":"application/pdf","size":<bytes>}' http://localhost:8787/api/uploads
curl -b jar -X PUT -H "Origin: http://localhost:8787" -H "Content-Type: application/pdf" --data-binary @fixtures/docs/lease.pdf http://localhost:8787/api/uploads/<docId>/content
curl -b jar http://localhost:8787/api/docs/<docId>                       # needs_review, fields extracted
curl -b jar "http://localhost:8787/api/obligations?to=2027-01-31"        # notice_by needsConfirmation, no severity
curl -b jar -H "Content-Type: application/json" -H "Origin: http://localhost:8787" -d '{"fields":["startDate","endDate","noticeDaysToVacate"]}' http://localhost:8787/api/agreements/<agreementId>/confirm
curl -b jar "http://localhost:8787/api/alerts?open=true"                 # the notice alert is there now
```

The demo household (`hh_demo`) already has the five seeded documents, so it has a confirmed lease. To see a clean first run, delete `doc-lease` first (`DELETE /api/docs/doc-lease`) or sign in with a magic code for another email (a new empty household). The clock is 2026-10-21, so the notice date 2026-11-01 is 11 days away.

## Subscriptions

| Route | Request | Response |
| :--- | :--- | :--- |
| `GET /api/subscriptions` | none | `{ subscriptions: Subscription[], monthlyTotal }`, by vendor, at most 200. `Subscription` is `{ agreementId, docId, vendor, plan, amount, cycle, nextChargeDate, confirmed, source }`. `confirmed` means a person confirmed the price, the cycle and any next charge date, and only those count in `monthlyTotal`. `source` is `{ docName, page }`, or null for a subscription added by voice. |

## Extension API

For the browser extension, under `/ext`, not `/api`. Auth is `Authorization: Bearer` with scope `mcp:tools`, the token an OAuth client gets; a bad token is a bare 401. An `Origin` that is not allowed is 403. Errors have the shape above. Household id: from the token only.

| Route | Request | Response |
| :--- | :--- | :--- |
| `POST /ext/captures` | `{ title, host, text }`, strict. `host` is a site name, not an address. `text` is 1 to 60,000 characters. | `201 { saved: true, docId, reviewUrl }`, or `200 { saved: false }` when the page has no subscription and nothing was stored. |
| `GET /ext/subscriptions` | none | Same as `GET /api/subscriptions`. |

- 403: saving is off (no `onCaptured` hook). `apps/api/src/server.ts` loads the hook only when the server is bound to a loopback host, has a loopback issuer and no public domain (`isLocalOnly`). Anything else refuses.
- 409: the same text was saved already, or the household already tracks that vendor. `X-Hippo-Doc` holds the existing document id, when there is one.
- 422 `limit_reached`: the household already holds 200 saved pages. The message says to delete some in Hippo.
- 429: more than 30 saves per household per hour, or 60 list reads per household per minute, with `Retry-After`.
- Every `/ext` call also counts against a per address limit of 300 a minute, and every `/oauth` call against 120 a minute (429 in the OAuth shape `{ "error": "rate_limited" }`). The address is the socket address, or the header named by `HIPPO_CLIENT_IP_HEADER` on a host whose proxy writes it (`cf-connecting-ip`). A client can never choose its own bucket by sending that header unless the host names it.
- CORS: `Origin` must match the allowed list exactly (the extension's `chrome-extension://<id>` and the web origins). A preflight (`OPTIONS`) from a listed origin gets 204 with that origin echoed back, `Authorization, Content-Type` as allowed headers, no credentials and never `*`. Any other origin, including `null`, is 403.
- A saved page is a Doc with key `captures/<household>/<doc>/page.txt`, status `needs_review` and every field `extracted`. It then follows the normal review, confirm and delete routes.

## Not in this API

- Reading email or bank data, filing claims, cancelling subscriptions (out of scope).
- Anything that takes a household id.
- Recall lookups from the browser: recalls come from the daily job and arrive as alerts.
- A presigned S3 upload (`createS3Presigner`) is not built yet; the `Uploader` interface (`prepare({ key, contentType, size }) -> { method, url, headers, expiresInSeconds }`) is where it plugs in.
- Durable rate limit counters and persistence: the local server keeps files, the repository, sessions and counters in memory. A hosted server passes its own `RateLimiter`.

## Sign out and logging

- `POST /oauth/revoke` (RFC 7009, form body `token`, `client_id`): ends a refresh token and its whole family, including the token a rotation handed out last. Always 200, so a caller learns nothing about the token. Advertised as `revocation_endpoint`. The extension calls it on Sign out.
- `POST /oauth/logout-all` (JSON, cookie session): ends every web session and every refresh token of the person. Access tokens already issued end by themselves within 15 minutes.
- Every response carries `X-Request-Id`. The server logs one JSON line per request: `{ ts, id, method, path, status, ms }`, and security events as `{ ts, audit, sub, reason }` with a hashed `sub`. Query strings, headers, bodies, emails, codes and tokens are never logged.

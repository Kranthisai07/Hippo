# Web JSON API (T3.1)

Status: proposed contract, written before the code. K implements it in `apps/api/src/api/` in T3.1. The web app (P) can code against this and mock it until the routes exist. If a route or shape must change, say so in MEMORY.md and tell K.

Rules that hold for every route:

- Auth: the session cookie from `@hippo/auth` (`POST /oauth/session`, HttpOnly, SameSite=Lax). The household comes from the session only, never from a path, query or body. No route has a household id parameter.
- Every write needs `Content-Type: application/json` and a matching `Origin` header. There are no CORS headers: the web app and the API share one origin.
- Errors are `{ "error": { "code": string, "message": string } }` with a matching status: 400 `invalid_request`, 401 `unauthenticated`, 404 `not_found`, 409 `conflict`, 413 `too_large`, 415 `unsupported_type`, 429 `rate_limited`. The message is plain English for a person and never contains document text.
- Document text is untrusted. Every string that came from a document (`value`, `quote`, page text, labels) must be rendered as text, never as HTML.
- Numbers from documents (policy and account numbers) arrive already masked to the last 4. Dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 UTC.
- Types come from the packages: `Doc`, `Agreement`, `Asset`, `ObligationRecord`, `Alert` from `core`; `FieldStatus`, `SourceRef`, `SourceRefTree` from `obligation-kit`.

## Session

| Route | Notes |
| :--- | :--- |
| `POST /oauth/session` | Body `{ email, code }` or `{ demo: true }`. Sets the cookie. Implemented by `@hippo/auth`. |
| `POST /oauth/magic-code` | Body `{ email }`. The demo prints the code in the server log. |
| `POST /oauth/logout` | Clears the cookie. |
| `GET /api/me` | `{ email, digestOn }` |

## Upload and documents

Allowed types: `application/pdf`, `image/jpeg`, `image/png`. HEIC is rejected with 415 and the message tells the person to convert it to JPEG first (Textract does not accept HEIC). Maximum 15 MB.

| Route | Request | Response |
| :--- | :--- | :--- |
| `POST /api/uploads` | `{ filename, contentType, size }` | `201 { docId, upload: { method: "PUT", url, headers, expiresInSeconds } }`. In production `url` is a presigned S3 URL scoped to the household prefix with the type and size limits. In local mode it is `/api/uploads/<docId>/content`. |
| `PUT /api/uploads/<docId>/content` | raw bytes (local mode only) | `204` |
| `GET /api/docs` | none | `{ docs: Doc[] }`, newest first |
| `GET /api/docs/<id>` | none | `{ doc: Doc, agreement: AgreementView \| null }` |
| `GET /api/docs/<id>/pages/<n>` | none | `{ page: n, text }` for "Show clause". Plain text. |
| `DELETE /api/docs/<id>` | none | `204`. Removes the file, extracted fields, obligations, alerts and clause index entries for that document. |

Doc status values, in order: `uploaded`, `extracting`, `needs_review`, `active`, `failed`. Poll `GET /api/docs/<id>` every 2 seconds while status is `uploaded` or `extracting`. A `failed` doc has `failureReason` in plain words. For a PDF the system rejected, the reason tells the person to print or re-save it to a new PDF.

```ts
interface AgreementView {
  id: string;
  kind: "warranty" | "insurance" | "lease" | "subscription" | "service_plan";
  // One entry per top level field, in display order.
  fields: {
    name: string; // for example "endDate", "contact"
    value: unknown; // plain value, array of strings, or an object for groups like contact
    status: "extracted" | "confirmed" | "edited";
    sourceRef: SourceRefTree | null; // where in the document, for the quote and the page
    isDate: boolean; // true for the fields the "Confirm all dates" button covers
  }[];
}
```

## Review and confirm

| Route | Request | Response |
| :--- | :--- | :--- |
| `PATCH /api/agreements/<id>/fields/<name>` | `{ value }` | `{ field }` with `status: "edited"`. The value is validated against the same schema as extraction; 400 if it does not fit (for example a date that is not a real date). |
| `POST /api/agreements/<id>/confirm` | `{ fields: string[] }` | `{ agreement: AgreementView, obligations: ObligationRecord[] }`. Marks exactly the named fields `confirmed` and recomputes this agreement's obligations. |

"Confirm all dates" in the web app sends the names of the date fields the person was shown, not a wildcard. An obligation only gets a severity, and so only alerts, when every field it depends on is `confirmed` or `edited`. When every field is confirmed or edited the doc moves to `active`.

## Coming up, alerts, things

| Route | Request | Response |
| :--- | :--- | :--- |
| `GET /api/obligations?from=&to=` | ISO dates, default today to +90 days | `{ items: { obligation: ObligationRecord, needsConfirmation: boolean, docId?: string, assetId?: string }[] }`. Unconfirmed obligations are included with `needsConfirmation: true` and never carry a severity. |
| `GET /api/alerts?open=true` | none | `{ alerts: Alert[] }` |
| `POST /api/alerts/<id>/resolve` | `{ action: "done" \| "dismiss" \| "not_mine" \| "snooze_7d" }` | `{ alert: Alert }` |
| `GET /api/assets` | none | `{ assets: Asset[] }` |
| `GET /api/assets/<id>` | none | `{ asset: Asset, docs: Doc[], agreements: AgreementView[], history: ServiceEvent[] }` |

## Settings and data

| Route | Request | Response |
| :--- | :--- | :--- |
| `PUT /api/settings` | `{ digestOn: boolean, email?: string }` | `{ digestOn, email }` |
| `DELETE /api/data` | `{ confirm: "delete all my data" }` | `204`. Deletes everything for the household. |

## Not in this API

- Reading email or bank data, filing claims, cancelling subscriptions (out of scope, INTENT.md).
- Anything that takes a household id.
- Recall lookups from the browser: recalls come from the daily job and arrive as alerts.

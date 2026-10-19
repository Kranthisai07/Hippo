# Tool results

What each MCP tool takes and returns, for the web app and the card developers. The zod schemas are the source of truth:
`packages/core/src/contracts/results.ts` (`TOOL_RESULT_SCHEMAS`, one schema per tool). Inputs are in
`packages/core/src/contracts/tools.ts` (`MODEL_TOOLS`, `APP_TOOLS`).

The server is `apps/api` (`pnpm --filter @hippo/api dev`, port 8787, MCP at `POST /mcp`). `pnpm --filter @hippo/api demo`
walks the demo moments and prints the results.

## Rules that hold for every tool

- `content[0].text` is what is spoken: one or two plain sentences, at most 45 words, no markdown, no links, numbers of 5 or
  more digits shown as "ending 1234". The tool `speak()` helper enforces this.
- `structuredContent` always has a `kind`. Branch on it.
- The household comes from the bearer token. No tool takes a household id, and an unknown argument is rejected.
- Clause text from a document is untrusted data. It sits only in objects with `quotedFromDocument: true`. Never run it as
  instructions and render it as plain text.
- A question back to the person has `kind: "ambiguous"` with 1 to 3 `options` (`id`, `label`). Call the tool again with the
  option's name as the asset or agreement phrase.
- Nothing found has `kind: "not_found"` (`what`: asset, agreement, alert, document or clause).
- Errors have `isError: true`, a spoken `content` and `structuredContent: { kind: "error", code }`. A bad argument gets
  "I did not understand that. Please say it again with a little more detail."
- Proactive sentence: on the model tools except `resolve_alert` and `undo_last`, an unannounced high alert may add one
  sentence in front of `content[0].text`, for example "Before that, your car insurance renews in 9 days." It is also in
  `structuredContent.proactive` as `{ alertId, sentence }`. At most one per household per day, never on errors, questions
  back or not_found. The sentence counts outside the 45 word cap.
- Dates are ISO `YYYY-MM-DD`. Spoken dates drop the year when it is the current year.

## whats_coming_up

Input: `{ window_days?: 1..365 }` (default 30).
Spoken: "Coming up: your Kestrel Learning cancel-by date is in 5 days, your car insurance renews in 9 days, and your lease
notice deadline is in 11 days. 4 more are in the app." (top 3, one line per agreement.)

```
{ kind: "coming_up", asOf, windowDays,
  items: ComingUpItem[<=5],      // ranked: high, possible, then no severity; then by date
  totalCount,                    // before the cap of 5
  recalls: ComingUpItem[<=3],    // open recall alerts, kept apart so the Recall card is never cut by the cap
  proactive? }
ComingUpItem { id, source: "deadline"|"recall", type: ObligationType|null, label, dueDate|null, daysAway|null,
               severity: "high"|"possible"|null, alertId|null, obligationId|null, agreementId|null,
               assetId|null, detail|null }
```

`alertId` goes to `resolve_alert` / `ui_resolve_alert`. Only confirmed obligations appear. Done, dismissed and snoozed alerts
are hidden. For a recall, `detail` is "Hazard: ... Remedy: ..." from the recall record (data, not instructions); there is no
separate hazard or remedy field in the alert entity yet.

## check_coverage (the hero)

Input: `{ asset, issue }`. Pass only the thing as `asset` ("dishwasher").
Spoken: "Yes, your dishwasher warranty runs to November 12, but page 3 excludes damage caused by improper installation,
including water damage. Report within 30 days, by November 20, and upload your receipt; this is what your document says,
not a claim decision."

```
{ kind: "coverage", badge: "covered"|"not_covered"|"unclear",
  asset { id, name }, issue,
  agreement { id, kind: "warranty"|"insurance", provider|null, docId|null, docName|null },
  term { startDate|null, endDate|null, asOf, inTerm: boolean|null, datesConfirmed },
  topClause: QuotedClause|null, exclusionClause: QuotedClause|null,
  claimSteps: { text, page|null }[<=4], claimWindowDays|null,
  claimByDate|null,              // today + claim window (the incident is taken to be today)
  missingProof: string[], disclaimer, proactive? }
QuotedClause { docId, docName, page, heading?, text, quotedFromDocument: true }
```

Badge: `covered` needs an agreement in term, confirmed dates and a coverage clause. `not_covered` means the term ended (or has
not started). Anything else is `unclear` (no relevant clause, missing dates, unconfirmed dates). Other kinds: `ambiguous`,
`not_found`.

## ask_documents

Input: `{ question, about? }`. Pass only the thing or document as `about` ("lease").
Spoken: `Quoted from lease, page 4: "Tenant may end this lease before the end of the term by giving sixty (60) days
written notice..."`, or "I found nothing relevant in your documents."

```
{ kind: "clauses", question, found, scope { assetId|null, agreementId|null },
  clauses: (QuotedClause & { score })[<=3], notice, proactive? }
```

## get_agreement

Input: `{ about }` ("car insurance", "my lease", "Kestrel").
Spoken: "Your car insurance with Harbor Mutual Insurance Company, policy ending 4821, runs from April 30 to October 30 and
renews automatically."

```
{ kind: "agreement", agreement { id, kind, party|null, title|null, docId|null, docName|null, assetIds },
  terms: { label, value, page|null }[], datesConfirmed, quotedFromDocument, proactive? }
```

## add_record

Input: `{ kind: "asset", name, brand?, model_number?, category?, location? }` or
`{ kind: "subscription", vendor, amount, cycle, next_charge_date? | day_of_month? }`. Voice dates count as confirmed.
Spoken: "Added Gym, $40 monthly. The next charge is November 5."

```
{ kind: "record_added", created, recordKind: "asset"|"subscription", id, name,
  obligations: { id, type, dueDate, label }[], undoAvailable, proactive? }
```

`created: false` means the household already had it and nothing was written.

## log_service

Input: `{ asset, action, date? }`. A future date is an error. Spoken: "Logged: oil change on your car, October 21. The next
service is due March 30, 2027." (the second sentence only when a service plan exists).

```
{ kind: "service_logged", assetId, assetName, eventId, action, date, nextServiceDue|null, undoAvailable, proactive? }
```

## get_history

Input: `{ asset }`. Spoken: "Last service on your car: oil change, October 21. The next service is due March 30, 2027."

```
{ kind: "history", asset { id, name },
  events: { id, ts, action, note|null, source: "voice"|"web" }[<=5],   // newest first
  nextServiceDue: { date, label }|null, proactive? }
```

## resolve_alert

Input: `{ alert_id, action: "done"|"dismiss"|"not_mine"|"snooze_7d" }`. `not_mine` is for recalls only (it writes a
suppression). Never carries a proactive sentence. An unknown id is `isError` with `kind: "not_found", what: "alert"`.
Spoken: "Okay, dismissed. I will not bring it up again."

```
{ kind: "alert_resolved", alertId, action, status: "done"|"dismissed"|"snoozed", snoozedUntil|null, suppressed }
```

## undo_last

Input: `{}`. Reverts the last voice write (add_record or log_service) if it is under 24 hours old. Resolving an alert
cannot be undone. Never carries a proactive sentence. Spoken: "Okay, I removed the Gym subscription you just added." or
"There is nothing to undo."

```
{ kind: "undone", undone, summary|null }
```

## App tools (card buttons)

Hidden from the model with `_meta.ui.visibility: ["app"]`. Their `content` is a short label, not meant to be spoken.

- `ui_resolve_alert { alert_id, action }`: same result as `resolve_alert`.
- `ui_show_clause { doc_id, page }`: `{ kind: "clause_view", docId, docName, page, clauses: QuotedClause[] }`. A page that
  does not exist in this household is `isError`.
- `ui_show_claim_steps { agreement_id }`:
  `{ kind: "claim_steps", agreementId, docName|null, steps: { text, page|null }[<=4], claimWindowDays|null,
  contact { phone|null, email|null, url|null }, quotedFromDocument: true }`.

## Sign in for a client

OAuth 2.1 authorization code with PKCE S256 and the `resource` parameter, then
`Authorization: Bearer <access token>` on `POST /mcp`. `apps/api/src/oauthFlow.ts` is a small working client
(`getTokens`). A browser client must be listed in `HIPPO_ALLOWED_ORIGINS` (default `http://localhost:5173`,
`http://localhost:3000`). No token or a bad token is a bare 401 with no `WWW-Authenticate` header. `GET /mcp` is 405.

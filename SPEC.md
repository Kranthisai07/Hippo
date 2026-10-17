# SPEC.md: technical specification

This file defines **what** to build. PLAN.md defines **order and ownership**. INTENT.md defines **why**, and wins any conflict between the three.

## 0. Ground rules for every Claude Code session

1. **Live docs beat this file.** Before building on any SDK, API, or platform requirement, verify it with the `docs-verifier` subagent. If a doc disagrees with this file, follow the doc, tell the dev in one line, and log a Gotcha in MEMORY.md.
2. **Never invent** API fields, SDK methods, package names, or model IDs. If you can't confirm one, say "unverified" and ask.
3. **No LLM calls and no outbound network calls in MCP tool handlers.**
4. **Small commits, one concern each.** Use conventional messages.
5. **Ask before:**
   - any AWS deploy,
   - anything that costs money (provisioned concurrency, Textract or Bedrock beyond fixtures, SES production access),
   - publishing a package,
   - making the repo public.
6. **Writing style** for README, Devpost text, friction log, product feedback, and UI copy:
   - plain, specific, human,
   - no em dashes or en dashes,
   - no marketing filler.
7. **Friction log is live.** Log surprises in MEMORY.md Gotchas as they happen. Never invent entries afterward.

---

## 1. Hackathon and Alexa+ compliance checklist

### Devpost
- [ ] Primary track: Alexa+. Self-hosted MCP server, spec 2025-11-25+, Streamable HTTP.
- [ ] The repo actually imports and runs the MCP SDK.
- [ ] Public repo with an MIT license and working setup instructions.
- [ ] Video under 3 minutes, public, in English. No copyrighted music. Keep third-party logos out.
- [ ] Product feedback on every tool, SDK, and API used, with an AWS section.
- [ ] Friction log (up to a 10% bonus).
- [ ] Mini challenges:
  - **AWS Builder:** Bedrock, Textract, S3, Lambda, DynamoDB, EventBridge, SES, documented.
  - **Open Source:** `obligation-kit` (schemas, deadline engine, CPSC and NHTSA clients and matchers) as a separate MIT package published in the hackathon window.

### Alexa+ MCP (verify live in Phase 0)
- [ ] Streamable HTTP, no legacy SSE.
- [ ] Visuals follow MCP Apps (`@modelcontextprotocol/ext-apps`).
- [ ] Remote HTTPS URL.
- [ ] Round trip under 500 ms.
- [ ] **Auth:**
  - [ ] 401 without a `WWW-Authenticate` header.
  - [ ] RFC 9728 Protected Resource Metadata.
  - [ ] `/.well-known/oauth-authorization-server` with `code_challenge_methods_supported` including `S256`.
  - [ ] OAuth 2.1 authorization code with PKCE S256.
  - [ ] The `resource` parameter on authorize and token requests.
  - [ ] Bearer token in the `Authorization` header only.
  - [ ] No DCR, CIMD, or OIDC.
- [ ] Voice-only intelligible responses.
- [ ] **Add-on manifest** (if CLI access): privacy policy URL and terms URL. The web app serves both pages.

---

## 2. Architecture

```
                         ┌──────────────── Web app (React SPA) ────────────────┐
 User (browser) ───────► │ sign in · upload · review/confirm · Coming Up · delete│
                         └──────────────┬──────────────────────────────────────┘
                                        │ HTTPS (same OAuth AS, session cookie for web)
Alexa+ (voice/Echo Show) ─Streamable HTTP, Bearer─► api Lambda ─────────────┐
                                        │  /mcp  (tools, fast, no LLM/HTTP)  │
                                        │  /api  (web JSON API)              │
                                        │  /oauth, /.well-known/*            │
                                        ▼                                     ▼
                                    DynamoDB (single table)            S3 docs bucket (SSE-KMS)
                                        ▲      ▲                              │ ObjectCreated
                                        │      │                              ▼
              EventBridge daily ──► daily job   └──────────────── ingest worker Lambda
                (deadlines, alerts,                               1. text per page (pdf text layer,
                 SES email digest,                                   Textract for scanned/photo)
                 CPSC Recall Radar)                               2. classify doc type
                                                                  3. Bedrock structured extraction (strict JSON, zod)
                                                                  4. clause chunking + retrieval index
                                                                  5. records saved as needs_review
```

### Stack: one language, TypeScript, Node 22, pnpm monorepo

| Part | Choice |
| :--- | :--- |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP, stateless, JSON responses) and `@modelcontextprotocol/ext-apps` |
| HTTP | Hono on Lambda (one function serves `/mcp`, `/api`, `/oauth`, `/.well-known`). Verify Lambda plus Streamable HTTP in Phase 0. |
| Web | React + Vite + Tailwind SPA. Served as static files from the same Lambda or S3 + CloudFront; pick one in Phase 0. |
| Data | DynamoDB single table. DynamoDB Local for dev. In-memory repository for unit tests. |
| Documents | S3 with SSE-KMS and presigned PUT uploads. Max 15 MB, PDF/JPG/PNG/HEIC. |
| Text extraction | Use the PDF text layer when present (pdfjs). Use Textract for scanned PDFs and photos. Keep page numbers. |
| Extraction | Bedrock Converse with a current Claude or Nova model available in our region (verify; no old IDs). Strict JSON validated by zod. |
| Retrieval | In-process BM25 (e.g. MiniSearch, verify package) over clause chunks. Index serialized per household to S3 and cached in warm Lambdas, keyed by an index version. |
| Email | SES. Sandbox mode is fine for the demo, with verified recipient addresses. |
| IaC | CDK (TypeScript) or SAM; decide in Phase 0. |
| Tests | Vitest, an MCP SDK client E2E test, and a Playwright smoke test for the web app. |

### Repo layout

```
/apps
  /api              Hono app: mcp/, api/, auth/, ui/ (MCP Apps cards), lambda entry
  /web              React SPA
  /workers          ingest, daily (deadlines, alerts, digest, recall radar)
/packages
  /core             domain types, repository interface + dynamo/memory impls, retrieval, resolver
  /obligation-kit   OPEN SOURCE (MIT): zod schemas per doc type, deterministic deadline engine, CPSC + NHTSA clients and matchers
/infra
/fixtures           sample documents (synthetic, see §9), recorded CPSC responses, expected extractions
/docs               FRICTION_LOG.md, PRODUCT_FEEDBACK.md, DEMO_SCRIPT.md, ARCHITECTURE.md, PRIVACY.md, VERIFIED.md
INTENT.md SPEC.md PLAN.md MEMORY.md CLAUDE.md
```

---

## 3. Data model

Single table, `PK = HH#<householdId>`.

| SK | Entity | Key fields |
| :--- | :--- | :--- |
| `ASSET#<id>` | Thing owned or rented | `name`, `aliases[]`, `category` (appliance, vehicle, home, electronics, child_safety, other), `brand`, `modelNumber`, `upc`, `serialLast4`, `purchaseDate`, `location`, `vehicle{make, model, modelYear, nhtsaMake, nhtsaModel}` (canonical NHTSA spellings, set by the daily job, never by a tool handler) |
| `DOC#<id>` | Uploaded document | `s3Key`, `filename`, `docType`, `status` (uploaded, extracting, needs_review, active, failed), `pages`, `uploadedAt`, `assetIds[]` |
| `AGREEMENT#<id>` | Typed terms extracted from a doc, kind-specific (see §4) | `kind` (warranty, insurance, lease, subscription, service_plan), `docId`, `assetIds[]`, `fields{}`, `fieldStatus{field: extracted or confirmed or edited}`, `sourceRefs{field: {page, quote}}` |
| `OBLIGATION#<dueDate>#<id>` | Computed deadline | `type` (expires, renews, notice_by, charge, cancel_by, service_due, claim_by), `dueDate`, `agreementId` or `assetId`, `label`, `confirmed` (boolean, true only if all source fields are confirmed) |
| `EVENT#<assetId>#<ts>` | Service or maintenance log | `action`, `note`, `source` (voice, web) |
| `ALERT#<id>` | Something to surface | `source` (deadline, recall), `refId`, `severity` (high, possible), `status` (pending, announced, done, dismissed), `announcedAt`, `emailedAt` |
| `SUPPRESS#<source>#<recallId>#<assetId>` | Recall marked "not mine" (source: cpsc or nhtsa) | |
| `CHUNKMETA#<docId>` | Pointer to the clause chunks in S3 and the index version | |
| `UNDO#<ts>` | Inverse of the last voice write, TTL 24 h | |

GSI1 is used for upcoming obligations and open alerts per household.

---

## 4. Extraction schemas (in `obligation-kit`, zod)

Every field is nullable. Every non-null field carries `sourceRef {page, quote <= 200 chars}`. Missing beats guessed.

- **warranty:**
  - `provider`, `assetHint{brand, model, serial}`
  - `startDate`, `termMonths` or `endDate`
  - `coverageSummary[]`, `exclusions[]`
  - `claimSteps[]`, `claimWindowDays`, `contact{phone, email, url}`
  - `requiresProofOfPurchase`
- **insurance:**
  - `insurer`, `policyType` (auto, renters, home, other), `policyNumberLast4`
  - `effectiveDate`, `expirationDate`, `renewal` (auto or manual), `premium{amount, cycle}`
  - `deductibles[]`, `coverages[]`, `exclusions[]`
  - `claimSteps[]`, `claimReportWindowDays`, `contact`
  - `coveredAssetHints[]` (vehicle make, model, year)
- **lease:**
  - `landlord`, `address` (unit only on cards)
  - `startDate`, `endDate`, `rentAmount`, `rentDueDay`, `lateFeeRule`
  - `noticeDaysToVacate`, `renewalTerms`, `earlyTerminationTerms`, `securityDeposit`
  - `maintenanceResponsibilities[]`, `contact`
- **subscription:**
  - `vendor`, `plan`, `amount`, `cycle`, `nextChargeDate`
  - `trialEndDate`, `cancelNoticeDays`, `cancelMethod`, `accountEmailHint`
- **service_plan:** `provider`, `assetHint`, `intervalDays` or `nextServiceDate`, `included[]`.

**Classification:** first pass is Bedrock with a fixed label set plus `other`. On `other`, store the document as searchable but create no agreement.

---

## 5. Deadline engine (deterministic, in `obligation-kit`)

Pure functions from confirmed fields and today's date to obligations. Covers:
- **Warranty:** `expires` = start + term; `claim_by` = incident date + claim window (computed at check time).
- **Insurance:** `renews` / `expires`; `claim_by` from the report window.
- **Lease:**
  - `notice_by` = endDate minus noticeDays (calendar days unless the clause says business days; then use business days with US federal holidays),
  - `expires`,
  - monthly `charge` on rentDueDay.
- **Subscription:**
  - `charge` on nextChargeDate, rolled forward by cycle,
  - `cancel_by` = nextChargeDate minus cancelNoticeDays,
  - `trial_end`.
- **Service:** `service_due` = last EVENT + interval.

**Rules:**
- Alerts for confirmed obligations within 30 days. High severity within 14 days for `expires`, `renews`, `notice_by` and `cancel_by`; within 7 days for `charge`, `service_due`, `trial_end` and `claim_by` (D-015).
- Unconfirmed obligations show in the web app as "needs confirmation" and never alert.

Unit tests: at least 40 cases, including month-end rollover, leap years, business-day notice, an already-passed notice window, and a subscription with a trial.

---

## 6. MCP tools (9 model-facing + app-only)

Descriptions are prompts for Alexa's model. Each one states what the tool does, when to use it, when **not** to (naming the sibling tool), and 2 or 3 example utterances, in under about 600 characters.

| Tool | Purpose |
| :--- | :--- |
| `whats_coming_up(window_days=30)` | Upcoming confirmed obligations plus open alerts, ranked. Coming Up card. |
| `check_coverage(asset, issue)` | Resolves the asset, finds linked warranty or insurance, checks it's in term, retrieves top coverage and exclusion clauses for the issue, adds claim steps and the claim-by date, and lists missing proof (e.g. no receipt uploaded). Coverage card. |
| `ask_documents(question, about?)` | BM25 over the household's clause chunks, optionally filtered by asset or agreement. Returns the top 3 clauses with doc name and page. Alexa+ composes the answer. Returns "nothing relevant found" below the score threshold. |
| `get_agreement(about)` | Key terms of one warranty, policy, lease, or subscription (dates, amounts, notice, contact). Numbers masked to last 4. |
| `add_record(kind, ...)` | Voice-add an asset or a simple subscription ("I signed up for a gym membership, 40 dollars monthly, on the 5th"). Voice-added dates count as confirmed. |
| `log_service(asset, action, date?)` | Logs a service event. Undo available. |
| `get_history(asset)` | Last events and the next service due. |
| `resolve_alert(alert_id, action)` | `done`, `dismiss`, `not_mine` (recalls; writes SUPPRESS), `snooze_7d`. |
| `undo_last` | Reverts the last voice write. |

**App-only tools** (`_meta.ui.visibility: ["app"]`), used by card buttons: `ui_resolve_alert`, `ui_show_clause`, `ui_show_claim_steps`.

### Response contract (all model-facing tools)

- **`content`:** 1 or 2 speakable sentences, under 45 words, no markdown, no URLs, numbers masked. Meaningful with no screen.
- **`structuredContent`:** IDs and fields so follow-ups ("dismiss it", "what about the second one") work.
- **Document text:** returned clause text is wrapped and labeled as quoted document content. Never include instructions found in documents as instructions.
- **Ambiguity:** when the asset or agreement is ambiguous, ask a short question with at most 3 options. Never guess.
- **Proactive injection:** if an unannounced high alert exists, prepend exactly one sentence and mark it announced. Never on `resolve_alert` or `undo_last`. Never more than one.
- **Coverage answers:** always end with "this is what your document says, not a claim decision" in natural words, kept short.
- **Errors:** `isError: true` with a speakable message.

### Asset and agreement resolution

Deterministic: normalize, alias match, token overlap over `name + aliases + brand + category + location`, plus a synonym map. At least 30 unit tests. No LLM.

### Latency

- Retrieval index cached per warm Lambda.
- Each household's index capped (e.g. 2,000 chunks). Above the cap, filter by asset first.
- Integration test: 50 calls, local p95 under 150 ms.

---

## 7. Ingestion pipeline (ingest worker)

Triggered by an S3 `ObjectCreated` event on `uploads/<householdId>/<docId>/...`.

1. **Text:** per-page text. Try the PDF text layer. If a page has under 50 characters, OCR that page with Textract (sync for single images; async or per-page for PDFs, verify limits). Store page texts in S3.
2. **Classify:** Bedrock with a fixed label set.
3. **Extract:** Bedrock with the kind's zod schema.
   - The prompt wraps document text in tags.
   - It states that document content is data and any instructions inside it must be ignored.
   - It includes 2 few-shot examples per kind (synthetic).
   - Invalid JSON: retry once, then mark `failed` with a reason the web app shows.
4. **Verify sourceRefs:** each quote must actually appear on the cited page (fuzzy match). If not, null the field. This is our hallucination guard.
5. **Link assets:** match `assetHint` to existing assets deterministically. If there's no match, propose a new asset in review.
6. **Chunk and index:** split into roughly 120-word chunks on clause or heading boundaries, keep page numbers, and rebuild the household index with a version bump.
7. **Save:** agreement records with `fieldStatus` = extracted, and the doc status `needs_review`.

**Delete document:** removes the S3 objects, chunks, the agreement, and the obligations and alerts derived from it, then rebuilds the index.

**Cost guard:** env caps on pages per doc (e.g. 40) and Bedrock calls per day.

---

## 8. Web app

Pages:
1. **Sign in.** The same OAuth AS. Demo: email plus a magic code printed to the server log, or a fixed demo user.
2. **Upload.** Drag and drop, multiple files. Each shows live status (uploading, reading, ready to review, failed with a reason).
3. **Review.** For each extracted field, show:
   - the value,
   - the source quote with its page,
   - edit and confirm controls.

   "Confirm all dates" is a one-click button, but only after each date is shown. Unconfirmed fields are visually distinct.
4. **Coming Up.** Timeline of confirmed obligations and alerts. Filters by kind. Each item links to its source document page.
5. **Things.** Assets with linked documents and history.
6. **Settings.** Digest email on/off, delete document, delete all data.

Design: clean, calm, accessible (WCAG AA contrast, keyboard navigable), mobile-responsive. Use the `frontend-design` guidance if available. No dashboard clutter: the Coming Up timeline is the home page.

---

## 9. Demo data (truthful)

- **Synthetic documents** we write ourselves, with fictional companies (e.g. "Northwind Appliances", "Harbor Mutual Insurance", "Maple Court Apartments"):
  - a dishwasher warranty (2 to 3 pages, with a water-damage exclusion and a 30-day claim window),
  - an auto insurance declarations page,
  - a 12-month lease with a 60-day notice clause,
  - two subscription confirmations, one with a trial ending soon.
  
  Generate them as real PDFs in Phase 0. Make one of them a phone photo, to exercise OCR.
- **One real CPSC recall** for the car seat (or another child product) found in Phase 0. The seeded asset must truthfully match the recall record.
- **One real NHTSA recall** for the insured car. Pick a real make, model, and year with a recent campaign in Phase 0. The insurance declarations page (fictional insurer) lists that vehicle. The car recall appears as a secondary alert, not a demo beat.
- **Dates** are set relative to the demo recording day so the deadlines fall inside the window.

---

## 10. Daily job (EventBridge)

1. Recompute obligations for every household (cheap and deterministic).
2. Create or refresh alerts per §5.
3. Recall Radar, CPSC (consumer products):
   - fetch by `LastPublishDateStart` / `LastPublishDateEnd`, always with `format=json`,
   - parameter allowlist plus a result-count ceiling (unknown params return the whole database),
   - filter hazards client side,
   - match on UPC, or on normalized model number plus brand, to get `high`,
   - brand plus product-name overlap gives `possible`, and only appears when asked,
   - respect SUPPRESS.
4. Recall Radar, NHTSA (vehicle assets only):
   - canonicalize make and model once via `api.nhtsa.gov/products/vehicle/models?modelYear=&make=&issueType=r`, and store `nhtsaMake` / `nhtsaModel` on the asset (NHTSA needs its own spellings, e.g. `F-150` not `F150`),
   - query `api.nhtsa.gov/recalls/recallsByVehicle?make=&model=&modelYear=`,
   - a canonical make, model, and year match gives `high`, but the spoken and card text always says "may affect your car" (results are not VIN-specific) and points to checking the VIN on nhtsa.gov,
   - store the NHTSA campaign number as the recall ID; respect SUPPRESS,
   - rate limit 1 request per 250 ms with backoff.
5. **Email digest via SES:** only households with digest on and at least one new or high alert. Plain, short, with a link to the web app. Never include full policy or account numbers.

`pnpm daily:run` runs it on demand for the demo.

---

## 11. MCP Apps cards (3)

1. **Coming Up:** next 5 items, each with a date chip, kind icon, one-line label, and a "Done" or "Dismiss" button.
2. **Coverage:**
   - the asset,
   - a covered / not covered / unclear badge with the term dates,
   - the top clause (quoted, with doc and page),
   - the exclusion clause if relevant,
   - claim steps (max 4),
   - the claim-by date,
   - missing-proof warning,
   - buttons "Show clause" and "Claim steps".
3. **Recall:** product, hazard (one line), remedy (one line), confidence label, and buttons "How to fix", "Mark done", "Not mine".

**Rules (verify against the Alexa+ MCP Design Guide and the layout and rendering docs):**
- Author at 768×480 and let Alexa scale. Large type, low density, native feel, light and dark mode from `hostContext`.
- Single-file Vite builds.
- Content-hashed `ui://` URIs with MIME type `text/html;profile=mcp-app`.
- Strict `_meta.ui.csp`.
- Talk to the host only through the MCP Apps bridge.
- Full meaning in text for clients without MCP Apps.

---

## 12. Auth, security, privacy

**Auth (one OAuth 2.1 AS inside the api Lambda):**
- `/oauth/authorize` (login page), `/oauth/token`, and both well-knowns.
- One pre-registered Alexa client (no DCR), PKCE S256, `resource` validated.
- JWT access tokens carry `householdId`.
- The web app uses the same login with a secure HttpOnly session cookie.
- A scripted full-flow test.

**Security:**
- zod on every input.
- Every query is scoped by `householdId` from the token, never from arguments.
- Presigned URLs are scoped to the household prefix, short TTL, with content-type and size limits.
- Strict CSP on the web app and cards.
- Secrets in SSM.

**Privacy:**
- SSE-KMS on S3.
- Mask numbers in voice, cards, and email.
- `docs/PRIVACY.md` plus a privacy and terms page in the web app.
- Delete document and delete all data actually delete.
- Log no document text in CloudWatch.

---

## 13. Templates

### Friction log entry

```
### FL-<nnn>: <title>
- Area:
- Task attempted:
- Steps taken:
- Expected:
- Actual:
- Severity: blocker | major | minor
- Workaround:
- Suggestion:
```

### Product feedback entry

```
## <Tool / SDK / API>
- Used for:
- Worked well:
- Needs work:
- Onboarding:
- Would build with it again:
```

---

## 14. Demo script (2:45 cap; judges may stop at 3:00)

| Time | Beat |
| :--- | :--- |
| 0:00 to 0:12 | Hook: paperwork you never read twice, and the deadlines it hides. |
| 0:12 to 0:50 | **Moment 1.** Drop the lease, warranty, and insurance PDFs into the web app. The lease shows "Give notice by Jun 1" with the page 4 quote. Click confirm. The Coming Up timeline fills. |
| 0:50 to 1:35 | **Moment 2.** "Alexa, my dishwasher is leaking, am I covered?" The spoken answer, then the Coverage card with the exclusion clause on page 3, the claim steps, and the claim-by date. Tap "Claim steps". |
| 1:35 to 1:55 | **Moment 3.** Next voice question. The interjection: "Before that, your car insurance renews in 9 days." The Coming Up card shows the subscription cancel-by date. Cut to the email digest in an inbox. Show the recall card for the car seat. |
| 1:55 to 2:30 | How it works: 20-second architecture diagram. The pipeline in a terminal: OCR on the phone photo, strict JSON extraction, quote verification nulling a hallucinated field, the deterministic deadline engine. The latency test output. |
| 2:30 to 2:45 | Trust and close: nothing alerts until confirmed; citations everywhere; the open-source `obligation-kit`; AWS services; repo link. |

---

## 15. Sources to verify live (Phase 0)

- **Alexa+ MCP QuickStart:** https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart
- **Alexa+ docs index:** https://developer.amazon.com/docs/llms.txt
- **Alexa+ client lifecycle:** https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle
- **Alexa+ design guide, layout and rendering, Local Inspector, testing:** QuickStart sidebar
- **MCP Apps:** https://modelcontextprotocol.io/docs/extensions/apps
- **MCP spec 2025-11-25:** https://modelcontextprotocol.io/specification/2025-11-25
- **Bedrock Converse** (document input, structured output) and **Textract** (sync/async limits): AWS docs
- **SES sandbox rules:** AWS docs
- **CPSC Recalls API:** https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information
- **NHTSA Datasets and APIs:** https://www.nhtsa.gov/nhtsa-datasets-and-apis
- **Devpost rules:** https://amazonappdev2026.devpost.com/ and `/rules`

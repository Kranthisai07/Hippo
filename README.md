# Hippo

Hippo turns the paperwork a household never reads twice (warranties, insurance, a lease, subscriptions, recall notices) into dated obligations, and watches them while nobody is talking. It is an Alexa+ add-on with a web app for uploading and reviewing documents.

> **Status: working build, Alexa+ hackathon.** Today the repo contains the demo fixtures, the deadline engine, the asset resolver, the source quote check, asset linking, recall matchers, PDF page text extraction, the daily digest builder and daily job, the repository (memory and DynamoDB), the clause index, an OAuth 2.1 server, the MCP server with its nine tools, the web JSON API, the web app, the /ask demo client with its cards, the ingest pipeline and a CDK stack that has never been deployed, with 3090 passing tests (3361 in CI, which adds the DynamoDB Local suite). The ingest pipeline runs in fixture mode by default, so only the demo documents are read; its live Bedrock and Textract adapters exist and have only run against fakes. The cards are plain React, not the MCP Apps host bridge. Nothing is deployed. [What exists today](#what-exists-today) is the honest list.

## Repository layout

| Path | What it is |
| :--- | :--- |
| `apps/api` | The MCP server (nine tools), the OAuth endpoints and the web JSON API, on Hono. Data is in memory, seeded from the fixtures |
| `apps/web` | The React web app (upload, review, Coming up, Things, Settings) and the `/ask` demo MCP client |
| `apps/workers` | The ingest pipeline and the daily job (deadline alerts, recall radar, digest email) |
| `packages/obligation-kit` | Deadline engine, extraction schemas, source quote check and CPSC and NHTSA matchers. One dependency (zod); network access only through an injected fetch |
| `packages/core` | Asset resolver and linking, the repository (memory and DynamoDB), clause index, PDF page text, digest builder |
| `packages/auth` | OAuth 2.1 server, sessions and tokens |
| `infra` | CDK stack. Synthesized and template tested, never deployed |
| `fixtures` | Synthetic demo documents, expected extractions and saved real recall responses |
| `docs` | Architecture, privacy, web API, tool results, demo script, verified docs check, product feedback and friction log |
| `.github/workflows`, `docker-compose.yml`, `scripts` | CI, DynamoDB Local for the repository tests, and stubs for commands that are not built |

## Why

The cost of household paperwork shows up as missed deadlines: a lease notice window that closed, a warranty that ran out three weeks before the dishwasher leaked, a subscription that renewed at full price, a recalled product still in use.

Alexa+ can already store notes and answer questions about documents you give it. It does not turn those documents into dated obligations, join them (this item, this receipt, this warranty, this exclusion), or watch them in the background. That gap is the product.

## The three moments

1. **Upload to deadline.** Drop a lease PDF into the web app. Seconds later it shows "Give notice by Nov 1" with the quoted clause and page. You confirm the date.
2. **Voice coverage check.** "Alexa, my dishwasher is leaking, am I covered?" The answer: yes, in warranty until a date, but water damage from improper installation is excluded (page 3), and here is how to file within 30 days. The Echo Show shows the clause and the claim steps.
3. **Proactive catch.** The next voice question starts with one sentence: "Before that, your car insurance renews in 9 days." A Coming Up card shows a subscription cancel-by date, and a Recall card shows a recalled child product.

## How it is meant to work

```
 Browser ──► Web app (upload, review, confirm, Coming Up)
                │ HTTPS, one OAuth login
 Alexa+ ──► api Lambda  /mcp  tools, no LLM, no outbound HTTP
                │         /api  web JSON
                │         /oauth
                ▼
           DynamoDB ◄──── daily job: deadlines, alerts, recall check, email digest
                ▲
                └──── ingest worker: text per page, Bedrock extraction,
                      quote check, clause index   (S3 upload triggers it)
```

Planned, not built. Four rules shape everything:

- **No unconfirmed alarms.** A date a model extracted creates no alert until a person confirms it in the web app.
- **The voice path is fast and dumb.** Tool handlers make no LLM calls and no outbound HTTP. All reading happens at upload time. Document questions use in-process keyword retrieval, and Alexa+ writes the spoken answer from the clauses we return. Target round trip: under 500 ms.
- **Cite or do not claim.** Any answer from a document names the document and the page.
- **Documents are hostile input.** Text inside an upload is data, never instructions.

Details are in docs/ARCHITECTURE.md, docs/PRIVACY.md and docs/WEB_API.md.

## What exists today

| Part | State |
| :--- | :--- |
| Demo fixtures: 5 synthetic PDFs and a phone-photo JPG, fictional companies only | Done, in [fixtures/](fixtures/README.md) |
| Hand-written expected extractions with page numbers and source quotes | Done, every quote checked against its page by `generate.py` |
| Real recall data: CPSC 26530 (baby bottles, matched by UPC) and NHTSA campaigns for a 2021 Honda CR-V | Done, raw API responses saved |
| Deadline engine (`packages/obligation-kit`) | Done, 160 tests |
| Source quote check (`packages/obligation-kit`): drops any extracted field whose quote is not on the page it cites | Done, 71 tests |
| Asset and agreement resolver (`packages/core`): turns "my fridge" into one asset, or asks | Done, 89 tests |
| Asset linking (`packages/core`): matches a document's brand, model and serial, or a vehicle, to an owned asset, or proposes a new one | Done, 61 tests |
| Recall matchers (`packages/obligation-kit`): CPSC and NHTSA parsers and matchers. `high` only on a UPC, a model plus brand on the same product, or the confirmed vehicle year, make and model; a failing API can never read as "no recalls" | Done, 253 tests |
| PDF page text extraction (`packages/core`): text per page with stable page numbers, pages flagged for OCR, size, page and time limits. The OCR call itself is a stub | Done, 69 tests |
| Daily digest email builder (`packages/core`): short plain and HTML email, numbers masked to the last 4, everything from documents escaped. Sending through SES is not built | Done, 159 tests |
| Live docs check (`docs/VERIFIED.md`): what AWS, Alexa+, MCP, CPSC and Devpost documentation says against what this project assumed, checked twice | Done |
| CI: both packages plus the fixture quote check on every push and PR | Added, runs on GitHub |
| MCP server (`apps/api`): 9 tools and 3 card button tools over stateless Streamable HTTP, OAuth 2.1 with PKCE (`packages/auth`), in memory data seeded from the fixtures | Done, `pnpm test:latency` measured p95 under 150 ms locally. The /ask page draws the cards as plain React from the tool results, not through the MCP Apps host bridge |
| Ingestion pipeline (`apps/workers/src/ingest`): page text, structured extraction, the quote check and asset linking | Built. Fixture mode is the default and reads only the demo documents (8 of 8 dates and 58 of 58 fields match the expected files). The live Bedrock and Textract adapters have only run against fakes |
| Web JSON API (`apps/api/src/api`, contract in `docs/WEB_API.md`): upload, review and confirm, Coming Up, assets, settings, with a dev fixture ingest for the demo documents | Done. The web app (`apps/web`: sign in, upload, review, Coming up, Things, Settings) and the /ask demo client are built on top of it |
| Daily job (`apps/workers`): deadline alerts, recall radar, digest and a dry run (`pnpm daily:run`) | Done, never run against live CPSC or NHTSA. The SES adapter (`--send-ses --yes-really`) sent one real digest on 2026-10-21 from a sandbox account to a verified address; tests use a fake client. The AWS deploy is not done |

### The deadline engine

Pure functions from confirmed fields and today's date to obligations. No dependencies, no network, no clock (today is a parameter). It covers warranty expiry, insurance renewal, lease notice-by (calendar or business days with US federal holidays), rent, subscription charge and cancel-by, trial end, and service due.

On the demo fixtures at 2026-10-21 it produces:

| Obligation | Due | Days | Severity |
| :--- | :--- | :--- | :--- |
| Kestrel trial: cancel by | Oct 26 | 5 | high |
| Kestrel trial ends | Oct 28 | 7 | high |
| Car insurance renews | Oct 30 | 9 | high |
| Lease: give notice by | Nov 1 | 11 | high |
| Fernwood: cancel by | Nov 2 | 12 | high |
| Fernwood: next charge | Nov 3 | 13 | possible |
| Dishwasher warranty expires | Nov 12 | 22 | possible |

An obligation whose source fields are not all confirmed always has severity `null`, so it cannot alert. Severity windows live in one table, `HIGH_WITHIN_DAYS` in [severity.ts](packages/obligation-kit/src/severity.ts).

## Run the demo

Needs Node 22.13 or newer and pnpm (the version is pinned in `package.json`). No AWS account, no Docker and no keys: everything runs on your machine with a synthetic household.

```bash
pnpm install --frozen-lockfile
pnpm dev        # terminal 1: API, OAuth and MCP server on http://localhost:8787 (in memory, seeded from the fixtures)
pnpm dev:web    # terminal 2: the web app on http://localhost:5173
```

Open http://localhost:5173 (use `localhost`, not `127.0.0.1`) and press the demo sign in button. The public landing page, a scroll story of what Hippo does, is at http://localhost:5173/welcome. A static copy of that page can be hosted: import the repository in Vercel with the root directory `apps/web` (build settings are in `apps/web/vercel.json`, which builds with `VITE_HOSTED=1`; the demo and the app need the local API, so on the hosted page the demo buttons point to these run steps).

1. **Upload to deadline.** Settings, delete `lease.pdf` (it is pre loaded), then Upload and drop `fixtures/docs/lease.pdf`. Coming up shows "Give notice by 2026-11-01" waiting for you. Open "Review and confirm", click the page 4 quote, press "Confirm all dates": only now does it become a reminder.
2. **Coverage by voice.** Open http://localhost:5173/ask, press "Sign in as the demo account" and click "My dishwasher is leaking, am I covered?". This page is a real MCP client (OAuth with PKCE, then `tools/call` over Streamable HTTP). It shows the spoken answer and the Coverage card: the page 3 exclusion, the claim steps and the claim by date.
3. **Proactive catch.** The first answer after the server starts begins with "Before that, your car insurance renews in 9 days." Click "What is coming up?" for the Coming Up and Recall cards. `pnpm daily:run` prints the daily digest (a dry run).

`pnpm --filter @hippo/api demo` walks the same moments in a terminal. The server clock is pinned to 2026-10-21 so the dates in the fixtures are always "in the window"; set `HIPPO_TODAY=now` to use the real date. The demo reads only the sample documents in `fixtures/docs` (see the limits below). The browser tests need their browser once: `pnpm --filter @hippo/web exec playwright install chromium`, then `pnpm --filter @hippo/web test:e2e` with ports 8787 and 5173 free.

## Run it

Needs Node 22.13 or newer (the PDF library requires it), pnpm (version pinned in `package.json`) and Python 3.9 or newer.

```bash
git clone https://github.com/Kranthisai07/Hippo.git && cd Hippo
pnpm install --frozen-lockfile && pnpm test && pnpm typecheck   # obligation-kit 531, core 1054 (1325 in CI with DynamoDB Local), auth 306, api 693, workers 363, web 118, infra 25
pnpm --filter @hippo/api demo   # walks the demo moments through a real MCP client
pip install reportlab pypdf pillow && python fixtures/tools/generate.py
```

The last command rebuilds the PDFs, the photo and the expected JSON, and fails if any expected source quote is missing from its cited page. The phone-photo JPG is drawn with Arial when found, so on another machine it will differ slightly from the committed copy. The quote check is unaffected.

## Honest limits

- Reminders arrive at your next Alexa+ interaction or in a daily email. There is no device push, because add-ons have no documented push API.
- Recall matches are conservative. `high` only comes from a UPC match, an exact model number plus brand, or a confirmed vehicle make, model and year. Vehicle recalls always say "may affect", because NHTSA data is not VIN specific.
- Coverage answers say what the document says and what the deadline is. They are not a claim decision, and not legal or insurance advice.
- The phone-photo fixture has not been run through a real OCR engine yet.
- `trial_end` and `claim_by` use a 7 day high window. That is an assumption (D-015 does not name them), kept in one table.
- Monthly rent shows on the timeline but never raises an alert (D-020), so it cannot crowd out a notice or cancel deadline.
- Recall matches are deliberately cautious: a brand that appears only in a description, or on a different product than the model, is at most `possible`. The recall network clients are for the daily job only and are kept out of the package barrel.
- The CPSC recall API reports a database failure as a normal response with a fake record, and its UPC filter is unreliable (it returned an empty list for a UPC that exists), so the code treats that record as an error and matches UPCs itself.
- Page text extraction fails closed: it rejects a PDF whose page count it cannot verify, and it caps decompression before the PDF library runs. The cost is some false rejects: PDFs saved incrementally (annotated, filled or signed forms), some encrypted PDFs with compressed object streams, and scans that decode past the size caps are refused with a typed error. Printing or re-saving the file to a new PDF is the workaround. A document built on purpose to hide its own pages from the scan can still lose them, and work inside one PDF library call cannot be interrupted, so the ingest Lambda memory and timeout are the final backstop. Extracted text cannot tell visible from hidden text and is always treated as untrusted.
- The digest masks any run of 5 or more digits, so a date like "Dec 5, 2026" inside document text is shown as "Dec ****2026". That is the safe side.
- The resolver asks instead of guessing. "tv" with only a "TV stand" gets a question, and a whole sentence like "my dishwasher isn't working" returns nothing, so the voice tool must pass just the thing.

## Hackathon

- **Track:** Alexa+ (self-hosted MCP server, Streamable HTTP).
- **Mini challenges:** Open Source (`obligation-kit` as a separate MIT package). AWS Builder is not entered: it needs a real Bedrock call and none succeeded (docs/PRODUCT_FEEDBACK.md).
- **Built in the hackathon window:** everything in this repo.
- **Demo data:** all documents are synthetic with fictional companies (Northwind Appliances, Harbor Mutual Insurance, Maple Court Apartments, Fernwood Streaming, Kestrel Learning). The recalls are real public records.

What went wrong and what we would change is in docs/FRICTION_LOG.md and docs/PRODUCT_FEEDBACK.md.

## License

[MIT](LICENSE)

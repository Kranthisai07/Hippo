# PLAN.md: build order and task board

Two developers, both full-stack:
- **K** = Kranthi
- **P** = partner (replace with their initial everywhere)

SPEC.md says what to build, INTENT.md says why, and MEMORY.md holds live status. This file says who does what, and when.

## Working agreement

1. **Claim before you start.** Add a line under your name in MEMORY.md Progress (`[K] T2.3 in progress, branch t2.3-extract`). One task per person at a time.
2. **Lanes don't collide.** Each phase has Lane A and Lane B touching different folders. Pick a lane, finish it, then swap if you're ahead.
3. **Contracts first.** T1.1 defines the repository interface, entity types, extraction schemas, and tool zod schemas. After it merges, changing them needs a Decision entry in MEMORY.md and a heads-up to the other dev.
4. **Branch per task. PR into `main`.**
   - The other dev reviews within 2 hours.
   - If they're asleep, run the `reviewer` subagent and merge on its PASS.
5. **Main stays green.** Every merge runs `pnpm test`, the latency test, and typecheck.
6. **Sync at 9 PM CT daily, 10 minutes.**
   - Update Progress.
   - Log decisions.
   - Pick tomorrow's lanes.
   - Check the cut list against reality.
7. **Every Claude Code session** starts by reading CLAUDE.md, which points at INTENT, SPEC, PLAN, and MEMORY. It ends by updating MEMORY.md.

## Subagents (`.claude/agents/`)

| Agent | Use it for |
| :--- | :--- |
| `docs-verifier` | Before building on any external SDK, API, model, or Alexa+ rule |
| `mcp-tool-builder` | MCP tools, descriptions, schemas, response contract, latency |
| `pipeline-builder` | Ingest worker, extraction schemas, deadline engine, daily job, CPSC radar, SES digest |
| `web-app-builder` | React SPA: upload, review/confirm, Coming Up, settings |
| `mcp-apps-ui` | The 3 Echo Show cards and the MCP Apps bridge |
| `reviewer` | Read-only PASS/FAIL review of a branch before merge |
| `submission-writer` | README, ARCHITECTURE, PRODUCT_FEEDBACK, friction log, DEMO_SCRIPT, Devpost text |

---

## Phase 0: Verify and scaffold (Sat Oct 17, 9 AM to 1 PM CT, together)

| ID | Task | Who |
| :--- | :--- | :--- |
| T0.1 | Both run `alexa-ai configure`. Log whether the CLI installs and authenticates for each account. | both |
| T0.2 | `docs-verifier` covers the SPEC §15 sources and writes `docs/VERIFIED.md`. Include: Lambda plus Streamable HTTP, the Bedrock model ID and document input, Textract limits, MiniSearch, SES sandbox, and Local Inspector setup. | K |
| T0.3 | Write the 5 synthetic demo documents as PDFs (one as a phone photo). Find a real CPSC recall for a child product (baby bottles, D-016) and a real NHTSA recall for the insured car (make, model, year). Save to `/fixtures` with hand-written expected extractions. | P |
| T0.4 | Monorepo scaffold: apps/api, apps/web, apps/workers, packages/core, packages/obligation-kit. Strict TS, eslint, prettier, vitest, DynamoDB Local compose, GitHub Actions CI. | K |
| T0.5 | Decide CDK vs SAM, and SPA hosting (same Lambda vs S3 + CloudFront). Log both as decisions. | P |

**Gate:**
- CI is green.
- `VERIFIED.md` lists every mismatch with SPEC.
- Fixtures and expected extractions are committed.
- Alexa+ access status is logged as D-ALEXA.

---

## Phase 1: Core engine and voice basics (Sat Oct 17, afternoon to night)

| ID | Task | Lane |
| :--- | :--- | :--- |
| T1.1 | **Contracts:** entity types, repository interface, the 5 extraction zod schemas, the 9 tool schemas. Merge first. | A (K) |
| T1.2 | Repository: memory + DynamoDB implementations, keys, GSI1. Tests against both. | A (K) |
| T1.3 | Deadline engine in `obligation-kit`, 40+ tests (SPEC §5). | B (P) |
| T1.4 | Resolver (assets, agreements) with 30+ tests, plus a synonym map. | B (P) |
| T1.5 | MCP server on Hono, stateless Streamable HTTP. Tools `add_record`, `log_service`, `get_history`, `get_agreement`, `whats_coming_up`, `undo_last`. E2E via the MCP SDK client, plus the latency test. | A (K) |

**Gate:**
- E2E and latency tests pass.
- MCP Inspector shows the tools with good descriptions.
- The deadline engine passes on the fixture agreements.

---

## Phase 2: Ingestion pipeline and retrieval (Sun Oct 18)

| ID | Task | Lane |
| :--- | :--- | :--- |
| T2.1 | Text extraction per page: PDF text layer plus Textract fallback, stored by page. | B (P) |
| T2.2 | Classification and extraction with Bedrock: prompts, few-shots, strict JSON, retry, and the sourceRef quote verification. Fixture mode for tests. | B (P) |
| T2.3 | Chunking, BM25 index build and serialization, and an index cache in the api Lambda. | A (K) |
| T2.4 | Tools `ask_documents` and `check_coverage` (retrieval, in-term check, claim-by, missing proof). | A (K) |
| T2.5 | Asset linking and the delete-document cascade. | B (P) |

**Gate:**
- All 5 fixture docs go from upload to `needs_review`, with extracted fields matching expectations (at least 90% of fields; 100% of dates).
- `check_coverage("dishwasher", "leak")` returns the exclusion clause with the correct page.
- p95 is still under 150 ms locally.

---

## Phase 3: Web app (Mon Oct 19)

| ID | Task | Lane |
| :--- | :--- | :--- |
| T3.1 | Web JSON API in apps/api: presigned upload, doc status, review/confirm/edit fields, obligations, assets, delete. | A (K) |
| T3.2 | SPA: sign-in (demo mode until T4.1), upload with live status, Review page with source quotes. | B (P) |
| T3.3 | SPA: Coming Up timeline (home), Things, Settings. Playwright smoke test. | B (P) |
| T3.4 | Daily job: obligations, alerts, CPSC radar, `pnpm daily:run`. Proactive injection in the tools. | A (K) |
| T3.5 | NHTSA radar: model canonicalization, `recallsByVehicle` client, vehicle matcher, "may affect" wording, fixtures and tests, in `obligation-kit`. | B (P), after T3.3 |

**Gate:** in a local run, the full flow works: upload the lease, see "notice by", confirm it, see it on Coming Up, and ask by voice in MCP Inspector to get it back.

---

## Phase 4: Cards, auth, deploy (Tue Oct 20)

| ID | Task | Lane |
| :--- | :--- | :--- |
| T4.1 | OAuth 2.1 AS per the Alexa+ checklist, plus the web session. Scripted full-flow test. | A (K) |
| T4.2 | MCP Apps cards: Coverage first, then Coming Up, then Recall. Local Inspector across frames, with screenshots in `docs/screens`. | B (P) |
| T4.3 | IaC and deploy (**ask both first**): api Lambda, workers, S3 + KMS, DynamoDB, EventBridge, SES, SSM. Measure cold and warm latency. Provisioned concurrency only if both agree. | A (K) |
| T4.4 | SES digest email and its template. If CLI access exists: add-on scaffold, `addon.json`, deploy to the development stage, test in the web simulator. | B (P) |

**Gate:**
- The deployed OAuth flow works.
- Warm p95 is under 500 ms.
- Cards render in all frames.
- A digest email arrives at a verified address.

---

## Phase 5: Hardening and open source (Wed Oct 21)

| ID | Task | Lane |
| :--- | :--- | :--- |
| T5.1 | Edge cases: an unknown asset, two "water filters", a doc with no dates, a prompt-injection doc (must be ignored), a failed OCR, an expired warranty, a passed notice window. | A (K) |
| T5.2 | Publish `obligation-kit` (README, MIT, tests). **Agree first.** | B (P) |
| T5.3 | README, ARCHITECTURE, PRIVACY via `submission-writer`. Clean-clone run. | B (P) |
| T5.4 | Two full demo dry runs. Fix what breaks. | both |

**Gate:** a clean clone, following the README, reaches the working local demo.

---

## Phase 6: Submission (Thu Oct 22)

| ID | Task | Who |
| :--- | :--- | :--- |
| T6.1 | PRODUCT_FEEDBACK.md (every tool and API, plus an AWS section). | K |
| T6.2 | FRICTION_LOG.md from MEMORY.md Gotchas, real entries only. | K |
| T6.3 | Record the video (SPEC §14, 2:45 cap). Upload as public. | P |
| T6.4 | Devpost form: track, both mini challenges, repo, package URL, feedback, friction log. Repo public. Tag `v1.0.0`. | both |

**Submit by 9:00 PM CT Thursday.** Friday morning is buffer only.

---

## Cut list (cut in this order if behind at any 9 PM sync)

1. Snooze, Things page, history on cards.
2. NHTSA radar (T3.5). Keep CPSC.
3. CPSC Recall Radar. Keep the alert plumbing; demo deadline alerts only.
4. Photo OCR. Text-layer PDFs only (drop the phone-photo beat).
5. Coming Up card. Keep it voice-only plus the web timeline.
6. Live add-on in the web simulator. Local Inspector only.
7. Provisioned concurrency. Report warm latency honestly.

**Never cut:**
- the confirm-before-alert rule,
- citations with page numbers,
- the Coverage card,
- auth,
- the latency test,
- the open-source package,
- the web upload and review flow.

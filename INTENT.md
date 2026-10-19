# INTENT.md: Hippo

Read this before any task. If a task, a doc, or a teammate pushes against something here, stop and raise it. Don't route around it.

## Why this exists

Every household runs on paperwork it never reads twice:
- product warranties
- car insurance
- a lease
- subscriptions that renew silently
- service schedules
- recall notices nobody sees

The cost shows up as missed deadlines:
- a lease notice window that closed,
- a warranty that expired three weeks before the dishwasher leaked,
- a subscription that renewed at full price,
- a recalled baby bottle set still in use.

Alexa+ can already store notes and answer questions about documents you send it. It does not:
- turn those documents into **dated obligations**,
- **join** them (this item, this receipt, this warranty, this exclusion),
- watch them **while nobody is talking**.

That gap is the product.

## What we are building

A household obligations engine with two front doors.

1. **Web app (upload and review).** Sign in and upload any document about anything the household owns or pays for: warranty, receipt, insurance policy, lease, subscription confirmation, service record.
   - A background pipeline reads each document and extracts typed fields: dates, terms, notice periods, coverage, exclusions, claim steps, and contacts.
   - The user **confirms** the extracted dates before they can trigger anything.
   - A dashboard shows what's coming up.
2. **Alexa+ add-on (voice and Echo Show).** Ask and act by voice:
   - "What's coming up this month?"
   - "My dishwasher is leaking, am I covered?"
   - "When does my car insurance renew?"
   - "What does my lease say about breaking it early?"
   - "I just had the furnace serviced."

Behind both doors, one engine:
- **Deadline engine.** Computes obligations from confirmed fields:
  - warranty and policy expirations,
  - renewal dates,
  - lease notice-by dates,
  - subscription charge and cancel-by dates,
  - service due dates.
- **Coverage check.** Item, then linked warranty or policy, then whether it's in term, then the relevant coverage and exclusion clauses with page citations, then the claim steps and the claim deadline.
- **Recall Radar.** A nightly check of owned products against CPSC (consumer products) and the car against NHTSA (by make, model, and year). Matches become alerts in the same alert stream.
- **Reminders:**
  - one sentence at the next Alexa+ interaction,
  - a daily email digest for anything due soon.

## Who it's for

The person in a household who "keeps track of everything" and is tired of being the system. Demo persona: a renter with a car, a few appliances, two subscriptions, and a set of baby bottles.

## The moments that must land (in this order)

1. **Upload to deadline.** The user drops a lease PDF into the web app. Seconds later the app shows "Notice required 60 days before end. Give notice by Jun 1." The user confirms the date.
2. **Voice coverage check.** "Alexa, my dishwasher is leaking, am I covered?" Alexa answers:
   - yes, still in warranty until a given date,
   - but water damage from improper installation is excluded (page 3),
   - and here's how to file within 30 days.

   The Echo Show shows the coverage card with the clause and the claim steps. **This is the hero moment.**
3. **Proactive catch.** The next voice question starts with one sentence: "Before that, your car insurance renews in 9 days." The Coming Up card also shows a subscription cancel-by date, and the Recall card shows a baby bottle recall.

Everything we build serves one of these moments or the trust behind them.

## Principles (non-negotiable)

1. **Obligations, not storage.** "Remembers documents" is Alexa's feature. Our value is computed deadlines and cross-document answers. Never pitch storage.
2. **No unconfirmed alarms.** A date extracted by a model creates no alert until a human confirms it in the web app. Recall alerts are "high" only on deterministic evidence: a UPC match, an exact model number plus brand, or the confirmed vehicle make, model, and year on NHTSA. Model judgments cap at "possible."
3. **The voice path is fast and dumb.**
   - MCP tool handlers do no LLM calls and no outbound HTTP.
   - All reading and extraction happens at upload time, in the background.
   - Document questions are answered by fast in-process clause retrieval. Alexa+ composes the spoken answer from the clauses we return. Round trip stays under 500 ms.
4. **Cite or don't claim.** Any answer drawn from a document names the document and page. If retrieval finds nothing relevant, say so. Never paraphrase coverage from memory.
5. **Not legal or insurance advice.** Coverage answers say what the document says and what the deadline is. They never promise a claim will be approved.
6. **Documents are hostile input.** Uploaded text can contain instructions. It is data everywhere: in extraction prompts, in clause results returned to Alexa+, in the web app.
7. **Sensitive by default.**
   - Encrypt documents at rest.
   - Mask policy and account numbers in voice and on cards (last 4 only).
   - Let the user delete a document and everything derived from it.
8. **One alert per answer, once.** Never nag. Dismissed means dismissed.
9. **Live docs beat our files.** Where Alexa+, MCP, Bedrock, Textract, or CPSC docs disagree with these files, follow the docs and log the gap in MEMORY.md.

## Explicitly out of scope (for the hackathon)

- Reading the user's email or bank to discover subscriptions automatically. Users upload or say them.
- Filing claims or canceling subscriptions on the user's behalf.
- FDA recalls. VIN-level vehicle recall lookup (NHTSA matching is by make, model, and year, so we say "may affect").
- Push notifications on Alexa devices. No documented add-on API; see Q-001 in MEMORY.md.
- Multiple household members with separate permissions.
- Mobile apps. The web app is responsive.
- Languages other than English.

## Done means

**Alexa+ add-on**
- [ ] Self-hosted MCP server, spec 2025-11-25+, Streamable HTTP, at an HTTPS URL. Warm p95 round trip under 500 ms.
- [ ] Alexa+ auth checklist passes: OAuth 2.1 with PKCE S256, the `resource` parameter, Protected Resource Metadata, and a 401 without `WWW-Authenticate`. The same login serves the web app.
- [ ] 9 model-facing tools and 3 MCP Apps cards (Coming Up, Coverage, Recall). Every tool is voice-only intelligible.

**Web app and engine**
- [ ] Web app: sign in, upload (PDF and photo), review and confirm extracted fields, a Coming Up dashboard, and delete document.
- [ ] Ingestion pipeline: S3, text extraction with page numbers, Bedrock structured extraction with strict JSON per document type, clause chunks indexed for retrieval.
- [ ] Daily job: computes deadlines, raises alerts, sends the email digest. Nightly Recall Radar on CPSC and NHTSA.

**Submission**
- [ ] `obligation-kit` published as a separate MIT package (Open Source mini challenge).
- [ ] Public repo, MIT license, README that works from a clean clone.
- [ ] Demo video under 3:00 that hits the three moments in order.
- [ ] Product feedback and a real friction log in the Devpost submission.
- [ ] Submitted by **Thu Oct 22, 9:00 PM CT** (hard deadline Fri Oct 23, 12:00 PM PDT).

## How we judge our own work

Devpost criteria: Tech Implementation, Design, Potential Impact, Quality of the Idea. Before merging anything, ask: does this make one of the three moments land harder in a 3-minute video? If not, it waits.

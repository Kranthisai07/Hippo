# MEMORY.md: shared project memory

The team's working memory. Every dev and every Claude Code session reads it at the start and updates it at the end.

## Rules

- **Append-only** in Decisions, Gotchas, and Open questions. To change a decision, add a new entry with `supersedes D-nnn`. Never edit an old entry.
- **Progress** is the only section edited in place, and only your own lines.
- **Tag every entry:** `[K]` or `[P]`, plus `+claude` if a Claude Code session wrote it.
- **Keep entries short.** One line where possible. Link PRs, commits, or files instead of pasting code.
- **Gotchas feed the friction log.** Fill the friction line while it's fresh.
- **No em or en dashes.**
- **Never paste secrets,** tokens, or real personal data here.

---

## Progress

Format: `[owner] TaskID status (in progress | in review | done | blocked: reason), branch or PR`

### K
- (none yet)

### P
- [P] T0.3 in review, branch t0.3-fixtures
- [P] T0.5 in review (recommendation logged as D-IAC, K to confirm), branch t0.3-fixtures
- [P] T1.3 in review, branch t1.3-deadline-engine (133 tests)

### Blocked / waiting on the other dev
- (none)

### Phase gates
- [ ] Phase 0, Verify and scaffold (Sat AM)
- [ ] Phase 1, Core engine and voice basics (Sat)
- [ ] Phase 2, Ingestion pipeline and retrieval (Sun)
- [ ] Phase 3, Web app (Mon)
- [ ] Phase 4, Cards, auth, deploy (Tue)
- [ ] Phase 5, Hardening and open source (Wed)
- [ ] Phase 6, Submitted (Thu 9 PM CT)

---

## Decisions

Format: `D-nnn | date | [owner] | decision | why | supersedes`

- D-001 | 2026-10-16 | [K] | Track: Alexa+. Mini challenges: AWS Builder and Open Source | Stack fits all three | none
- D-002 | 2026-10-16 | [K] | Product is a household obligations engine: documents become confirmed, dated obligations and cited coverage answers | Alexa+ already stores notes and answers questions about uploaded docs; computed deadlines and cross-document joins are the gap | none
- D-003 | 2026-10-16 | [K] | Upload door is a web app behind the same OAuth login | Alexa+ add-ons have no documented file upload path; team choice | none
- D-004 | 2026-10-16 | [K] | Reminders: one sentence at next Alexa+ interaction plus a daily SES email digest | No documented push API for add-ons | none
- D-005 | 2026-10-16 | [K] | Recall Radar: CPSC only; NHTSA is stretch | Scope; CPSC covers the car-seat moment | none
- D-006 | 2026-10-16 | [K] | No alert from any model-extracted date until a human confirms it; recall "high" only from deterministic evidence | False alarms kill trust | none
- D-007 | 2026-10-16 | [K] | No LLM or outbound HTTP in MCP tool handlers; document Q&A is in-process BM25 retrieval, and Alexa+ composes the answer | 500 ms round-trip limit | none
- D-008 | 2026-10-16 | [K] | TypeScript, Node 22, pnpm monorepo; Hono api Lambda serves /mcp, /api, /oauth | One toolchain for two devs; official MCP Apps package is TS | none
- D-009 | 2026-10-16 | [K] | Demo documents are synthetic with fictional companies; the recall is real | Truthful demo, no real PII, no trademark issues in video | none
- D-010 | 2026-10-16 | [K] | Demo household locked: dishwasher warranty, auto insurance, lease, 2 subscriptions, 1 recalled car seat | Scope; K may overturn | none
- D-011 | 2026-10-16 | [K] | Both devs full-stack, claiming tasks by lane | Team choice | none
- D-012 | 2026-10-16 | [K] | Recall Radar covers CPSC and NHTSA (vehicles by make, model, year; always "may affect") | Team choice; the car is already in the household via insurance | supersedes D-005
- D-013 | 2026-10-16 | [K] | Hero demo moment is the warranty coverage check; household also shows lease notice date, car insurance renewal, 2 subscriptions (one trial), recalled car seat | Team choice | supersedes D-010
- D-014 | 2026-10-16 | [K] | Reminders: next Alexa+ interaction plus daily SES email digest; no SMS | 10DLC registration risk before deadline | confirms D-004
- D-ALEXA | pending | | Live add-on vs Local Inspector as primary demo surface | After T0.1 | none
- D-IAC | pending | | CDK vs SAM; SPA hosting | T0.5 | none
- D-NAME | pending | | Final product name ("Homefile" is a working name; check for collisions) | Before README | none
- D-IAC | 2026-10-16 | [K]+claude | IaC: CDK (TypeScript), not SAM. SPA hosting: served by the api Lambda (static assets bundled, Cache-Control set), not S3 + CloudFront. Proposed, K to confirm. | CDK keeps one language and one toolchain with the monorepo and covers Lambda, Function URL, S3 + KMS, DynamoDB, EventBridge, SES, SSM in typed code; SAM is YAML and splits us across two. Same-Lambda SPA means one origin (cookie and OAuth stay simple), one deploy, and no extra hop on the 500 ms /mcp path; revisit if the SPA bundle passes about 2 MB or the Lambda response limit bites. CloudFront OAC in front of a Function URL is unverified, so not relied on | supersedes D-IAC (pending)
- D-015 | 2026-10-16 | [K]+claude | `expires` and `renews` obligations are high within 14 days, same as `notice_by` and `cancel_by`; `charge` and `service_due` stay at 7 days. `trial_end` and `claim_by` keep the 7 day rule (assumption, not stated). SPEC section 5 and fixtures/expected/obligations.json updated. Answers Q-006 part 1 | The 9 day insurance renewal must be high so moment 3 can speak it, since proactive injection only fires on high alerts | none
- D-016 | 2026-10-16 | [K]+claude | Demo CPSC recall is 26530, Boon NURSH 8 oz Reusable Baby Bottles (TOMY), UPC 669028116546, replacing Joolz 26568. Seeded asset A-baby-bottles carries that UPC, so the matcher yields high; the matching rule is not loosened. Answers Q-006 part 2. INTENT, SPEC and D-013 still say "car seat"; the demo recall is now a baby bottle | Joolz 26568 has no UPC or Model, so it could only be possible. Scan of 594 CPSC recalls from the last 12 months found 18 with a Model or UPC, and 26530 is the only child product among them; no car seat qualified | refines D-013
- D-IAC | 2026-10-16 | [K]+claude | Confirmed: CDK (TypeScript) for IaC; SPA served by the api Lambda | K approved the 2026-10-16 recommendation | supersedes D-IAC (pending)
- D-017 | 2026-10-17 | [K]+claude | T1.3 deadline engine built in packages/obligation-kit before T0.4 (scaffold) and T1.1 (contracts) merged. It takes plain field-value objects named as in SPEC section 4 (no zod, no repository types) and returns obligations with `confirmed` and `severity`. Severity windows live in one table (severity.ts HIGH_WITHIN_DAYS). Standalone npm setup (vitest, typescript) to be replaced by the pnpm workspace when K's T0.4 lands | User chose to start T1.3 now rather than wait; thin inputs mean T1.1 can adopt or rename with no logic change | none

---

## Gotchas (feed docs/FRICTION_LOG.md)

Format:

```
G-nnn | date | [owner] | area | what happened | workaround
  friction: task / expected / actual / severity / suggestion
```

The entries below are known from research on 2026-10-16. Re-verify each in Phase 0, then delete this line.

- G-001 | 2026-10-16 | [K] | CPSC | Default response is XML; must send `format=json` | Always set it
- G-002 | 2026-10-16 | [K] | CPSC | Unknown parameter names return the whole recall database; no pagination; Hazard filter reported broken | Param allowlist, result ceiling, client-side hazard filter
- G-003 | 2026-10-16 | [K] | Alexa+ auth | 401 must NOT carry `WWW-Authenticate`, unlike the generic MCP auth spec; no DCR or OIDC | Follow the Alexa+ checklist exactly
- G-004 | 2026-10-16 | [K] | Alexa+ | Tool info refreshes only on `alexa-ai deploy` | Redeploy after any tool or description change
- G-005 | 2026-10-16 | [K] | Alexa+ access | Another entrant reports the toolkit CLI comes from a private registry | Local Inspector fallback; confirm in T0.1
- G-006 | 2026-10-16 | [K] | Alexa+ | Client lifecycle docs mention elicitation and UI resources, but no notifications, server-initiated messages, or file uploads | Next-invocation alerts plus email; web upload
- G-007 | 2026-10-16 | [K] | NHTSA | `recallsByVehicle` needs NHTSA's own make and model spellings and is keyed by make, model, year (not VIN) | Canonicalize via `products/vehicle/models`; say "may affect"
- G-008 | 2026-10-16 | [K]+claude | CPSC | Record 26569 has Title "Joolz Recalls Aer2 Car Seat Adapters..." but is a CooCooBaby baby lounger recall | Match on Products[].Name and Description, never Title alone. Fixture: recalls/cpsc/recall_26569_title_mismatch_record.json
  friction: recall matching / Title reflects the product / Title belongs to a different recall / major / validate Title against Products[].Name server side
- G-009 | 2026-10-16 | [K]+claude | CPSC | Joolz recall 26568 has empty ProductUPCs and empty Model; the only identifier is "NL311" in free text. Across the 80 child product recalls my 6 keyword searches found for the last 12 months, only 1 (TOMY Boon bottle) listed a UPC and none listed a Model | Joolz asset can only be "possible" under INTENT principle 2; see Q-006
  friction: recall radar / UPC or model on child product recalls / both empty / major / expose identifiers as structured fields
- G-010 | 2026-10-16 | [K]+claude | NHTSA | recallsByVehicle ReportReceivedDate is DD/MM/YYYY (21/05/2026), not ISO | Parse explicitly in obligation-kit
  friction: NHTSA client / ISO date / day-first string / minor / document the format or return ISO
- G-011 | 2026-10-16 | [K]+claude | NHTSA | recallsByVehicle with model=CRV returns Count 0 and no error; correct spelling is CR-V. The models endpoint returns duplicate rows | Canonicalize via products/vehicle/models and dedupe; extends G-007
  friction: NHTSA client / error or fuzzy match on a near miss / silent zero results / major / return a message on unknown model

---

## Open questions

Format: `Q-nnn | asked by | question | answer when known`

- Q-001 | [K] | Can an add-on push a notification or create an Alexa reminder? | Docs silent as of 2026-10-16; assume no
- Q-002 | [K] | Does the Local Inspector need add-on approval, or just a dev account? | T0.2
- Q-003 | [K] | Does Streamable HTTP in stateless JSON mode run cleanly on Lambda behind a Function URL? | T0.2
- Q-004 | [K] | Which Bedrock model in our region accepts PDF document input and gives reliable JSON? | T0.2
- Q-005 | [K] | Partner's name and initial for this file | K to fill
- Q-006 | [K]+claude | Two demo conflicts. (1) SPEC 5 makes a 9 day insurance renewal "possible", but the proactive injection only fires on unannounced high alerts, so moment 3 would not speak. Widen the rule for renews, or change the injection? (2) The recall seed (Joolz adapter) cannot reach "high" with no UPC or model, so the Recall card would say "possible". Accept that, or let the user add NL311 as a model number? | K to decide

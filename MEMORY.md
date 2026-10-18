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
- [P] T1.3 done, merged in PR #3
- [P] T1.4 done, merged in PR #4
- [P] T2.2 (quote check part) and T2.5 (asset linking part) in review, branch pramod (231 and 150 tests)

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
- D-018 | 2026-10-17 | [K]+claude | T1.4 resolver lives in packages/core/src/resolver with plain AssetLike and AgreementLike inputs (SPEC section 3 names), own npm setup until T0.4 and T1.1 land. Returns match, ambiguous (max 3 candidates) or none; never guesses: more than half the query words must match and a tie asks. Question and problem words (leaking, say, show) are stripped, so the tool layer should still pass the asset phrase alone | T1.1 has not merged; thin inputs let it adopt or rename with no logic change. Tool descriptions for check_coverage should tell Alexa to pass just the thing, not the whole sentence | none
- D-019 | 2026-10-17 | [K]+claude | Resolver stoplist no longer holds work, working, cover, covered or show. They are real name words: with assets Work laptop and Personal laptop, "my laptop" silently matched the work laptop. Now it asks. Corrects the stoplist detail in D-018. The tool layer must still pass the asset phrase alone, so a whole sentence like "my dishwasher isn't working" returns none, the safe result | Found by ponytail review of T1.4, confirmed with a probe; 5 new tests, 3 of them fail if the words are put back | corrects D-018
- D-020 | 2026-10-17 | [K]+claude | Lease rent stays on the timeline as a `charge` but never gets a severity, so it never reaches Alexa or the digest. Notice, expiry, renewal and cancel deadlines still alert. SPEC section 5 updated. Refines D-015 for rent only | The audit showed rent making a high alert every month, which breaks INTENT principle 8 (never nag) and would crowd out the deadlines that matter; user chose "never alert on rent" | refines D-015
- D-021 | 2026-10-17 | [K]+claude | Demo recall wording changed from car seat to baby bottles in INTENT.md, SPEC.md and PLAN.md. MEMORY history is left as written | D-016 made the recall a Boon NURSH bottle set, and INTENT wins every conflict, so INTENT had to change; user chose this option. INTENT.md is shared with K, flagged in the PR | confirms D-016
- D-022 | 2026-10-17 | [K]+claude | Resolver rule is now strict. Every query word must be explained by the asset, and at least one must be a head word (last non-numeric word of the name or an alias, or a category or brand word). One strong candidate matches; an exact name wins among several; otherwise it asks (max 3, sorted by name then id). Candidates that merely contain the words become a question, never an answer. The weighted score and the `score` field are gone. Hyphen join is limited to model names (CR-V, F-150) and accents are folded. Resolves Q-008 and corrects D-018 and D-019 | The reviewer run FAILed the old scoring with 4 blocking cases ("fridge" returned the fridge water filter, "tv" returned the TV stand, "upstairs bathroom fan" returned Downstairs, a Bosch model name with category dishwasher returned none). All now ask or match correctly, covered by 18 new tests, each checked by mutation | supersedes D-018
- D-023 | 2026-10-17 | [K]+claude | Follow-ups from the independent review of D-022. Agreements use the same head-word rule as assets: a word of the agreement's own name or a head word of a linked asset says what it is, so "fridge warranty" for the Fridge water filter's warranty is a question, not an answer. The trial dedupe (D-016 era fix) only drops a same-day charge when trial_end is confirmed too, so a confirmed charge keeps its alert | The reviewer found "tv warranty" returning the TV stand's warranty and a confirmed charge losing its alert when only the trial end was unconfirmed; 4 new tests, mutation checked | refines D-022
- D-024 | 2026-10-17 | [K]+claude | Source quote check (obligation-kit `verifySourceRefs`) and asset linking (core `linkAssetHint`, `linkVehicleHint`), built before T1.1 with plain shapes. Quote check: a leaf is `{value, sourceRef: {page, quote}}` as in fixtures/expected; a failed object field becomes null, a failed array item is removed, a value with no usable source is dropped. Quotes are folded (case, spacing, hyphenation, quotes, ligatures) and must be on the cited page. Text layer pages are exact. Only OCR pages get a 5 percent edit tolerance for quotes of 20 or more characters, and digits are never fuzzy. Known limit: on OCR pages a dropped word like "not" can still pass. Rejections carry the path, reason and page but not the quote, so no document text reaches logs. Linking: a model number is the only strong evidence (brand must not contradict, a different serial last 4 means a second unit); a brand alone or an asset with no model recorded is only a question; vehicles need make, model and year; no evidence means propose a new asset. Page text for the fixtures lives in fixtures/expected/pages | Digits are where a hallucinated quote hurts most (30 days vs 60), so the guard is strict exactly there. Pure functions with no AWS let the ingest worker (T2.2, T2.5) and the review screen reuse them | none
- D-025 | 2026-10-17 | [K]+claude | Corrections and accepted limits for D-024 after an independent review. (1) The quote check now keeps a boundary mark around every run of digits, so 12/3/2024 no longer passes for 1/23/2024, 30 days no longer passes inside 130 days, and 1,000 is not 10,00. A quote that merges digit groups (18005550142 for 1-800-555-0142) is rejected as written. The marks cannot be forgiven by OCR tolerance, and non-ASCII digits count as digits. (2) A kept leaf is rebuilt as just value and sourceRef, so nothing unchecked rides along; a null value carries no source. (3) A page with no text rejects every quote instead of throwing. (4) Fuzzy matching is skipped on OCR pages over 50,000 characters (a 1 MB page took 5 s). (5) Linking: keys keep letters of any script (a brand in another script no longer vanishes), a model that repeats its brand matches, a numeric model does not throw, an exact serial beats a unit with no serial, and a year must be an integer from 1886 to 2100 or it counts as no year. Accepted limits: on OCR pages a dropped word like "not" or a changed number word (sixty for thirty) can still pass at 5 percent tolerance; a quote that starts mid-sentence is still on the page; the guard proves the words are on the page, not that the value reads them correctly, so the extraction schema (T1.1) must be strict about what a value may hold; throws on cyclic input (model JSON is acyclic) | The reviewer broke the first version with digit separator and boundary cases that made the guard's headline promise false; the fixes are covered by tests that fail when removed | refines D-024

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
- Q-007 | [K]+claude | SPEC section 4 lease has no field for whether a notice period counts business or calendar days. The T1.3 engine reads an optional `noticeDaysType` ("business" or calendar by default). If T1.1 names it differently, a business-day clause silently becomes calendar days. Also: claim_by is only the helper claimByDate(); who calls it with severityFor in check_coverage (T2.4)? | K to decide in T1.1
- Q-008 | [K]+claude | The T1.4 reviewer run returned FAIL with 4 blocking findings beyond D-019, so T1.4 is not ready to merge. (1) A query that is a subset of a longer name wins at score 1: "fridge" returns "Fridge water filter" over a real fridge stored by category; "tv" returns "TV stand"; "my car" returns "Car seat". (2) Exact-name shortcut on names that lost a word, e.g. "lamp" vs Work lamp and Desk lamp. (3) One differing word still matches at 3 words: "upstairs bathroom fan" returns Downstairs bathroom fan; "bedroom 2 tv" returns Bedroom 1 TV. (4) Category, brand or location alone score under 0.6, so "dishwasher" for a Bosch SHX878 with category dishwasher returns none. Also non-blocking: ambiguous candidates depend on input order, one-way synonym collisions, accents, asymmetric hyphen join | P to decide scope with K before the T1.4 PR
- Q-009 | [K]+claude | Three things for K from the audit. (1) Make the subscription `cycle` an enum in the T1.1 extraction schema; the engine now accepts about 25 spellings but anything else silently drops the future charge and cancel-by. (2) Merge the two `AgreementKind` types (obligation-kit and core) into the T1.1 contracts. (3) Delete both packages/*/package-lock.json when the pnpm workspace lands. Also: pushing .github/workflows needs the `workflow` scope on the gh token | K to decide in T1.1 and T0.4

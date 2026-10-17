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
- (none yet)

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

---

## Open questions

Format: `Q-nnn | asked by | question | answer when known`

- Q-001 | [K] | Can an add-on push a notification or create an Alexa reminder? | Docs silent as of 2026-10-16; assume no
- Q-002 | [K] | Does the Local Inspector need add-on approval, or just a dev account? | T0.2
- Q-003 | [K] | Does Streamable HTTP in stateless JSON mode run cleanly on Lambda behind a Function URL? | T0.2
- Q-004 | [K] | Which Bedrock model in our region accepts PDF document input and gives reliable JSON? | T0.2
- Q-005 | [K] | Partner's name and initial for this file | K to fill

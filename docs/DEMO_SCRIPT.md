# Demo script (2:45, hard cap 3:00)

For the demo video. Judges may stop at 3:00, so the three moments come first and the "how it works" part is short. Everything here was walked through against the real running app (the click path is the one in `apps/web/e2e/a-smoke.spec.ts`, which passes).

## Say this, not that
- Hippo is a household obligations engine with an Alexa+ style voice add-on and a web app. It turns paperwork into dated, confirmed deadlines and answers coverage questions with the document and page.
- The voice side is a self hosted MCP server over Streamable HTTP. The Alexa+ developer tools are partner only (Devpost FAQ), so the demo client is a web page that is a real MCP client (OAuth with PKCE, `initialize`, `tools/list`, `tools/call`). Say that once, plainly.
- The documents are synthetic with fictional companies. The recalls are real public records.
- Do not say it runs on an Alexa device, that it is deployed, or that it reads any document you upload. Reading a new file needs the live AWS path, which is off by default.

## Before you record (10 minutes)
1. Free ports 8787 and 5173. Open two terminals, large font, nothing secret visible (no keys, no tokens).
2. Terminal A: `pnpm dev` (API on http://localhost:8787, in memory, seeded with the demo household). Terminal B: `pnpm dev:web` (web app on http://localhost:5173).
3. Use `http://localhost:5173`, not `127.0.0.1`. Light mode, browser zoom 110 to 125 percent, bookmarks bar hidden, notifications off.
4. The server clock is fixed at 2026-10-21 so "9 days" is always true; the Coming up page says "Today is 2026-10-21". If asked, say the demo clock is pinned.
5. Do a full dry run once. Reset by stopping and restarting terminal A (state is in memory).
6. Recorder: any screen recorder. Export 1080p, no music, English narration. Upload to YouTube or Vimeo as public, then paste the link in the Devpost form.

## Beat sheet

| Time | Screen | Say |
| :--- | :--- | :--- |
| 0:00 to 0:12 | Title card or the Coming up page | "Every household runs on paperwork it never reads twice. The cost shows up as a missed deadline: a lease notice window, a warranty that ran out, a subscription that renewed. Hippo turns that paperwork into dated, confirmed obligations and watches them." |
| 0:12 to 0:50 | **Moment 1, web app.** Sign in with the demo account. Settings, "Delete lease.pdf", "Yes, delete" (this only clears the pre loaded lease so the first run is visible). Upload page, drop `fixtures/docs/lease.pdf`. Coming up: the item "Give notice by 2026-11-01" sits in the "needs you" list and has no Done button. Click "Review and confirm". On the notice days field click "Page 4": the quote "sixty (60) days" is highlighted in the page text. Click "Confirm all dates". The card says "Give notice by Nov 1 (in 11 days)" with "page 4". Click "See it on Coming up". | "I drop a lease into the web app. Seconds later it shows the deadline, but nothing alerts yet: a date a model extracted is not trusted until I confirm it. Here is the clause and the page it came from. I confirm the dates, and only now does it become a reminder." |
| 0:50 to 1:35 | **Moment 2, /ask page.** Open `http://localhost:5173/ask`, click "Sign in as the demo account". Click the phrase "My dishwasher is leaking, am I covered?". Show the spoken answer, then the Coverage card: covered badge with the term dates, the page 3 exclusion (water damage from improper installation), up to 4 claim steps, the claim by date, the missing receipt warning. Click "Show clause", then "Claim steps". | "This page is a real MCP client, the way a voice assistant would call my server. It passes only the thing, 'dishwasher', and the server answers without calling any model. Yes, in warranty until November 12, but page 3 excludes water damage from improper installation, here are the claim steps, and the claim by date. It always ends with: this is what your document says, not a claim decision." |
| 1:35 to 1:55 | **Moment 3.** See "The proactive sentence" below. Click "What is coming up?": the Coming Up card shows the subscription cancel by date, the car insurance renewal and the lease notice; the Recall card shows the baby bottle recall (and the car recall as "may affect your car"). Then the terminal: `pnpm daily:run` prints the digest (or show the real email if the live SES send was done). | "On the next question it starts with the thing you would have missed: your car insurance renews in 9 days. The same engine runs every day, checks real CPSC and NHTSA recalls, and emails a short digest. Recalls say 'may affect', because the data is not VIN specific." |
| 1:55 to 2:30 | `docs/ARCHITECTURE.md` diagram for about 8 seconds. Terminal: `pnpm test:latency` (shows p50 and p95 against the 150 ms limit). Terminal, if time allows: `pnpm ingest:fixture fixtures/docs/lease.pdf` prints "status: needs_review (lease, 4 page(s))" and every extracted field with its page (for example `noticeDaysToVacate: extracted, page 4`), all still unconfirmed. | "No model runs on the voice path. All reading happens at upload time: page text, strict JSON, and a check that every extracted quote is really on the page it cites, or the field is dropped. Voice answers come from an in process search, so the round trip is milliseconds." |
| 2:30 to 2:45 | Repo page or the README | "Nothing alerts until you confirm. Every answer cites the document and page. The deadline engine is an open source package, MIT. Code and run instructions are in the repo." |

## The proactive sentence
Hippo speaks one extra sentence ("Before that, your car insurance renews in 9 days.") on the FIRST eligible tool call after the server starts, never twice in a day. So the sentence will appear in front of whichever answer comes first. Two ways to film it:
- Easiest, no restart: let it appear on the moment 2 answer. Point at it: "Before it answers, it tells me what I would have missed."
- Matches the beat sheet: after moment 2, stop terminal A (Ctrl+C) and run `pnpm dev` again, then on `/ask` click "Sign in as the demo account" again (tokens are signed with a per start key) and click "What is coming up?". The seeded lease comes back already confirmed, which looks the same.

## Take notes while recording (they feed the friction log)
Write down anything that surprised you: a click that was unclear, a message that confused, a step you had to redo. Real notes only.

## Checklist before uploading
- Under 3:00, shows the project running, public on YouTube or Vimeo.
- No third party trademarks or copyrighted music. English.
- No tokens, keys or personal email addresses visible (blur the SES inbox if it shows other mail).
- The honest limits are said or written in the description: synthetic documents, the demo reads the sample files unless live reading is on, the voice client is a web page, nothing is deployed.

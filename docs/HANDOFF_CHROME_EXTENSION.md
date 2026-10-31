# Handoff: Chrome extension

From Kundana to Kranthi, 2026-10-30. Branch `k/chrome-extension`. Built with Claude Code.

**Short version:** the extension works end to end against a local server. It is not released and costs nothing to run today. You take over the merge, the cost decisions and the Chrome Web Store listing.

## What you need to do

1. Click the real toolbar button once (see [Run it](#run-it)). The automated run could not do this.
2. Build the Docker image once. Docker was not available on my machine. The change should not affect the image, but it was never built.
3. Merge. CI will be the first run of the DynamoDB suite with this change.
4. Decide on cost and the store listing, using [What a real release needs](#what-a-real-release-needs).

## What I built

### The extension (`apps/extension`)
- Manifest V3, in React and TypeScript, built with Vite.
- Click the Hippo button on a billing page, a receipt or a checkout, then press Save.
- The popup shows the site, how much text will be sent, the result, and the subscriptions list with a monthly total.
- Sign-in is OAuth with PKCE through `chrome.identity.launchWebAuthFlow`. It lives in the service worker, because a popup closes when the sign-in window takes focus.
- Tokens stay in `chrome.storage.session`, so they are gone when the browser closes. A refresh runs one at a time, because reusing a rotated token revokes the family.
- Permissions: `activeTab`, `scripting`, `identity`, `storage`, and one host, `http://localhost:8787/*`. No content script and no access to all sites.

### The reader, with no model (`packages/obligation-kit/src/rules/subscription.ts`)
- `extractSubscriptionRules` reads the vendor, plan, price, cycle, next charge, trial end, cancel notice, cancel method and masked account email from page text.
- Fixed patterns only, so there is no cost, and page text cannot steer it.
- Every value carries its quote. When a page gives two answers, the field stays empty.
- It plugs in as a normal `Extractor` (`apps/workers/src/ingest/ruleExtractor.ts`), so a model can replace it later without touching the rest.

### Server (`apps/api`, `apps/workers`)
- `POST /ext/captures` and `GET /ext/subscriptions`, with bearer tokens (`apps/api/src/api/extension.ts`). The contract is in `docs/WEB_API.md`.
- `apps/workers/src/ingest/capture.ts` saves a page through the same path as an upload. `ingest.ts` was split into `createPagesIngest` for this, with no change to uploads. A failed save cleans up after itself.
- `GET /api/subscriptions` (`apps/api/src/subscriptions.ts`) lists every subscription. Each has its source document and page, and the total counts only what a person confirmed.

### Web app (`apps/web`)
- A new Subscriptions page and nav link. The address in the top bar now hides below 1440px, to make room.
- The privacy text in `Legal.tsx` mentions the extension.

### Fixes to existing code
- **Login page bug:** "Use the demo household" did nothing until an email was typed, because the email box is `required`. The `/ask` page never hit it, since it submits from code. Fixed with `formnovalidate` in `packages/auth/src/pages.ts`.
- **`get_agreement` read unreviewed documents aloud.** It now says the document has not been reviewed, and repeats no page text. This also applies to uploads waiting for review.

### Tests, samples and docs
- New tests for the rules, the extension API, the popup, sign-in, the service worker guard and the Subscriptions page.
- Five synthetic billing pages with expected results in `fixtures/pages`.
- Updated `README.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`, `docs/WEB_API.md`, `CLAUDE.md`, plus a new `apps/extension/README.md`.

## Decisions

| Decision | Why |
| :--- | :--- |
| Click to save only. No Gmail, no bank, no background reading | Keeps the rule in INTENT and PRIVACY, and is the simplest store review |
| Rules first, no model | Bedrock never worked on our account, and this costs nothing |
| Demo first, unpacked | Real users need durable storage and real sign-in first |
| Never use `add_record` for a capture | It marks fields confirmed, which would break "no alert from an unconfirmed date" |
| Saving works only on a server bound to its own machine (`isLocalOnly` in `server.ts`) | The public demo shares one household, so a real page there could be read by the next visitor |
| A page with no subscription is not kept | It has nothing to confirm, so it could never become an answer |

## Run it

Follow [apps/extension/README.md](../apps/extension/README.md). In short: run `pnpm dev` and `pnpm dev:web`, build with `pnpm --filter @hippo/extension build`, and load `apps/extension/dist` unpacked in `chrome://extensions`. Use `fixtures/pages/cedar_receipt.html`, because the demo household already has Fernwood.

## What was checked

| Check | Result |
| :--- | :--- |
| All package tests | 3253 pass (obligation-kit 614, core 1054, auth 307, api 734, workers 366, web 126, extension 28, infra 25) |
| Typecheck and `format:check` | Clean |
| `pnpm test:latency` | p95 4.0 ms locally, run before the last cleanup and rule fixes |
| Real Chrome 156 against real local servers | Sign-in, save, review, confirm and the updated total all worked |
| Server started in Railway mode | Started, `/ext` without a token gives 401 |
| Independent `reviewer` | Four rounds. All blocking findings fixed. Final verdict PASS |

**Not checked:**
- **The toolbar click.** The Chrome run used a throwaway copy of the build that opens the popup as a tab, with its message guard and tab lookup changed to allow that.
- **The Docker image build.**
- **The DynamoDB suite** with this change.
- **Any real billing page.** Only the synthetic pages were used.

## Known gaps

- **Reader:** US dollars and English only. A date must state its year, and a date like 11/03/2026 is left out because it has two readings. Unusual layouts will be missed. "Auto-renew is off" beside a renewal date is still read as a date, though a person must confirm it before it can alert.
- **Other voice paths can still use unreviewed data.** `check_coverage`, `get_history`, `ui_show_clause`, `ui_show_claim_steps` and the option labels in `resolve.ts`. This is existing behaviour and is not reachable as a spoken answer from a capture, but fix it before real users.
- **Masking:** `maskNumbers` misses digits written one at a time ("4 1 1 1 ..."), and `docs/PRIVACY.md` overclaims here. Fix the helper or the wording.
- **Personal details:** a saved page can hold a name or an address. Hippo does not remove them.
- **Tunnels:** a tunnel to a local server passes `isLocalOnly`. `docs/PRIVACY.md` warns about it.
- **Sign-in:** a 200 from the token route with no token signs the person out. Signing in again fixes it.
- **Failed saves:** if the cleanup also fails, a retry can answer "already saved". Deleting it in Settings clears that.
- **Search:** with very few short documents, one word questions can find nothing. This is the documented score cutoff.
- **Review flow:** signing in to the web app from a review link lands on Coming up, not on the review page. Open the link again.

## What a real release needs

I have not priced any of this, and nothing here has been verified with a provider.

| Need | State today | Cost |
| :--- | :--- | :--- |
| Durable storage | Data and auth are in memory. `infra/` is written and never deployed | Hosting and AWS |
| Real email sign-in | No mailer. On a public host nobody can log in by email | Email sending |
| Accept saves on a hosted server | Off by design. Needs per user households first, then a change to `isLocalOnly` | None by itself |
| Encryption at rest | Designed in the CDK stack, not live | Part of AWS |
| A reader for more pages | Rules only. Bedrock quota is zero on our account, and the support case had no answer | Per model call |
| Fix the gaps above | Open | Time |

**Chrome Web Store listing:**
- A store build has its own id. Register it with `HIPPO_EXTENSION_ID`. Copy the key from the Developer Dashboard, because a self generated key may not be kept on upload (unverified).
- Add the production origin to `host_permissions`, and set `VITE_HIPPO_API` and `VITE_HIPPO_WEB` at build time.
- The manifest needs icons, which it does not have yet.
- The listing needs a public privacy policy and an explanation of each permission. `docs/PRIVACY.md` is the starting point, but it describes a prototype.
- Check the developer account fee and the current review rules. I did not verify either.
- Never commit a `.pem` file. `.gitignore` blocks it, and the private key for the dev id was not kept.

The Railway demo stays as it is. The extension cannot reach it, since its only host permission is localhost.

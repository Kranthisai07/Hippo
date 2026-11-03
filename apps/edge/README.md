# Hippo on Cloudflare Workers

The same API as the Node server (`apps/api`), on D1 (data, sign in state, rate counters), R2 (files and the clause index) and the Email Sending binding. Nothing here is deployed, and nothing needs a Cloudflare account until staging.

## Run it locally (free, no account)

```bash
pnpm build:hosted   # from the repository root: builds the web app that the Worker serves (apps/web/dist)
cd apps/edge
printf 'HIPPO_ENV=development\nHIPPO_SIGNING_KEY=<at least 32 random characters>\n' > .dev.vars   # git ignored, never deployed
npx wrangler d1 migrations apply hippo --local
npx wrangler dev --local --port 8799 --test-scheduled --var HIPPO_ISSUER:http://localhost:8799 > ../../wrangler.log 2>&1
node scripts/smoke.mjs http://localhost:8799 ../../wrangler.log              # in another terminal
```

The Worker is strict by default: only `HIPPO_ENV=development` or `local` relaxes it (a made up signing key, a localhost issuer, and the sign in code written to the log when there is no email binding, which is how the smoke script reads it). An unset or misspelled `HIPPO_ENV` takes the production checks, and the Worker answers a bare 500 until every required setting and the email binding are present, so a deploy that forgets it fails closed. `wrangler.toml` therefore never sets `HIPPO_ENV`. Stop `wrangler dev` afterwards (it starts a `node` and a `workerd` process). On Windows, if `workerd` crashes at start, install the latest x64 Visual C++ Redistributable (reported by others, not an official requirement: docs/VERIFIED.md 10.15).

## What is and is not connected

- Connected: sign in by emailed code with PKCE and Continue with Google, the extension routes (`/ext`), the web API (`/api`) except uploads, `/mcp`, rate limits in D1, revocation, export and delete, a household record created at first sign in, and the daily cron (`scheduled`): cleanup of expired sign in records, then deadlines and alerts, the recall check and the digest email (apps/edge/src/daily.ts).
- The digest is mailed only when the `EMAIL` binding, an https `HIPPO_ISSUER` and a `HIPPO_SIGNING_KEY` of 32 characters or more are all present. Otherwise the job still makes the alerts (so Coming up is right) and counts the digest as a dry run. Every digest ends with a signed turn off link (`/unsubscribe`, valid 90 days).
- Optional and off by default: the one time Gmail scan (`HIPPO_GMAIL_IMPORT`, see "Turning on the Gmail scan" below).
- Not connected: uploads and PDF reading (the app answers 503, and the web app leaves the Upload page out), Resend. The web app is served from the Worker (see the first release steps below).
- `wrangler.toml` holds no secret. `HIPPO_SIGNING_KEY` is a `wrangler secret`. The D1 `database_id` is a placeholder until staging.

## Checks

`pnpm --filter @hippo/edge test` runs the stores against a worst case model of D1, the app in process, and a bundle check that fails if a Node only module returns. `scripts/smoke.mjs` is the same path on the real Workers runtime, locally. Staging repeats it on Cloudflare (slice 6).

## Staging on Cloudflare (free plan)

`wrangler.staging.toml` is not committed (it holds the account's database id). Copy `wrangler.toml`, set `name`, the D1 `database_id` from `wrangler d1 create`, an R2 `bucket_name`, `HIPPO_ISSUER` to the Worker's own address and `HIPPO_ENV = "development"` (the free plan has no Email Sending, so the sign in code is read from `wrangler tail`). Then:

```bash
npx wrangler d1 migrations apply <database> --remote --config wrangler.staging.toml
npx wrangler secret put HIPPO_SIGNING_KEY --config wrangler.staging.toml   # pipe a random value in, never type it
npx wrangler deploy --config wrangler.staging.toml
# the [triggers] cron in wrangler.toml is copied with the rest: every 15 minutes, a few households' daily work (below)
npx wrangler tail --config wrangler.staging.toml --format pretty > tail.log &
node scripts/smoke.mjs https://<worker address> tail.log
```

The script ends with three concurrency checks that need about 70 seconds. Results of the last run are in docs/VERIFIED.md 10.16. To remove staging: `npx wrangler delete --config wrangler.staging.toml`.


## First release: the free beta (Google sign in, no email)

Nothing here has been run on a real account for this tier yet (`docs/VERIFIED.md` 10.20 holds what is and is not checked for the Worker and its assets). Do these in order, in your own `wrangler.release.toml` (a copy of `wrangler.toml`, not committed, like the staging file):

1. `pnpm build:hosted` from the repository root, so `../web/dist` holds the web app the Worker serves.
2. Create the D1 database and the R2 bucket, put their ids in the file, and run the migrations with `--remote`.
3. Settings in `[vars]` (none of these is a secret): `HIPPO_ISSUER` (the Worker's own https address, for example the `workers.dev` one), `HIPPO_ALLOWED_ORIGINS` (the same address, since the app is served from it), `HIPPO_DEMO = "0"`, `HIPPO_CLIENT_IP_HEADER = "cf-connecting-ip"`, `HIPPO_EXTENSION_ID` (the Chrome Web Store id, see `apps/extension/README.md`), `HIPPO_GOOGLE_CLIENT_ID`, `HIPPO_CLIENT_NAME = "Hippo for Chrome"`, and the public pages `HIPPO_PRIVACY_URL`, `HIPPO_TERMS_URL`, `HIPPO_HOME_URL`. Leave `HIPPO_ENV` unset: unset means strict.
4. Secrets, piped in and never typed or printed: `wrangler secret put HIPPO_SIGNING_KEY` and `wrangler secret put HIPPO_GOOGLE_CLIENT_SECRET`.
5. In the Google Cloud console add `<issuer>/oauth/google/callback` as an authorised redirect address. While the Google app is in Testing, only the test users you add there can sign in (a limit of 100).
6. `wrangler deploy`. The Worker refuses to start, answering a bare 500 and logging only the names of the settings that are wrong, until the list above is complete and there is a way to sign in (the email binding or Google).
7. Check by hand: `/healthz`, `/` (the app), `/oauth/providers` (answers `google: true`, `email: false`), then sign in with Google, save a page with the extension, review and confirm it in the app. `scripts/smoke.mjs` cannot sign in on a real Worker (it reads the sign in code from a log, which production never writes).

The cron runs every 15 minutes. Each run does the daily job for the next few households (`HIPPO_DAILY_BATCH`, default 1, at most 50) that have not had it today, so every household is done once a day and one run stays small. About 3 ms of work per household was measured on Node (`docs/VERIFIED.md` 10.23). The default of 1 fits the Workers free plan (10 ms of CPU per run) and still finishes 96 households a day; on the paid plan (30 s of CPU) raise `HIPPO_DAILY_BATCH`, for example to 10. The first run after 03:00 UTC also deletes expired sign in records. With no email binding the reminder job still makes the alerts (Coming up is right) and counts the digest as a dry run. To turn email on later: add `[[send_email]]` with `name = "EMAIL"`, set `HIPPO_MAIL_FROM` to an address on a verified domain, and redeploy. People then get sign in codes by email, and the daily digest with its turn off link, with no code change.

## Turning on the Gmail scan (optional, owner steps)

Dark by default: with `HIPPO_GMAIL_IMPORT` unset (or any value but `1`) there is no consent step, no import routes and `/api/me` says `gmail: "off"`. Deploying the code changes nothing for anyone. To turn it on, in this order:

1. **Workers Paid plan.** A scan makes many Gmail calls and saves each page found, far over the free plan's 10 ms of CPU and 50 subrequests per request (docs/VERIFIED.md 10.23; the price is not verified here). Each step does 25 messages, so a step on the free plan would hit the limit. Do not switch the scan on without it.
2. **Apply the migration:** `wrangler d1 migrations apply hippo --remote --config wrangler.release.toml` (adds `import_jobs`, `0005_import.sql`).
3. **Google console:** enable the Gmail API, add the scope `https://www.googleapis.com/auth/gmail.readonly` under Google Auth Platform, Data access, and add each person who may try it as a test user (Testing mode allows 100; Google shows them an unverified app warning, and the authorization expires after 7 days, docs/VERIFIED.md 10.24). No new redirect address is needed: the scan returns to the same `<issuer>/oauth/google/callback` as sign in.
4. Set `HIPPO_GMAIL_IMPORT = "1"` in `[vars]` and `wrangler deploy`. The Worker refuses to start if it is on without the Google client id and secret.
5. Check by hand with your own account: `/oauth/providers` answers `gmail: true`, sign in, Connect Gmail, watch the scan, then confirm in Google's account permissions that the access is gone.

Every cron run (every 15 minutes) also ends scans whose token has expired, which deletes the sealed token and the message lists; finished scan records are deleted after 30 days. A public launch (anyone, not just test users) needs Google's restricted scope verification and a security assessment, which are not done.

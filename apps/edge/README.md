# Hippo on Cloudflare Workers

The same API as the Node server (`apps/api`), on D1 (data, sign in state, rate counters), R2 (files and the clause index) and the Email Sending binding. Nothing here is deployed, and nothing needs a Cloudflare account until staging.

## Run it locally (free, no account)

```bash
cd apps/edge
printf 'HIPPO_ENV=development\nHIPPO_SIGNING_KEY=<at least 32 random characters>\n' > .dev.vars   # git ignored, never deployed
npx wrangler d1 migrations apply hippo --local
npx wrangler dev --local --port 8799 --var HIPPO_ISSUER:http://localhost:8799 > ../../wrangler.log 2>&1
node scripts/smoke.mjs http://localhost:8799 ../../wrangler.log              # in another terminal
```

The Worker is strict by default: only `HIPPO_ENV=development` or `local` relaxes it (a made up signing key, a localhost issuer, and the sign in code written to the log when there is no email binding, which is how the smoke script reads it). An unset or misspelled `HIPPO_ENV` takes the production checks, and the Worker answers a bare 500 until every required setting and the email binding are present, so a deploy that forgets it fails closed. `wrangler.toml` therefore never sets `HIPPO_ENV`. Stop `wrangler dev` afterwards (it starts a `node` and a `workerd` process). On Windows, if `workerd` crashes at start, install the latest x64 Visual C++ Redistributable (reported by others, not an official requirement: docs/VERIFIED.md 10.15).

## What is and is not connected

- Connected: sign in by emailed code with PKCE, the extension routes (`/ext`), the web API (`/api`) except uploads, `/mcp`, rate limits in D1, revocation, export and delete.
- Not connected: uploads and PDF reading (the app answers 503), the daily job and digest, Google sign in, Resend.
- `wrangler.toml` holds no secret. `HIPPO_SIGNING_KEY` is a `wrangler secret`. The D1 `database_id` is a placeholder until staging.

## Checks

`pnpm --filter @hippo/edge test` runs the stores against a worst case model of D1, the app in process, and a bundle check that fails if a Node only module returns. `scripts/smoke.mjs` is the same path on the real Workers runtime, locally. Staging repeats it on Cloudflare (slice 6).

## Staging on Cloudflare (free plan)

`wrangler.staging.toml` is not committed (it holds the account's database id). Copy `wrangler.toml`, set `name`, the D1 `database_id` from `wrangler d1 create`, an R2 `bucket_name`, `HIPPO_ISSUER` to the Worker's own address and `HIPPO_ENV = "development"` (the free plan has no Email Sending, so the sign in code is read from `wrangler tail`). Then:

```bash
npx wrangler d1 migrations apply <database> --remote --config wrangler.staging.toml
npx wrangler secret put HIPPO_SIGNING_KEY --config wrangler.staging.toml   # pipe a random value in, never type it
npx wrangler deploy --config wrangler.staging.toml
npx wrangler tail --config wrangler.staging.toml --format pretty > tail.log &
node scripts/smoke.mjs https://<worker address> tail.log
```

The script ends with three concurrency checks that need about 70 seconds. Results of the last run are in docs/VERIFIED.md 10.16. To remove staging: `npx wrangler delete --config wrangler.staging.toml`.


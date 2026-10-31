# Hippo on Cloudflare Workers

The same API as the Node server (`apps/api`), on D1 (data, sign in state, rate counters), R2 (files and the clause index) and the Email Sending binding. Nothing here is deployed, and nothing needs a Cloudflare account until staging.

## Run it locally (free, no account)

```bash
cd apps/edge
printf 'HIPPO_SIGNING_KEY=<at least 32 random characters>\n' > .dev.vars     # git ignored
npx wrangler d1 migrations apply hippo --local
npx wrangler dev --local --port 8799 --var HIPPO_ISSUER:http://localhost:8799 > ../../wrangler.log 2>&1
node scripts/smoke.mjs http://localhost:8799 ../../wrangler.log              # in another terminal
```

Without the email binding a non production run writes the sign in code to the log, and the smoke script reads it from there. Stop `wrangler dev` afterwards (it starts a `node` and a `workerd` process). On Windows, if `workerd` crashes at start, install the latest x64 Visual C++ Redistributable (reported by others, not an official requirement: docs/VERIFIED.md 10.15).

## What is and is not connected

- Connected: sign in by emailed code with PKCE, the extension routes (`/ext`), the web API (`/api`) except uploads, `/mcp`, rate limits in D1, revocation, export and delete.
- Not connected: uploads and PDF reading (the app answers 503), the daily job and digest, Google sign in, Resend.
- `wrangler.toml` holds no secret. `HIPPO_SIGNING_KEY` is a `wrangler secret`. The D1 `database_id` is a placeholder until staging.

## Checks

`pnpm --filter @hippo/edge test` runs the stores against a worst case model of D1, the app in process, and a bundle check that fails if a Node only module returns. `scripts/smoke.mjs` is the same path on the real Workers runtime, locally. Staging repeats it on Cloudflare (slice 6).

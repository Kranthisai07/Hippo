# Public demo deploy (Railway)

This runs the same server as `pnpm dev`, plus the built web app, from one address. It holds only the synthetic household in memory, so anyone can press the demo sign in button, and a restart resets everything. It is not the AWS design in `infra/`, which has never been deployed.

## What runs

One container, built from the `Dockerfile` at the repo root: the API (MCP at `/mcp`, OAuth at `/oauth`, web JSON at `/api`) and the web app from `apps/web/dist`, on the same origin so the strict content security policy and the cookie session work unchanged.

## Railway steps

1. New project, Deploy from GitHub repo, pick `Kranthisai07/Hippo`. Railway builds the `Dockerfile`.
2. Settings, Networking, Generate Domain. Railway then sets `RAILWAY_PUBLIC_DOMAIN`, and the server uses `https://<that domain>` as its public address and callback. No other variable is required.
3. Optional: set `HIPPO_SIGNING_KEY` to a long random string so sign ins survive a restart (without it a random key is made on each start).
4. Open the domain. `/welcome` is the landing page, `/` the app, `/ask` the voice assistant demo client.

## Settings that matter

| Variable | Default in the image | Meaning |
| :--- | :--- | :--- |
| `HIPPO_DEMO` | `1` | Turns the demo sign in on a public host. It only reaches the synthetic household |
| `HIPPO_WEB_DIST` | `/app/apps/web/dist` | Folder of the built web app (an absolute path) |
| `HIPPO_ISSUER` | from `RAILWAY_PUBLIC_DOMAIN` | Public address, if you host somewhere else |
| `HIPPO_TODAY` | `2026-10-21` | The demo date the fixture deadlines are computed against |

## Limits

- Data is in memory and shared by everyone who signs in as the demo household. Uploads are real but only the demo documents can be read (fixture ingest).
- No model call and no AWS call is made. Deleting the demo household's data affects the next visitor until the next restart.
- Upload bytes are held in memory (15 MB per file). On a free tier a restart is the cleanup.

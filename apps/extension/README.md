# Hippo Chrome extension

Saves the subscription page you are looking at to Hippo. You click, you press Save, and you confirm what Hippo found on the Review screen. Nothing alerts until you do.

## Run it

Needs Chrome 113 or newer, and the two local servers from the root README.

```bash
pnpm dev                                   # terminal 1: API on http://localhost:8787
pnpm dev:web                               # terminal 2: web app on http://localhost:5173
pnpm --filter @hippo/extension build
```

1. Open `chrome://extensions`, turn on Developer mode, press Load unpacked and pick `apps/extension/dist`.
2. Serve the sample pages, for example `python3 -m http.server 9911 -d fixtures/pages`, and open http://localhost:9911/cedar_receipt.html. `fernwood_billing.html` shows the "already tracked" answer, because the demo household has Fernwood.
3. Click the Hippo button, sign in with "Use the demo household", click the button again and press Save.
4. Press "Review and confirm". Sign in to the web app with the demo account if asked, then open the link again from the popup. Confirm the fields.
5. Open Subscriptions in the web app, or the popup, to see it in the list and in the monthly total.

Keep the sample pages on `localhost`. Chrome needs a setting (Allow access to file URLs) for pages opened from disk.

## What it can do

The manifest asks for `activeTab`, `scripting`, `identity`, `storage` and one host, the local API. There is no content script and no access to other sites. What it reads and sends is in [docs/PRIVACY.md](../../docs/PRIVACY.md).

## How it reads

`extractSubscriptionRules` in `packages/obligation-kit` uses fixed patterns, with no model and no cost. When a page gives two answers for a field, the field stays empty, and you can fill it in on the Review screen. Known limits: US dollars and English only, a date must state its year, a date like 11/03/2026 is left out because it has two readings, and unusual layouts will be missed.

## The extension id

The public key in `public/manifest.json` fixes the id `gcanedelajoahpaoeeonbdlieoepcobc`, and local servers trust that id by default (`DEV_EXTENSION_ID` in `apps/api/src/server.ts`). The private key was not kept and is not needed to run this. A Chrome Web Store release would have its own id: set it with `HIPPO_EXTENSION_ID`. Never commit a `.pem` file.

To use another server, set `VITE_HIPPO_API` and `VITE_HIPPO_WEB` when building, and add its origin to `host_permissions`. Saving works only on a server bound to a loopback host, so any other server refuses it.

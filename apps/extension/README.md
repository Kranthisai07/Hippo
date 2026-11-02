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

The manifest asks for `activeTab`, `scripting`, `identity`, `storage` and one host: the local API in the local build, the production API in the store build. There is no content script and no access to other sites. What it reads and sends is in [docs/PRIVACY.md](../../docs/PRIVACY.md).

## How it reads

`extractSubscriptionRules` in `packages/obligation-kit` uses fixed patterns, with no model and no cost. When a page gives two answers for a field, the field stays empty, and you can fill it in on the Review screen. Known limits: US dollars and English only, a date must state its year, a date like 11/03/2026 is left out because it has two readings, and unusual layouts will be missed.

## The extension id

The public key in `manifest.template.json` fixes the id `gcanedelajoahpaoeeonbdlieoepcobc` for the local build, and local servers trust that id by default (`DEV_EXTENSION_ID` in `apps/api/src/server.ts`). The private key was not kept and is not needed to run this. Never commit a `.pem` file.

## The Chrome Web Store package

The local build (`pnpm --filter @hippo/extension build`, folder `dist/`) keeps the local host and the development key. The store build is separate and cannot carry either:

```bash
VITE_HIPPO_API=https://<your worker address> VITE_HIPPO_WEB=https://<your worker address> VITE_HIPPO_CLIENT_ID=<client id> pnpm --filter @hippo/extension build:store
```

It writes `dist-store/` and `release/hippo-<version>.zip` (both git ignored). The version comes from `package.json` only. The build stops before building anything if an address is not a plain https origin (no localhost, IP address, wildcard, path or user name), and stops after building if any text file in the package still contains a development address. `VITE_HIPPO_CLIENT_ID` is required (the server's client id for the extension, the same as `HIPPO_CLIENT_ID` on the Worker), so a store package never signs in as the demo client. The tests (`test/storeManifest.test.ts`, `test/storeBuild.test.ts`) run a real store build and check the manifest, the files and the zip.

Steps for the first release, in order:

1. Build the package as above and upload the zip to the Chrome Web Store dashboard as a draft (visibility Unlisted, see `store/listing.md`).
2. Copy the extension id the dashboard shows. Set it as `HIPPO_EXTENSION_ID` on the Worker (`apps/edge/README.md`) and redeploy, so the server trusts that id and accepts its `https://<id>.chromiumapp.org/` sign in address. If the dashboard offers a public key that keeps the id stable across uploads, pass it as `VITE_HIPPO_PUBLIC_KEY` and rebuild. Whether the store wants the `key` field at all is unverified (`docs/VERIFIED.md` 10.19), so check what the dashboard says.
3. Fill in the listing from `store/listing.md` and the images in `store/assets/`, then submit.

Saving works on any server that keeps each person's pages in their own household, which the Cloudflare backend does. The Node demo server refuses saves unless it is bound to your own machine, because its one demo household is shared.

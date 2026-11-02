# Chrome Web Store listing (draft)

Status: draft text for the Developer Dashboard. Limits are from `docs/VERIFIED.md` 10.19. Do not publish until the blockers at the bottom are closed.

## Name
Hippo

## Summary (manifest `description`, 132 characters at most)
Save a subscription page to Hippo. Reads only the page you click it on, and sends nothing until you press Save.

(Currently 111 characters. Checked against the limit in 10.19, which that page marks as old: confirm in the dashboard.)

## Single purpose
Save the billing page you are looking at to your Hippo account, so Hippo can list its subscription and remind you before it renews.

## Description
Hippo keeps track of the dates in your paperwork and warns you before they matter. This extension is the quickest way to add a subscription.

Open a billing page or a receipt, click the Hippo button, and press Save. Hippo reads the subscription on the page and adds it to your list with the exact words it came from.

What you stay in control of
- Nothing is read until you click the button, and only on that tab.
- Nothing is sent until you press Save. The popup tells you how much text will be sent.
- Long numbers are hidden before anything leaves your browser.
- A saved subscription is only a suggestion. Hippo never reminds you about a date until you review and confirm it.
- A page with no subscription on it is not kept.

What it does not do
- It does not read your email, your bank, or any page in the background.
- It does not cancel anything for you.

## Permission justifications
- `activeTab`: reads the visible text of the tab you clicked the button on, only after the click. No other tab and no background access.
- `scripting`: runs the single read of that tab's visible text when you click.
- `identity`: opens the Hippo sign in window (Chrome's web auth flow) so you can sign in without the extension seeing your password.
- `storage`: keeps your sign in token for the browser session only (`chrome.storage.session`), gone when the browser closes.
- Host permission: the Hippo server address the extension talks to. The build for the store must list the production address only (see blockers).

## Privacy practices form (answers must match the privacy policy)
- Collects: the visible text of the page you save, the page title and site name, and your sign in email (it comes from Google or from the code you enter). The email is also used to send the daily reminder email, which is on by default and has a one click turn off link in every message.
- Where it lives: page text in object storage and the extracted dates in a database, both on Cloudflare (a processor), in the person's own household.
- Does not sell or transfer data to third parties, does not use it for ads or credit decisions. Saved pages are read by Hippo's own rules on its own server; no model and no outside processor is used for them today. If that changes (docs/PRIVACY.md mentions a hosted model service for uploaded documents), this answer and the privacy policy must name it before publishing.
- Remote code: none.
- Privacy policy URL: the public address of the Hippo Privacy page (see blockers).

## Screenshots (1280x800, five)
1. Save a page: the popup over a billing page.
2. Your subscriptions in the popup, with the monthly total.
3. Review: each value next to the quote it came from.
4. Coming up: confirmed dates only.
5. Subscriptions page in the web app.

## Blockers before this can be published
1. **Nothing is deployed.** The Cloudflare backend saves per person and the store build exists (`pnpm --filter @hippo/extension build:store`), but until the Worker is deployed to a real address the listing would describe a product nobody can use. Deploy steps: `apps/edge/README.md`. Needs the owner's yes (account, R2, Google test users).
2. **The extension id.** It is known only after a draft upload. Then set `HIPPO_EXTENSION_ID` on the Worker and redeploy (`apps/extension/README.md`). Whether the store wants the manifest `key` is unverified (10.19).
3. **Public privacy policy** at the real address of the app (`/privacy`), the same text as the dashboard form. The text in the app must be re-read against this file when the address is known.
4. **Publisher and contact** (given by the owner 2026-11-02): publisher Kranthi Gadi, support contact devnest007@gmail.com. Both are on the privacy and terms pages. Still the owner's decision: whether the privacy and terms text is reviewed by a lawyer.
5. **Landing copy**: the landing page says the extension saves to a server on your own computer. Change it when the beta is deployed.

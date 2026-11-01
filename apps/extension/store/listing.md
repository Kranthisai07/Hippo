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
- Collects: the visible text of the page you save, the page title and site name, and your sign in email. Nothing else.
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
1. **Saving is refused on a hosted server today** (`isLocalOnly` in `apps/api/src/server.ts`, because the demo household is shared). A store build needs a hosted server that keeps each person's captures in their own household. Until then the listing would promise something the product refuses to do.
2. **Manifest**: `host_permissions` is `http://localhost:8787/*` and a development `key` is set. The store build needs the production origin only and the store's own key handling (unverified, see 10.19).
3. **Public privacy policy** at a real address, the same text as the dashboard form.
4. **Owner decisions**: publisher name, support contact, and whether the privacy and terms text is reviewed by a lawyer.

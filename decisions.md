# Decisions log

No decisions log exists on main (MEMORY.md is only in old worktrees), so this file starts one. Tagged `+claude`.

## 2026-10-31: extension logo and popup redesign (+claude)

- **Logo:** `apps/web/public/favicon.svg` is the only logo asset in the repo, so the extension uses it. PNG icons (16, 32, 48, 128) were drawn from its geometry with PIL at 16x supersampling, because no SVG rasterizer is installed and adding one for a one-off was not worth a new dependency. The SVG is copied to `public/icons/logo.svg` for the popup header. Its teal (#2f5d62) differs slightly from the web accent (#0b6b61); the logo is left as is.
- **Look:** the popup copies the subset of web tokens it needs (`apps/web/src/tokens.css`) so the two read as one product, including dark mode. Copied rather than imported because the extension build should not depend on web CSS internals.
- **Font:** `@fontsource-variable/geist` (already used by the web app) is bundled, because the extension CSP allows no remote fonts.
- **Toolbar badge:** set from the popup after the list loads, never from a background poll. This keeps the rule that the extension reads nothing in the background, and needs no new permission (`chrome.action` has none).
- **Next charge date:** shown as a date, not "in N days". The demo server date (2026-10-21) differs from the real clock, so a relative count would be wrong on demo data.
- **Locale:** dates are formatted as `en-US`, matching the reader's US dollars and English scope.
- **Test change:** "never as HTML" now checks `img[src=x]`, because the popup header legitimately contains an `<img>`.

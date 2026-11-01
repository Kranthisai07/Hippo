import { GOOGLE_G } from "./googleG";
import { THEME } from "./theme";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** Public pages the sign in window may link to. Only absolute http or https addresses are used. */
export interface PageLinks {
  privacy?: string;
  terms?: string;
  home?: string;
}

export interface LoginView {
  hidden: Record<string, string>;
  csrf: string;
  email: string;
  notice?: string;
  error?: string;
  demo: boolean;
  google: boolean;
  sessionEmail?: string;
  /** `code`: a code was sent to `email`, ask for it. Default `email`. */
  step?: "email" | "code";
  /** What the person is signing in to, for example "Hippo for Chrome". */
  clientName?: string;
  links?: PageLinks;
}

/** The HIPPO_PRIVACY_URL, HIPPO_TERMS_URL and HIPPO_HOME_URL settings. Unset ones are left out. */
export const linksFromEnv = (env: {
  HIPPO_PRIVACY_URL?: string | undefined;
  HIPPO_TERMS_URL?: string | undefined;
  HIPPO_HOME_URL?: string | undefined;
}): PageLinks => ({
  ...(env.HIPPO_PRIVACY_URL ? { privacy: env.HIPPO_PRIVACY_URL } : {}),
  ...(env.HIPPO_TERMS_URL ? { terms: env.HIPPO_TERMS_URL } : {}),
  ...(env.HIPPO_HOME_URL ? { home: env.HIPPO_HOME_URL } : {}),
});

const safeUrl = (u: string | undefined): string | null => {
  if (!u || u.length > 2048) return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") && !p.username && !p.password ? p.href : null;
  } catch {
    return null;
  }
};

const MARK = `<span class="mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 32 32" fill="none"><path d="M7 22c0-6 4-10 9-10s9 4 9 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="18" r="1.8" fill="currentColor"/><circle cx="20" cy="18" r="1.8" fill="currentColor"/></svg></span>`;
const brand = (home: string | null): string =>
  home
    ? `<a class="brand" href="${esc(home)}" target="_blank" rel="noopener noreferrer">${MARK}Hippo</a>`
    : `<span class="brand">${MARK}Hippo</span>`;

const svg = (path: string): string =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
const ICON = {
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
};

const POINTS = [
  "Every date shows the exact words it came from.",
  "Nothing alerts you until you confirm it.",
  "Delete everything with one button, any time.",
];

export function page(title: string, body: string, links?: PageLinks): string {
  const l = [
    ["Privacy", safeUrl(links?.privacy)],
    ["Terms", safeUrl(links?.terms)],
  ].filter((x): x is [string, string] => x[1] !== null);
  const foot = l.length
    ? `<footer class="foot">${l.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`).join("")}</footer>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${THEME}</style></head><body>${body}${foot}</body></html>`;
}

const panel = (home: string | null, about: string | null): string =>
  `<aside class="panel"><div class="stack">${brand(home)}<p class="lede">Your paperwork, turned into dates you can trust.</p></div><ul class="points">${POINTS.map((p) => `<li>${ICON.check}<span>${p}</span></li>`).join("")}</ul>${about ? `<a class="small" href="${esc(about)}" target="_blank" rel="noopener noreferrer">What is Hippo?</a>` : "<span></span>"}</aside>`;

export function loginPage(v: LoginView): string {
  const hidden =
    Object.entries(v.hidden)
      .map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`)
      .join("") + `<input type="hidden" name="csrf" value="${esc(v.csrf)}">`;
  const home = safeUrl(v.links?.home);
  const form = (inner: string, extra = ""): string =>
    `<form method="post" action="/oauth/authorize"${extra}>${hidden}${inner}</form>`;
  const codeStep = v.step === "code";

  const banner =
    (v.error ? `<p class="banner banner-error" role="alert">${ICON.alert}<span>${esc(v.error)}</span></p>` : "") +
    (v.notice ? `<p class="banner banner-ok" role="status">${ICON.check}<span>${esc(v.notice)}</span></p>` : "");

  const who = v.sessionEmail
    ? form(
        `<div class="who"><span class="avatar" aria-hidden="true">${esc(v.sessionEmail.charAt(0))}</span><div class="who-text"><b>${esc(v.sessionEmail)}</b><span>Signed in on this browser</span></div></div><button class="btn btn-primary" type="submit" name="action" value="continue" autofocus>Continue</button>`,
      ) + `<p class="or">or use another account</p>`
    : "";

  const google = v.google
    ? form(
        `<button class="btn btn-google" type="submit" name="action" value="google" formnovalidate>${GOOGLE_G}<span>Continue with Google</span></button>`,
      ) + `<p class="or">or</p>`
    : "";

  const mailForm = codeStep
    ? form(
        `<input type="hidden" name="email" value="${esc(v.email)}"><div class="field"><label for="code">Code from your email</label><input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required spellcheck="false"${v.error ? ' aria-invalid="true"' : ""} autofocus></div><button class="btn btn-primary" type="submit" name="action" value="login">Sign in</button><div class="row"><button class="btn btn-quiet" type="submit" name="action" value="send" formnovalidate>Send a new code</button><button class="btn btn-quiet" type="submit" name="action" value="change" formnovalidate>Use a different email</button></div>`,
      )
    : form(
        `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com" value="${esc(v.email)}" required spellcheck="false"${v.sessionEmail ? "" : " autofocus"}></div><button class="btn ${v.sessionEmail ? "btn-secondary" : "btn-primary"}" type="submit" name="action" value="send">Send me a code</button>`,
      );

  const demo = v.demo
    ? `<div class="demo"><span class="tag">Demo</span>${form(`<button class="btn btn-quiet" type="submit" name="action" value="demo" formnovalidate>Use the demo household</button>`)}</div>`
    : "";

  const sub = codeStep
    ? `We sent a code to <strong>${esc(v.email)}</strong>.`
    : v.clientName
      ? `to continue to <strong>${esc(v.clientName.slice(0, 60))}</strong>`
      : "Pick up where your documents left off.";

  const main = `<section class="main">${brand(home)}<div><h1>${codeStep ? "Enter your code" : "Sign in"}</h1><p class="sub">${sub}</p></div>${banner}${who}${codeStep ? "" : google}${mailForm}${codeStep ? "" : demo}</section>`;

  return page("Sign in to Hippo", `<main class="shell">${panel(home, safeUrl(v.links?.home))}${main}</main>`, v.links);
}

export const errorPage = (message: string, links?: PageLinks): string =>
  page(
    "Cannot continue",
    `<main class="shell single"><section class="main">${brand(null)}<span class="icon">${ICON.alert}</span><div><h1>Cannot continue</h1><p class="sub">${esc(message)}</p></div><p class="small">You can close this window and try again.</p></section></main>`,
    links,
  );

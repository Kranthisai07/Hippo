const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

export interface LoginView {
  hidden: Record<string, string>;
  csrf: string;
  email: string;
  notice?: string;
  error?: string;
  demo: boolean;
  sessionEmail?: string;
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}
label{display:block;margin:1rem 0 .25rem}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{margin:.75rem .5rem 0 0;padding:.5rem 1rem;font:inherit}.err{color:#a00000}.note{color:#0a5a2a}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function loginPage(v: LoginView): string {
  const hidden = Object.entries(v.hidden)
    .map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`)
    .join("");
  const msg =
    (v.error ? `<p class="err">${esc(v.error)}</p>` : "") + (v.notice ? `<p class="note">${esc(v.notice)}</p>` : "");
  const cont = v.sessionEmail
    ? `<p>Signed in as ${esc(v.sessionEmail)}.</p><button type="submit" name="action" value="continue">Continue</button><hr>`
    : "";
  const demo = v.demo ? `<button type="submit" name="action" value="demo">Use the demo household</button>` : "";
  return page(
    "Sign in to Hippo",
    `<h1>Sign in to Hippo</h1>${msg}<form method="post" action="/oauth/authorize" autocomplete="off">${hidden}<input type="hidden" name="csrf" value="${esc(v.csrf)}">${cont}<label for="email">Email</label><input id="email" name="email" type="email" maxlength="254" value="${esc(v.email)}" required><label for="code">One time code</label><input id="code" name="code" inputmode="numeric" maxlength="12"><button type="submit" name="action" value="send">Send me a code</button><button type="submit" name="action" value="login">Sign in</button>${demo}</form>`,
  );
}

export const errorPage = (message: string): string =>
  page("Cannot continue", `<h1>Cannot continue</h1><p>${esc(message)}</p>`);

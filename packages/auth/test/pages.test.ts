import { describe, expect, it } from "vitest";
import { errorPage, loginPage, type LoginView } from "../src/pages";
import { REDIRECT, authzParams, makeEnv, openAuthorize, pkce, postAuthorize, qs } from "./helpers";

const HOSTILE = `"><script>alert(1)</script><img src=x onerror=alert(2)>'`;
const base: LoginView = { hidden: { client_id: "alexa" }, csrf: "tok", email: "", demo: false, google: false };
// The stylesheet and the embedded font are not markup; the checks below look at the markup only.
const markup = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");

describe("the sign in page", () => {
  it("escapes every value it prints, including links, hidden fields and the client name", () => {
    const html = markup(
      loginPage({
        ...base,
        hidden: { [HOSTILE]: HOSTILE },
        csrf: HOSTILE,
        email: HOSTILE,
        notice: HOSTILE,
        error: HOSTILE,
        sessionEmail: HOSTILE,
        clientName: HOSTILE,
        step: "code",
        links: { privacy: `https://x.test/?q=${HOSTILE}`, terms: "javascript:alert(1)", home: "https://x.test/h" },
      }),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });

  it("has one h1, labels tied to inputs, and no script or external address", () => {
    for (const step of ["email", "code"] as const) {
      const html = markup(
        loginPage({ ...base, step, email: "a@b.test", google: true, demo: true, sessionEmail: "a@b.test" }),
      );
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).not.toMatch(/<script|<link|<iframe|<object/i);
      expect(html).not.toMatch(/(src|href|action)="https?:/i);
      for (const id of html.match(/<label for="([^"]+)"/g) ?? []) {
        expect(html).toContain(`id="${id.slice(12, -1)}"`);
      }
    }
  });

  it("keeps the contract of the form: field names, actions and validation attributes", () => {
    const first = loginPage({ ...base, google: true, demo: true, sessionEmail: "a@b.test" });
    expect(first).toMatch(/name="csrf" value="tok"/);
    expect(first).toMatch(/name="email" type="email"[^>]* required/);
    expect(first).toContain('name="action" value="send"');
    expect(first).toContain('name="action" value="continue"');
    expect(first).toContain('name="action" value="demo" formnovalidate');
    expect(first).toMatch(/name="action" value="google" formnovalidate>[\s\S]*Continue with Google/);
    const code = loginPage({ ...base, step: "code", email: "a@b.test" });
    expect(code).toContain('name="action" value="login"');
    expect(code).toContain('name="action" value="send" formnovalidate');
    expect(code).toContain('name="action" value="change" formnovalidate');
    expect(code).toMatch(/id="code"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/);
    expect(code).toContain('name="email" value="a@b.test"');
  });

  it("shows Google and demo only when they are on, and never the code field before a code was sent", () => {
    const off = loginPage(base);
    expect(off).not.toContain("Continue with Google");
    expect(off).not.toContain('value="demo"');
    expect(off).not.toContain('id="code"');
    expect(loginPage({ ...base, google: true })).toContain("Continue with Google");
    expect(loginPage({ ...base, demo: true })).toContain('value="demo"');
  });

  it("marks errors for assistive technology and shows the client name", () => {
    const html = loginPage({ ...base, step: "code", error: "That code did not work.", clientName: "Hippo for Chrome" });
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(loginPage({ ...base, notice: "Sent." })).toContain('role="status"');
    expect(loginPage({ ...base, clientName: "Hippo for Chrome" })).toContain("Hippo for Chrome");
  });

  it("links only to http or https pages that are configured", () => {
    const none = loginPage(base);
    expect(none).not.toContain('class="foot"');
    const some = loginPage({ ...base, links: { privacy: "https://h.test/privacy", terms: "ftp://h.test/t" } });
    expect(some).toContain('href="https://h.test/privacy"');
    expect(some).not.toContain("ftp:");
    expect(some).not.toContain(">Terms<");
  });

  it("stays small enough to be a sign in window, font included", () => {
    expect(loginPage({ ...base, google: true, demo: true }).length).toBeLessThan(80_000);
  });

  it("the error page is the same shell with one sentence and no technical detail", () => {
    const html = markup(errorPage(`Bad <b>`));
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain("Bad &lt;b&gt;");
    expect(html).toContain("You can close this window and try again.");
  });
});

describe("the sign in page as served", () => {
  it("allows the embedded font and nothing else new in the policy", async () => {
    const { challenge } = await pkce();
    const e = makeEnv();
    const res = await e.req(`/oauth/authorize?${qs(authzParams(challenge))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("names the client when it has a name, and the change action goes back to the email step", async () => {
    const { challenge } = await pkce();
    const e = makeEnv({ clients: [{ clientId: "alexa", redirectUris: [REDIRECT], name: "Hippo for Chrome" }] });
    const p = authzParams(challenge);
    const page = await openAuthorize(e, p);
    expect(page.html).toContain("Hippo for Chrome");
    const sent = await (await postAuthorize(e, page, p, { action: "send", email: "sam@example.com" })).text();
    expect(sent).toContain("Enter your code");
    const back = await (await postAuthorize(e, page, p, { action: "change", email: "sam@example.com" })).text();
    expect(back).not.toContain("Enter your code");
    expect(back).toContain('value="sam@example.com"');
  });

  it("asks for the code again after a wrong one, with the email kept", async () => {
    const { challenge } = await pkce();
    const e = makeEnv();
    const p = authzParams(challenge);
    const page = await openAuthorize(e, p);
    const res = await postAuthorize(e, page, p, { action: "login", email: "sam@example.com", code: "000000" });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Enter your code");
    expect(html).toContain("That code did not work.");
  });
});

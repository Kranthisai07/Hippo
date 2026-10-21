import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeExchange, getAccessToken, hasSession, signOut, signInDemo, REDIRECT_URI, RESOURCE } from "../auth";

const KEY = "hippo-ask-pkce";

function tokenFetch(status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body)) });
    return new Response(
      JSON.stringify({
        access_token: "ACCESS-SECRET",
        refresh_token: "REFRESH-SECRET",
        expires_in: 900,
        scope: "mcp:tools",
      }),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

beforeEach(() => {
  signOut();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("completeExchange", () => {
  it("refuses a state that does not match and sends nothing to the token endpoint", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ verifier: "v".repeat(43), state: "good" }));
    const { fetchFn, calls } = tokenFetch();
    await expect(completeExchange("?code=abc&state=evil", { fetch: fetchFn })).rejects.toThrow(/state/i);
    expect(calls).toHaveLength(0);
    expect(hasSession()).toBe(false);
  });

  it("refuses when nothing was started in this tab", async () => {
    const { fetchFn, calls } = tokenFetch();
    await expect(completeExchange("?code=abc&state=x", { fetch: fetchFn })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("exchanges the code with the verifier, keeps tokens in memory only and clears the verifier", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    sessionStorage.setItem(KEY, JSON.stringify({ verifier: "v".repeat(43), state: "good" }));
    const { fetchFn, calls } = tokenFetch();
    await completeExchange("?code=abc&state=good", { fetch: fetchFn });
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe("/oauth/token");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("code_verifier")).toBe("v".repeat(43));
    expect(body.get("client_id")).toBe("hippo-demo");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(body.get("resource")).toBe(RESOURCE);
    expect(await getAccessToken({ fetch: fetchFn })).toBe("ACCESS-SECRET");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.length).toBe(0);
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain("SECRET");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("SECRET");
  });
});

describe("signInDemo", () => {
  it("opens the login page, presses the demo button and exchanges the code it finds in the redirect", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      if (url.startsWith("/oauth/authorize") && !init?.method)
        return new Response('<input type="hidden" name="csrf" value="CSRF1">', { status: 200 });
      if (url === "/oauth/authorize") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("action")).toBe("demo");
        expect(form.get("csrf")).toBe("CSRF1");
        expect(form.get("code_challenge_method")).toBe("S256");
        expect(form.get("resource")).toBe(RESOURCE);
        const r = new Response("<html></html>", { status: 200 });
        Object.defineProperty(r, "url", { value: `${REDIRECT_URI}?code=C1&state=${form.get("state")}` });
        return r;
      }
      return new Response(JSON.stringify({ access_token: "T", refresh_token: "R", expires_in: 900 }), { status: 200 });
    }) as unknown as typeof fetch;
    await signInDemo({ fetch: fetchFn });
    expect(seen).toEqual(["GET /oauth/authorize", "POST /oauth/authorize", "POST /oauth/token"]);
    expect(hasSession()).toBe(true);
  });
});

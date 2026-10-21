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

// Round 3 review: the SDK sends a POST and an event stream request through the same fetch, so two calls could both
// present the same rotating refresh token. Reusing a refresh token revokes the whole family (PRIVACY.md), so the
// demo session would die after about 14.5 minutes.
describe("concurrent refresh", () => {
  function slowTokenFetch() {
    const calls: URLSearchParams[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push(body);
      const n = calls.length;
      await new Promise((r) => setTimeout(r, 15));
      return new Response(
        JSON.stringify({
          access_token: `ACCESS-${n}`,
          refresh_token: `REFRESH-${n}`,
          expires_in: body.get("grant_type") === "authorization_code" ? 10 : 900,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }
  const start = async (fetchFn: typeof fetch) => {
    sessionStorage.setItem(KEY, JSON.stringify({ verifier: "v".repeat(43), state: "good" }));
    await completeExchange("?code=abc&state=good", { fetch: fetchFn });
  };

  it("sends one refresh request when several calls need one at the same time", async () => {
    const { fetchFn, calls } = slowTokenFetch();
    await start(fetchFn);
    const [a, b, c] = await Promise.all([
      getAccessToken({ fetch: fetchFn }),
      getAccessToken({ fetch: fetchFn }),
      getAccessToken({ fetch: fetchFn }),
    ]);
    expect(calls.filter((x) => x.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect([a, b, c]).toEqual(["ACCESS-2", "ACCESS-2", "ACCESS-2"]);
  });

  it("a forced refresh at the same time as a normal one shares the request", async () => {
    const { fetchFn, calls } = slowTokenFetch();
    await start(fetchFn);
    const { forceRefresh } = await import("../auth");
    await Promise.all([getAccessToken({ fetch: fetchFn }), forceRefresh({ fetch: fetchFn })]);
    expect(calls.filter((x) => x.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("a later refresh still runs and presents the newest refresh token", async () => {
    const { fetchFn, calls } = slowTokenFetch();
    await start(fetchFn);
    const { forceRefresh } = await import("../auth");
    await forceRefresh({ fetch: fetchFn });
    await forceRefresh({ fetch: fetchFn });
    const refreshes = calls.filter((x) => x.get("grant_type") === "refresh_token");
    expect(refreshes.map((x) => x.get("refresh_token"))).toEqual(["REFRESH-1", "REFRESH-2"]);
  });

  it("a failed refresh ends the session for every waiting caller and does not stay stuck", async () => {
    let n = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      n++;
      const body = new URLSearchParams(String(init?.body));
      await new Promise((r) => setTimeout(r, 10));
      if (body.get("grant_type") === "refresh_token") return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 10 }), { status: 200 });
    }) as unknown as typeof fetch;
    await start(fetchFn);
    const results = await Promise.allSettled([getAccessToken({ fetch: fetchFn }), getAccessToken({ fetch: fetchFn })]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(n).toBe(2);
    expect(hasSession()).toBe(false);
  });
});

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

  // Round 3 review: a failure before the exchange left the verifier and state in sessionStorage.
  it.each([
    ["the sign-in page is not served", async () => new Response("no", { status: 503 })],
    [
      "the demo account is off (no code in the redirect)",
      async (url: string, init?: RequestInit) => {
        if (!init?.method) return new Response('<input type="hidden" name="csrf" value="C">', { status: 200 });
        const r = new Response("<html></html>", { status: 401 });
        Object.defineProperty(r, "url", { value: `${REDIRECT_URI}?error=access_denied` });
        return r;
      },
    ],
    [
      "the network fails",
      async () => {
        throw new TypeError("network down");
      },
    ],
  ])("clears the verifier and state when %s", async (_name, impl) => {
    await expect(signInDemo({ fetch: impl as unknown as typeof fetch })).rejects.toThrow();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(hasSession()).toBe(false);
  });
});

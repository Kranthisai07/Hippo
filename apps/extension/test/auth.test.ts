import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, isSignedIn, signIn, signOut } from "../src/auth";
import { fakeChrome } from "./fakeChrome";

const tokenReply = (access: string, refresh: string | null = "r2", status = 200) =>
  new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 900 }), { status });

const answerWith = (params: (state: string) => Record<string, string>) =>
  vi.fn(async ({ url }: { url: string }) => {
    const state = new URL(url).searchParams.get("state")!;
    return `https://abc.chromiumapp.org/?${new URLSearchParams(params(state))}`;
  });

let fake: ReturnType<typeof fakeChrome>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake = fakeChrome();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("signIn", () => {
  it("runs PKCE S256 and keeps the tokens in session storage", async () => {
    fake.chrome.identity.launchWebAuthFlow = answerWith((state) => ({ code: "c1", state }));
    fetchMock.mockResolvedValue(tokenReply("a1"));
    await signIn();

    const { url, interactive } = fake.chrome.identity.launchWebAuthFlow.mock.calls[0]![0] as never as {
      url: string;
      interactive: boolean;
    };
    const q = new URL(url).searchParams;
    expect(interactive).toBe(true);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe("https://abc.chromiumapp.org/");
    expect(q.get("resource")).toBe("http://localhost:8787/mcp");

    const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("code")).toBe("c1");
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(await accessToken()).toBe("a1");
  });

  it("refuses an answer with the wrong state", async () => {
    fake.chrome.identity.launchWebAuthFlow = answerWith(() => ({ code: "c1", state: "forged" }));
    await expect(signIn()).rejects.toThrow(/did not match/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await isSignedIn()).toBe(false);
  });

  it("stores nothing when the server refuses", async () => {
    fake.chrome.identity.launchWebAuthFlow = answerWith((state) => ({ code: "c1", state }));
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(signIn()).rejects.toThrow(/refused/);
    expect(await isSignedIn()).toBe(false);
  });
});

describe("accessToken", () => {
  const expiring = (refresh: string | null = "r1") =>
    fake.session.set("hippo-tokens", { access: "old", refresh, expiresAt: Date.now() + 1000 });

  it("is null when signed out", async () => {
    expect(await accessToken()).toBeNull();
  });
  it("refreshes a token about to expire", async () => {
    expiring();
    fetchMock.mockResolvedValue(tokenReply("new"));
    expect(await accessToken()).toBe("new");
  });
  it("shows a rotating refresh token once, even to two callers at the same time", async () => {
    expiring();
    fetchMock.mockImplementation(async () => tokenReply("new"));
    expect(await Promise.all([accessToken(), accessToken()])).toEqual(["new", "new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("signs out when the refresh is refused", async () => {
    expiring();
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));
    expect(await accessToken()).toBeNull();
    expect(await isSignedIn()).toBe(false);
  });
  it("keeps the sign-in when the network fails during a refresh", async () => {
    expiring();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await accessToken();
    expect(await isSignedIn()).toBe(true);
  });
  it("keeps the sign-in when the server has a bad moment", async () => {
    expiring();
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    await accessToken();
    expect(await isSignedIn()).toBe(true);
  });
  it("keeps the sign-in when told to slow down", async () => {
    expiring();
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    await accessToken();
    expect(await isSignedIn()).toBe(true);
  });
  it("signs out when there is no refresh token", async () => {
    expiring(null);
    expect(await accessToken()).toBeNull();
    expect(await isSignedIn()).toBe(false);
  });
  it("signOut clears the tokens and revokes the refresh token on the server", async () => {
    expiring();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await signOut();
    expect(await isSignedIn()).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8787/oauth/revoke");
    const body = init.body as URLSearchParams;
    expect(body.get("token")).toBe("r1");
    expect(body.get("client_id")).toBe("hippo-demo");
  });
  it("signOut still signs out when the server cannot be reached", async () => {
    expiring();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await signOut();
    expect(await isSignedIn()).toBe(false);
  });
});

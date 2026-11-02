import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeChrome } from "./fakeChrome";

type Listener = (request: unknown, sender: unknown, reply: (r: unknown) => void) => boolean;

let listener: Listener;

beforeEach(async () => {
  vi.resetModules();
  const { chrome } = fakeChrome();
  await import("../src/background");
  listener = chrome.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
});

describe("who may ask the service worker", () => {
  it("answers this extension's own popup", async () => {
    const reply = vi.fn();
    expect(listener({ type: "status" }, { id: "ext" }, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true, signedIn: false }));
  });
  it.each([
    ["another extension", { id: "other" }],
    ["a page in a tab", { id: "ext", tab: { id: 1 } }],
  ])("ignores %s", (_who, sender) => {
    const reply = vi.fn();
    expect(listener({ type: "token" }, sender, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("signing in", () => {
  it("a second click while the sign in window is open joins the first attempt", async () => {
    const { chrome } = fakeChrome();
    vi.resetModules();
    await import("../src/background");
    const l = chrome.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
    let finish!: (url: string) => void;
    chrome.identity.launchWebAuthFlow.mockImplementation(() => new Promise<string>((r) => (finish = r)));
    const a = vi.fn();
    const b = vi.fn();
    l({ type: "signIn" }, { id: "ext" }, a);
    l({ type: "signIn" }, { id: "ext" }, b);
    await vi.waitFor(() => expect(chrome.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1));
    finish("https://abc.chromiumapp.org/?error=denied");
    await vi.waitFor(() => expect(a).toHaveBeenCalled());
    await vi.waitFor(() => expect(b).toHaveBeenCalled());
    expect(chrome.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).toEqual(b.mock.calls[0]![0]);
  });

  it("says plainly that a sign in window is already open when Chrome refuses a second flow", async () => {
    const { chrome } = fakeChrome();
    vi.resetModules();
    await import("../src/background");
    const l = chrome.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
    chrome.identity.launchWebAuthFlow.mockRejectedValue(new Error("Only one web auth flow is allowed at a time."));
    const reply = vi.fn();
    l({ type: "signIn" }, { id: "ext" }, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({
        ok: false,
        error: "A Hippo sign-in window is already open. Finish or close it, then try again.",
      }),
    );
  });
});

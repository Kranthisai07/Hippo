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

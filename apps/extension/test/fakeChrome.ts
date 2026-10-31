import { vi } from "vitest";

/** The chrome APIs the extension uses, in memory. */
export function fakeChrome() {
  const session = new Map<string, unknown>();
  const chromeFake = {
    runtime: { id: "ext", sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => session.set(k, v)),
        remove: async (key: string) => void session.delete(key),
      },
    },
    identity: {
      getRedirectURL: () => "https://abc.chromiumapp.org/",
      launchWebAuthFlow: vi.fn(),
    },
    tabs: { query: vi.fn(async () => [{ id: 7 }]), create: vi.fn() },
    scripting: { executeScript: vi.fn() },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  };
  vi.stubGlobal("chrome", chromeFake);
  return { chrome: chromeFake, session };
}

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popup } from "../src/Popup";
import { toCapture } from "../src/page";
import { fakeChrome } from "./fakeChrome";

const PAGE = { title: "Billing | Fernwood", host: "fernwood.example", text: "Your plan costs $15.99/month." };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const LIST = {
  monthlyTotal: 15.99,
  subscriptions: [
    {
      agreementId: "a1",
      docId: "d1",
      vendor: "Fernwood",
      plan: null,
      amount: 15.99,
      cycle: "monthly",
      nextChargeDate: null,
      confirmed: false,
      source: { docName: "fernwood.example Billing", page: 1 },
    },
  ],
};

let fake: ReturnType<typeof fakeChrome>;
let fetchMock: ReturnType<typeof vi.fn>;

function replies(signedIn: boolean) {
  fake.chrome.runtime.sendMessage.mockImplementation(async (r: { type: string }) => {
    if (r.type === "token") return { ok: true, signedIn, token: signedIn ? "t" : null };
    return { ok: true, signedIn: r.type === "signIn" ? true : signedIn };
  });
}

beforeEach(() => {
  fake = fakeChrome();
  fake.chrome.scripting.executeScript.mockResolvedValue([{ result: PAGE }]);
  fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/ext/subscriptions") ? json(LIST) : json({})));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

describe("Popup", () => {
  it("asks to sign in when signed out, and sends nothing", async () => {
    replies(false);
    render(<Popup />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing until Save is pressed, and says what it will send", async () => {
    replies(true);
    render(<Popup />);
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByText("fernwood.example")).toBeInTheDocument();
    expect(screen.getByText(/29 characters of visible text/)).toBeInTheDocument();
    expect(posted()).toEqual([]);
  });

  it("saves, then points at review and says no reminder has started", async () => {
    replies(true);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/ext/captures")
        ? json({ saved: true, docId: "d1", reviewUrl: "/review/d1" }, 201)
        : json(LIST),
    );
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText(/No reminder starts until you confirm/)).toBeInTheDocument();
    const [, init] = posted()[0]!;
    expect(JSON.parse(init.body)).toEqual(PAGE);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");

    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: "http://localhost:5173/review/d1" });
  });

  it("says plainly when nothing was found", async () => {
    replies(true);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/ext/captures") ? json({ saved: false }) : json(LIST),
    );
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText(/found no subscription here. Nothing was saved/)).toBeInTheDocument();
  });

  it("links to the one already saved", async () => {
    replies(true);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/ext/captures")
        ? json({ error: { message: "You already track this subscription." } }, 409, { "x-hippo-doc": "d9" })
        : json(LIST),
    );
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("You already track this subscription.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: "http://localhost:5173/review/d9" });
  });

  it("shows the server's message when saving is off", async () => {
    replies(true);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/ext/captures")
        ? json({ error: { message: "Saving pages is off on this public demo." } }, 403)
        : json(LIST),
    );
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/off on this public demo/);
  });

  it("explains a page it cannot read", async () => {
    replies(true);
    fake.chrome.scripting.executeScript.mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    render(<Popup />);
    expect(await screen.findByText(/This page cannot be read/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("lists subscriptions and marks what is waiting for review", async () => {
    replies(true);
    render(<Popup />);
    expect(await screen.findByText("$15.99 a month confirmed")).toBeInTheDocument();
    expect(screen.getByText("to review")).toBeInTheDocument();
    expect(screen.getByText("From fernwood.example Billing, page 1")).toBeInTheDocument();
  });

  it("badges the toolbar with what waits for review, and links each row to its review page", async () => {
    replies(true);
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Review Fernwood" }));
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: "http://localhost:5173/review/d1" });
    expect(fake.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "1" });
  });

  it("says so when nothing is tracked yet, and clears the badge", async () => {
    replies(true);
    fetchMock.mockImplementation(async () => json({ monthlyTotal: 0, subscriptions: [] }));
    render(<Popup />);
    expect(await screen.findByText(/Nothing tracked yet/)).toBeInTheDocument();
    expect(fake.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("marks a confirmed subscription and shows its next charge", async () => {
    replies(true);
    fetchMock.mockImplementation(async () =>
      json({
        monthlyTotal: 15.99,
        subscriptions: [{ ...LIST.subscriptions[0], confirmed: true, nextChargeDate: "2026-11-03" }],
      }),
    );
    render(<Popup />);
    expect(await screen.findByText("confirmed")).toBeInTheDocument();
    expect(screen.getByText(/next Nov 3, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review Fernwood" })).toBeNull();
  });

  it("shows page text as text, never as HTML", async () => {
    replies(true);
    fake.chrome.scripting.executeScript.mockResolvedValue([
      { result: { ...PAGE, host: "<img src=x onerror=alert(1)>" } },
    ]);
    render(<Popup />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img[src=x]")).toBeNull();
  });
});

describe("what leaves the browser", () => {
  it("masks long numbers and caps the text", () => {
    const out = toCapture({ ...PAGE, text: `Card 4111111111111111 ${"a".repeat(70_000)}` });
    expect(out.text).not.toContain("4111111111111111");
    expect(out.text.length).toBe(60_000);
  });
  it("sends the site name and never a full address", () => {
    expect(Object.keys(toCapture(PAGE)).sort()).toEqual(["host", "text", "title"]);
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "public/manifest.json"), "utf8"));

  it("asks for the four permissions and nothing wider", () => {
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "identity", "scripting", "storage"]);
    expect(JSON.stringify(manifest)).not.toMatch(/all_urls|\*:\/\/\*/);
    expect(manifest.host_permissions).toEqual(["http://localhost:8787/*"]);
  });
  it("has the Hippo icon at every size", () => {
    for (const size of ["16", "32", "48", "128"]) {
      expect(manifest.icons[size]).toBe(`icons/icon-${size}.png`);
      expect(manifest.action.default_icon[size]).toBe(`icons/icon-${size}.png`);
    }
  });
  it("has no always on content script", () => {
    expect(manifest.content_scripts).toBeUndefined();
  });
});

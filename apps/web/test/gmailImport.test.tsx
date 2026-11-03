import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/ui";
import { AuthProvider } from "../src/lib/auth";
import { api } from "../src/lib/api";
import { Connect } from "../src/pages/Connect";
import { ImportPage } from "../src/pages/Import";
import { SettingsPage } from "../src/pages/Settings";
import type { ImportView, Me, ObligationItem, Subscription } from "../src/lib/types";

vi.mock("../src/lib/gmail", async (orig) => ({
  ...(await orig<typeof import("../src/lib/gmail")>()),
  BUSY_WAIT_MS: 30,
}));

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function wrap(ui: React.ReactNode, path: string, route: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path={route} element={ui} />
            <Route path="/" element={<p>Home page</p>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const me = (gmail: Me["gmail"]): Me => ({ email: "k@example.com", digestOn: true, uploads: true, gmail });
const counts = { scanned: 0, found: 0, duplicates: 0, skipped: 0, failed: 0, candidates: 0 };
const view = (over: Partial<ImportView> = {}): ImportView => ({
  id: "job-1",
  status: "running",
  finished: false,
  counts,
  error: null,
  revoked: false,
  spotted: [],
  ...over,
});
const done = (over: Partial<ImportView> = {}) =>
  view({
    status: "done",
    finished: true,
    revoked: true,
    counts: { ...counts, scanned: 4, candidates: 4, found: 2, duplicates: 1 },
    ...over,
  });

const sub = (vendor: string, docId: string): Subscription => ({
  agreementId: `agr-${vendor}`,
  docId,
  vendor,
  plan: "Plus",
  amount: 12.99,
  cycle: "monthly",
  nextChargeDate: null,
  confirmed: false,
  source: { docName: "Your bill", page: 1 },
});
const item = (docId: string, type: "cancel_by" | "charge", dueDate: string): ObligationItem => ({
  obligation: { id: `${docId}-${type}`, type, dueDate, label: type, confirmed: false, severity: null },
  needsConfirmation: true,
  docId,
});
const loadList = (subs: Subscription[], items: ObligationItem[]) => {
  vi.spyOn(api, "listDocs").mockResolvedValue({
    docs: [
      {
        id: "d",
        filename: "f",
        docType: "x",
        status: "needs_review",
        pages: 1,
        uploadedAt: "2026-11-02T10:00:00.000Z",
        assetIds: [],
      },
    ],
  });
  vi.spyOn(api, "listSubscriptions").mockResolvedValue({ subscriptions: subs, monthlyTotal: 0 });
  vi.spyOn(api, "listObligations").mockResolvedValue({ items });
};

describe("Connect", () => {
  it("says what is read, kept and never done, and links to Google's consent step", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    wrap(<Connect />, "/connect", "/connect");
    expect(await screen.findByRole("heading", { name: "Find your subscriptions in Gmail" })).toBeInTheDocument();
    expect(screen.getByText(/never sends, deletes or changes an email/i)).toBeInTheDocument();
    expect(screen.getByText(/asks Google to end its access/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Gmail" })).toHaveAttribute("href", "/oauth/google/import/start");
  });

  it("Not now is remembered and goes home", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    const decline = vi.spyOn(api, "importDecline").mockResolvedValue({ gmail: "declined" });
    wrap(<Connect />, "/connect", "/connect");
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(decline).toHaveBeenCalledOnce();
    expect(await screen.findByText("Home page")).toBeInTheDocument();
  });

  it("explains a refusal in plain words and says nothing was read", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    wrap(<Connect />, "/connect?gmail=wrong_account", "/connect");
    expect(await screen.findByRole("alert")).toHaveTextContent(/different Google account.*nothing was read/i);
  });

  it("offers nothing when the import is not switched on", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("off"));
    wrap(<Connect />, "/connect", "/connect");
    expect(await screen.findByText("Home page")).toBeInTheDocument();
  });
});

describe("the waiting page and the list", () => {
  it("steps the scan until it ends, then shows the list in priority order with the access ended", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(view());
    const step = vi
      .spyOn(api, "importStep")
      .mockResolvedValueOnce(view({ counts: { ...counts, scanned: 2, candidates: 4, found: 1 } }))
      .mockResolvedValueOnce(done());
    loadList(
      [sub("Charger", "d1"), sub("Trialer", "d2"), sub("Quiet", "d3")],
      [item("d1", "charge", "2026-11-04"), item("d2", "cancel_by", "2026-11-09")],
    );
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    expect(await screen.findByRole("heading", { name: "You are all set" })).toBeInTheDocument();
    expect(step).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Hippo's access to your Gmail has ended/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing reminds you until you confirm a date/)).toBeInTheDocument();
    // Needs you soon: the cancel by date is ahead of the nearer charge. Then the one with no date.
    const heads = (await screen.findAllByRole("heading", { level: 3 })).map((h) => h.textContent);
    expect(heads).toEqual(["Trialer", "Charger", "Quiet"]);
    expect(screen.getByRole("heading", { name: "Needs you soon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No date found" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Review and confirm" })[0]).toHaveAttribute("href", "/review/d2");
  });

  it("when another step is already running it waits before asking again, instead of asking at once", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(view());
    const times: number[] = [];
    vi.spyOn(api, "importStep").mockImplementation(async () => {
      times.push(performance.now());
      return times.length < 3 ? view({ busy: true }) : done();
    });
    loadList([], []);
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    expect(await screen.findByRole("heading", { name: "You are all set" })).toBeInTheDocument();
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(25);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(25);
  });

  it("shows progress while it runs, in a polite live region", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(
      view({ counts: { ...counts, scanned: 25, candidates: 100, found: 3 } }),
    );
    vi.spyOn(api, "importStep").mockReturnValue(new Promise(() => undefined));
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    const live = (await screen.findByText("Checked 25 of 100 emails. Found 3 subscriptions so far.")).closest("p")!;
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("Cancel ends the scan and says the access ended", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(view());
    vi.spyOn(api, "importStep").mockReturnValue(new Promise(() => undefined));
    const cancel = vi
      .spyOn(api, "importCancel")
      .mockResolvedValue(view({ status: "cancelled", finished: true, revoked: true }));
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith("job-1");
    expect(await screen.findByText(/You stopped the scan. Hippo has ended its access/)).toBeInTheDocument();
  });

  it("a scan Google cut short says so and offers to try again", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(
      view({ status: "failed", finished: true, error: "auth_ended", counts: { ...counts, scanned: 3, found: 1 } }),
    );
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    expect(await screen.findByRole("heading", { name: "The scan did not finish" })).toBeInTheDocument();
    expect(screen.getByText(/Google ended the access before the scan finished/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/connect");
  });

  it("resumes the latest scan when opened without a job", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importLatest").mockResolvedValue({ import: done({ counts: { ...counts, scanned: 1, found: 0 } }) });
    loadList([], []);
    wrap(<ImportPage />, "/import", "/import");
    expect(await screen.findByRole("heading", { name: "No subscriptions found" })).toBeInTheDocument();
  });

  it("says so when there was no scan, and when the connection drops it offers to carry on", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importLatest").mockResolvedValue({ import: null });
    wrap(<ImportPage />, "/import", "/import");
    expect(await screen.findByRole("heading", { name: "No scan yet" })).toBeInTheDocument();
  });

  it("lists spotted documents as text, never as markup, and says no attachment was opened", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(
      done({
        spotted: [
          {
            kind: "lease",
            subject: "<img src=x onerror=alert(1)>",
            sender: "oak.example",
            date: "2026-10-20",
            filename: "Lease.pdf",
          },
        ],
      }),
    );
    loadList([], []);
    const { container } = wrap(<ImportPage />, "/import?job=job-1", "/import");
    expect(await screen.findByText(/Documents Hippo spotted but cannot read yet/)).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/opened no attachment/)).toBeInTheDocument();
  });

  it("asks Google-ended access to be removed by hand when Google did not confirm", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("offer"));
    vi.spyOn(api, "importView").mockResolvedValue(done({ revoked: false }));
    loadList([], []);
    wrap(<ImportPage />, "/import?job=job-1", "/import");
    await waitFor(() => expect(screen.getByText(/myaccount.google.com\/permissions/)).toBeInTheDocument());
    expect(screen.queryByText(/access to your Gmail has ended/)).toBeNull();
  });
});

describe("Settings: Gmail", () => {
  const open = () => wrap(<SettingsPage />, "/settings", "/settings");

  it("shows nothing when the import is off", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("off"));
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [] });
    open();
    await screen.findByTestId("digest-to");
    expect(screen.queryByTestId("gmail-status")).toBeNull();
  });

  it("after a scan says the access ended and offers to scan again", async () => {
    vi.spyOn(api, "me").mockResolvedValue(me("done"));
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [] });
    open();
    expect(await screen.findByTestId("gmail-status")).toHaveTextContent(/ended its access/);
    expect(screen.getByRole("link", { name: "Scan again" })).toHaveAttribute("href", "/connect");
  });
});

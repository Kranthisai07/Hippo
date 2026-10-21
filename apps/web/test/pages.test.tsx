import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/lib/auth";
import { ToastProvider } from "../src/components/ui";
import { ApiError, api } from "../src/lib/api";
import { ComingUp } from "../src/pages/ComingUp";
import { Review } from "../src/pages/Review";
import { SignIn } from "../src/pages/SignIn";
import { Things } from "../src/pages/Things";
import type { AgreementView, Doc, ObligationItem } from "../src/lib/types";

afterEach(() => vi.restoreAllMocks());

const doc: Doc = {
  id: "doc-1",
  filename: "lease.pdf",
  docType: "lease",
  status: "needs_review",
  pages: 4,
  uploadedAt: "2026-10-21T12:00:00.000Z",
  assetIds: [],
};
const ref = (page: number, quote: string) => ({ page, quote });
const agreement = (status: "extracted" | "confirmed" = "extracted"): AgreementView => ({
  id: "agr-1",
  kind: "lease",
  fields: [
    { name: "landlord", value: "Maple Court", status, sourceRef: ref(1, "Landlord: Maple Court"), isDate: false },
    { name: "endDate", value: "2026-12-31", status, sourceRef: ref(1, "through December 31, 2026"), isDate: true },
    {
      name: "noticeDaysToVacate",
      value: 60,
      status,
      sourceRef: ref(4, "at least sixty (60) days before the end"),
      isDate: true,
    },
  ],
});

function wrap(ui: React.ReactNode, path = "/", route = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("Review: Confirm all dates", () => {
  it("sends only the date fields on screen, then shows the deadline with its clause and page", async () => {
    vi.spyOn(api, "getDoc").mockResolvedValue({ doc, agreement: agreement() });
    vi.spyOn(api, "getPage").mockResolvedValue({
      page: 4,
      text: "Tenant must give notice at least sixty (60) days before the end of the term.",
    });
    const confirm = vi.spyOn(api, "confirmFields").mockResolvedValue({
      agreement: agreement("confirmed"),
      obligations: [
        {
          id: "agr-1:notice_by:2026-11-01",
          type: "notice_by",
          dueDate: "2026-11-01",
          label: "Lease notice deadline",
          confirmed: true,
          severity: "high",
        },
      ],
    });
    wrap(<Review />, "/review/doc-1", "/review/:docId");

    const button = await screen.findByRole("button", { name: /Confirm all dates/ });
    expect(screen.getByText(/2 dates to confirm/)).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("agr-1", ["endDate", "noticeDaysToVacate"]);
    const card = await screen.findByTestId("deadline-card");
    expect(card).toHaveTextContent("Give notice by Nov 1 (in 11 days)");
    expect(card).toHaveTextContent("page 4");
    expect(card).toHaveTextContent("sixty (60) days");
  });

  it("shows the server message when a failed document has a reason", async () => {
    vi.spyOn(api, "getDoc").mockResolvedValue({
      doc: { ...doc, status: "failed", failureReason: "We could not read this file." },
      agreement: null,
    });
    wrap(<Review />, "/review/doc-1", "/review/:docId");
    expect(await screen.findByText("We could not read this file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm all dates/ })).toBeNull();
  });
});

describe("Coming up", () => {
  const item = (needs: boolean): ObligationItem => ({
    obligation: {
      id: "agr-1:notice_by:2026-11-01",
      type: "notice_by",
      dueDate: "2026-11-01",
      label: "Lease notice deadline",
      confirmed: !needs,
      severity: needs ? null : "high",
    },
    needsConfirmation: needs,
    docId: "doc-1",
  });

  it("keeps an unconfirmed date in its own group with the banner and no reminder buttons", async () => {
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [doc] });
    vi.spyOn(api, "listAlerts").mockResolvedValue({ alerts: [] });
    vi.spyOn(api, "listAssets").mockResolvedValue({ assets: [] });
    vi.spyOn(api, "listObligations").mockResolvedValue({ items: [item(true)] });
    wrap(<ComingUp />);
    expect(await screen.findByText("Needs your confirmation")).toBeInTheDocument();
    expect(screen.getByText("Nothing alerts you until you confirm a date.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("confirmed-item")).toHaveLength(0);
    expect(screen.getAllByTestId("unconfirmed-item")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.getByRole("link", { name: /Review and confirm/ })).toHaveAttribute("href", "/review/doc-1");
  });

  it("shows a confirmed item with days away and reminder buttons", async () => {
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [doc] });
    vi.spyOn(api, "listAlerts").mockResolvedValue({
      alerts: [
        {
          id: "alert-1",
          source: "deadline",
          severity: "high",
          status: "pending",
          label: "Lease notice deadline",
          refId: "agr-1:notice_by:2026-11-01",
          dueDate: "2026-11-01",
        },
      ],
    });
    vi.spyOn(api, "listAssets").mockResolvedValue({ assets: [] });
    vi.spyOn(api, "listObligations").mockResolvedValue({ items: [item(false)] });
    wrap(<ComingUp />);
    const card = await screen.findByTestId("confirmed-item");
    expect(card).toHaveTextContent("Give notice by 2026-11-01");
    expect(card).toHaveTextContent("in 11 days");
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("says a recall may affect the item", async () => {
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [doc] });
    vi.spyOn(api, "listAssets").mockResolvedValue({ assets: [{ id: "a1", name: "Baby bottle set" }] });
    vi.spyOn(api, "listObligations").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listAlerts").mockResolvedValue({
      alerts: [
        {
          id: "r1",
          source: "recall",
          severity: "high",
          status: "pending",
          label: "Bottle recall",
          refId: "cpsc-1",
          assetId: "a1",
        },
      ],
    });
    wrap(<ComingUp />);
    expect(await screen.findByText(/Recall that may affect Baby bottle set/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not mine" })).toBeInTheDocument();
  });

  it("has a warm empty state", async () => {
    vi.spyOn(api, "listDocs").mockResolvedValue({ docs: [] });
    vi.spyOn(api, "listAlerts").mockResolvedValue({ alerts: [] });
    vi.spyOn(api, "listAssets").mockResolvedValue({ assets: [] });
    vi.spyOn(api, "listObligations").mockResolvedValue({ items: [] });
    wrap(<ComingUp />);
    expect(await screen.findByTestId("empty-state")).toHaveTextContent(/Upload your lease/);
    expect(screen.getByRole("link", { name: /Upload a document/ })).toBeInTheDocument();
  });

  it("shows the error with a retry that loads again", async () => {
    const docs = vi
      .spyOn(api, "listDocs")
      .mockRejectedValueOnce(new ApiError(500, "internal", "Something went wrong on our side. Please try again."));
    docs.mockResolvedValue({ docs: [] });
    vi.spyOn(api, "listAlerts").mockResolvedValue({ alerts: [] });
    vi.spyOn(api, "listAssets").mockResolvedValue({ assets: [] });
    vi.spyOn(api, "listObligations").mockResolvedValue({ items: [] });
    wrap(<ComingUp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
  });
});

describe("Things", () => {
  it("has an empty state and an error state", async () => {
    vi.spyOn(api, "listAssets").mockResolvedValueOnce({ assets: [] });
    wrap(<Things />);
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("No things yet");
  });
  it("shows the error", async () => {
    vi.spyOn(api, "listAssets").mockRejectedValue(new ApiError(500, "internal", "Boom."));
    wrap(<Things />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom.");
  });
});

describe("Sign in", () => {
  it("shows the wait message on 429, disables the buttons and does not retry", async () => {
    const send = vi
      .spyOn(api, "magicCode")
      .mockRejectedValue(
        new ApiError(429, "rate_limited", "Too many tries. Please wait 30 seconds and try again.", 30),
      );
    vi.spyOn(api, "me").mockRejectedValue(new ApiError(401, "unauthenticated", "Please sign in again."));
    wrap(
      <AuthProvider>
        <SignIn />
      </AuthProvider>,
      "/signin",
      "/signin",
    );
    await userEvent.type(await screen.findByLabelText("Email"), "a@b.co");
    await userEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wait 30 seconds");
    expect(screen.getByRole("button", { name: "Send me a code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use the demo account" })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 100));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

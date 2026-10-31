import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { Subscriptions } from "../src/pages/Subscriptions";
import type { Subscription } from "../src/lib/types";

afterEach(() => vi.restoreAllMocks());

const sub = (over: Partial<Subscription>): Subscription => ({
  agreementId: "agr-1",
  docId: "doc-1",
  vendor: "Fernwood Streaming",
  plan: "Family",
  amount: 15.99,
  cycle: "monthly",
  nextChargeDate: "2026-11-03",
  confirmed: true,
  source: { docName: "account.fernwood.example Billing", page: 1 },
  ...over,
});

const show = (subscriptions: Subscription[], monthlyTotal: number) => {
  vi.spyOn(api, "listSubscriptions").mockResolvedValue({ subscriptions, monthlyTotal });
  render(
    <MemoryRouter>
      <Subscriptions />
    </MemoryRouter>,
  );
};

describe("Subscriptions page", () => {
  it("shows the confirmed total and each subscription", async () => {
    show([sub({})], 15.99);
    expect(await screen.findByText("Fernwood Streaming")).toBeInTheDocument();
    expect(screen.getByText("$15.99")).toBeInTheDocument();
    expect(screen.getByText(/next charge 2026-11-03/)).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  it("cites the document and page of a price, and links to it", async () => {
    show([sub({})], 15.99);
    const link = await screen.findByRole("link", { name: "account.fernwood.example Billing" });
    expect(link).toHaveAttribute("href", "/review/doc-1");
    expect(link.parentElement).toHaveTextContent("page 1");
  });

  it("sends an unconfirmed one to review and says it is not counted", async () => {
    show([sub({ confirmed: false })], 0);
    const link = await screen.findByRole("link", { name: "Review" });
    expect(link).toHaveAttribute("href", "/review/doc-1");
    expect(screen.getByText(/1 more to review, not counted yet/)).toBeInTheDocument();
  });

  it("has no review link for a subscription with no document", async () => {
    show([sub({ confirmed: false, docId: null, source: null })], 0);
    expect(await screen.findByText("Not confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
  });

  it("shows text from a page as text, never as HTML", async () => {
    show([sub({ vendor: "<img src=x onerror=alert(1)>" })], 0);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("explains an empty list", async () => {
    show([], 0);
    expect(await screen.findByText("No subscriptions yet")).toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const renderLink = async () => {
  const { DemoLink } = await import("../src/landing/DemoLink");
  render(
    <MemoryRouter>
      <DemoLink className="lp-btn" label="Try the demo" />
    </MemoryRouter>,
  );
};

describe("the landing demo button", () => {
  it("opens the live demo sign in on the hosted static site", async () => {
    vi.stubEnv("VITE_HOSTED", "1");
    await renderLink();
    expect(screen.getByRole("link", { name: "Run the demo" })).toHaveAttribute(
      "href",
      "https://hippo-production-f9ae.up.railway.app/signin",
    );
  });

  it("goes to the local sign in route in the normal build", async () => {
    vi.stubEnv("VITE_HOSTED", "");
    await renderLink();
    expect(screen.getByRole("link", { name: "Try the demo" })).toHaveAttribute("href", "/signin");
  });
});

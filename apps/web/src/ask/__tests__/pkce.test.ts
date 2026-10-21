import { describe, expect, it } from "vitest";
import { challengeFor, makeState, makeVerifier, stateMatches } from "../pkce";

describe("pkce", () => {
  it("makes a 43 character url safe verifier, different each time", () => {
    const a = makeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeVerifier()).not.toBe(a);
  });

  it("computes the S256 challenge of the RFC 7636 appendix B test vector", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares state exactly and refuses empty or missing values", () => {
    const s = makeState();
    expect(stateMatches(s, s)).toBe(true);
    expect(stateMatches(s, `${s}x`)).toBe(false);
    expect(stateMatches(s, null)).toBe(false);
    expect(stateMatches(null, null)).toBe(false);
    expect(stateMatches("", "")).toBe(false);
  });
});

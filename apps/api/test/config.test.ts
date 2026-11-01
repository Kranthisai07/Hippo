import { describe, expect, it } from "vitest";
import { productionProblems } from "../src/config";
import { startServer } from "../src/server";
import { BASE } from "./helpers";
import { makeWeb } from "./webHelpers";

const GOOD = {
  HIPPO_ENV: "production",
  HIPPO_SIGNING_KEY: "k".repeat(40),
  HIPPO_ISSUER: "https://api.hippo.example",
  HIPPO_DEMO: "0",
  HIPPO_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
  HIPPO_CLIENT_IP_HEADER: "cf-connecting-ip",
  HIPPO_ALLOWED_ORIGINS: "https://app.hippo.example",
};

describe("production config", () => {
  it("accepts a complete config on a durable host", () => {
    expect(productionProblems(GOOD, { durable: true, mailer: true })).toEqual([]);
  });
  it.each([
    ["a short signing key", { HIPPO_SIGNING_KEY: "short" }],
    ["no signing key", { HIPPO_SIGNING_KEY: undefined }],
    ["an http issuer", { HIPPO_ISSUER: "http://api.hippo.example" }],
    ["the demo login on", { HIPPO_DEMO: "1" }],
    ["the demo flag unset", { HIPPO_DEMO: undefined }],
    ["no extension id", { HIPPO_EXTENSION_ID: undefined }],
    ["no client address header", { HIPPO_CLIENT_IP_HEADER: undefined }],
    ["localhost in the origins", { HIPPO_ALLOWED_ORIGINS: "https://app.hippo.example,http://localhost:5173" }],
    ["a wildcard origin", { HIPPO_ALLOWED_ORIGINS: "*" }],
  ])("refuses %s", (_name, change) => {
    expect(productionProblems({ ...GOOD, ...change }, { durable: true, mailer: true })).toHaveLength(1);
  });
  it.each([
    ["a Google client id with no secret", { HIPPO_GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com" }],
    ["a Google secret with no client id", { HIPPO_GOOGLE_CLIENT_SECRET: "secret" }],
  ])("refuses %s", (_name, change) => {
    expect(productionProblems({ ...GOOD, ...change }, { durable: true, mailer: true })).toHaveLength(1);
  });
  it("accepts a Google client id with its secret", () => {
    const both = { HIPPO_GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", HIPPO_GOOGLE_CLIENT_SECRET: "secret" };
    expect(productionProblems({ ...GOOD, ...both }, { durable: true, mailer: true })).toEqual([]);
  });
  it("refuses no mailer", () => {
    expect(productionProblems(GOOD, { durable: true, mailer: false })).toHaveLength(1);
  });
  it("refuses memory storage", () => {
    expect(productionProblems(GOOD, { durable: false, mailer: true })).toHaveLength(1);
  });
  it("the in-memory server will not start in production", async () => {
    await expect(startServer({ env: GOOD, log: () => undefined })).rejects.toThrow(/in memory/);
  });
});

describe("response headers", () => {
  it("every response says nosniff and no-referrer, and HSTS only when asked", async () => {
    const plain = await makeWeb();
    const a = await plain.app.request(`${BASE}/healthz`);
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    expect(a.headers.get("referrer-policy")).toBe("no-referrer");
    expect(a.headers.get("strict-transport-security")).toBeNull();
    const secure = await makeWeb({ app: { hsts: true } });
    expect((await secure.app.request(`${BASE}/healthz`)).headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
  });
  it("also on an error answered by a handler", async () => {
    const w = await makeWeb();
    const r = await w.app.request(`${BASE}/ext/subscriptions`);
    expect(r.status).toBe(401);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

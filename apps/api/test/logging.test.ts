import { describe, expect, it } from "vitest";
import { BASE } from "./helpers";
import { makeWeb } from "./webHelpers";

describe("the access log", () => {
  it("writes one JSON line per request with an id, and the id is sent back", async () => {
    const w = await makeWeb();
    const r = await w.app.request(`${BASE}/healthz`);
    const id = r.headers.get("x-request-id")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const line = JSON.parse(w.requestLog.find((l) => l.includes(id))!) as Record<string, unknown>;
    expect(line).toMatchObject({ id, method: "GET", path: "/healthz", status: 200 });
    expect(typeof line.ms).toBe("number");
  });
  it("holds no query string, token, email or page text", async () => {
    const w = await makeWeb();
    const secret = "SENTINEL-page-text-7731";
    await w.app.request(`${BASE}/ext/captures?access_token=QUERYTOKEN`, {
      method: "POST",
      headers: { authorization: "Bearer BEARERTOKEN", "content-type": "application/json" },
      body: JSON.stringify({ title: secret, host: "x.example", text: secret }),
    });
    await w.a.get("/api/me");
    const all = w.requestLog.join("\n");
    for (const s of ["QUERYTOKEN", "BEARERTOKEN", secret, "demo@hippo.test"]) expect(all).not.toContain(s);
    expect(w.requestLog.length).toBeGreaterThan(0);
  });
  it("counts a refused request with its status", async () => {
    const w = await makeWeb();
    await w.app.request(`${BASE}/ext/subscriptions`);
    expect(w.requestLog.some((l) => l.includes('"status":401'))).toBe(true);
  });
  it("sends the request id on a response a handler built itself, like a bare 401", async () => {
    const w = await makeWeb();
    const r = await w.app.request(`${BASE}/ext/subscriptions`);
    expect(r.status).toBe(401);
    const id = r.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.requestLog.some((l) => l.includes(id!))).toBe(true);
  });
});

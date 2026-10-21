import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, parseError } from "../src/lib/api";

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = body === undefined ? null : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => vi.unstubAllGlobals());

describe("error parsing", () => {
  it("reads the {error:{code,message}} shape of /api", async () => {
    const e = await parseError(reply(400, { error: { code: "invalid_request", message: "That value does not fit." } }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.code).toBe("invalid_request");
    expect(e.message).toBe("That value does not fit.");
  });

  it("reads the bare string shape /oauth uses and gives a plain message", async () => {
    const e = await parseError(reply(401, { error: "access_denied" }));
    expect(e.code).toBe("access_denied");
    expect(e.message).toMatch(/did not work/i);
  });

  it("keeps Retry-After seconds on a 429 and says how long to wait", async () => {
    const e = await parseError(reply(429, { error: "rate_limited" }, { "Retry-After": "42" }));
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(42);
    expect(e.message).toContain("42");
  });

  it("falls back to a calm message when the body is not JSON", async () => {
    const e = await parseError(new Response("<html>boom</html>", { status: 502 }));
    expect(e.status).toBe(502);
    expect(e.message).not.toContain("<html>");
    expect(e.message.length).toBeGreaterThan(10);
  });
});

describe("client", () => {
  it("sends JSON writes with a content type and same-origin credentials, and throws ApiError on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(404, { error: { code: "not_found", message: "We could not find that." } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.confirmFields("a1", ["endDate"])).rejects.toMatchObject({ status: 404, code: "not_found" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agreements/a1/confirm");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ fields: ["endDate"] }));
    expect(init.credentials).toBe("same-origin");
  });

  it("encodes path parts so a hostile id cannot change the route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { doc: {}, agreement: null }));
    vi.stubGlobal("fetch", fetchMock);
    await api.getDoc("../x?y=1");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/docs/..%2Fx%3Fy%3D1");
  });

  it("sends the exact delete-all body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.deleteAllData();
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ confirm: "delete all my data" }));
  });

  it("puts raw bytes with exactly the headers the server named", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });
    await api.putUpload(
      {
        method: "PUT",
        url: "/api/uploads/d1/content",
        headers: { "Content-Type": "application/pdf" },
        expiresInSeconds: 900,
      },
      file,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/uploads/d1/content");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/pdf" });
    expect(init.body).toBe(file);
  });
});

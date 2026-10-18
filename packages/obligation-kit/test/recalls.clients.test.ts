import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CpscApiError,
  NhtsaApiError,
  createNhtsaClient,
  fetchCpscRecalls,
  fetchNhtsaRecalls,
  type HttpResponse,
} from "../src/recalls";

const FIX = fileURLToPath(new URL("../../../fixtures/recalls/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(`${FIX}${p}`, "utf8"));
const boon = load("cpsc/recall_26530_boon_nursh_bottles.json");
const crv = load("nhtsa/recallsByVehicle_HONDA_CR-V_2021.json");
const models = load("nhtsa/models_HONDA_2021_issueType-r.json");
const V = { make: "HONDA", model: "CR-V", year: 2021 };

const ok = (body: unknown): HttpResponse => ({ ok: true, status: 200, json: async () => body });
const status = (s: number): HttpResponse => ({ ok: false, status: s, json: async () => ({}) });

function harness(script: (HttpResponse | Error)[]) {
  let t = 1_000_000;
  const calls: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const queue = [...script];
  const deps = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    fetch: async (url: string) => {
      calls.push({ url, at: t });
      const next = queue.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { deps, calls, sleeps, advance: (ms: number) => (t += ms) };
}

describe("fetchCpscRecalls", () => {
  it("fetches, validates and normalizes", async () => {
    const urls: string[] = [];
    const out = await fetchCpscRecalls({ RecallNumber: "26530" }, { fetch: async (u) => (urls.push(u), ok(boon)) });
    expect(out[0]?.recallNumber).toBe("26530");
    expect(urls).toEqual(["https://www.saferproducts.gov/RestWebServices/Recall?RecallNumber=26530&format=json"]);
  });
  it("an empty array is an empty result", async () => {
    expect(await fetchCpscRecalls({ ProductName: "zzz" }, { fetch: async () => ok([]) })).toEqual([]);
  });
  it("the HTTP 200 error record throws, not an empty list", async () => {
    const bad = [{ RecallID: 0, RecallNumber: null, Title: "Error retrieving Recalls: The underlying provider failed on Open.", Products: [] }];
    await expect(fetchCpscRecalls({ ProductName: "x" }, { fetch: async () => ok(bad) })).rejects.toBeInstanceOf(CpscApiError);
  });
  it("unknown param throws before any fetch", async () => {
    let called = false;
    await expect(fetchCpscRecalls({ UPC: "1" }, { fetch: async () => ((called = true), ok([])) })).rejects.toBeInstanceOf(CpscApiError);
    expect(called).toBe(false);
  });
  it("non-ok status throws without echoing the url", async () => {
    await expect(fetchCpscRecalls({ ProductName: "secret" }, { fetch: async () => status(503) })).rejects.toThrow(/^(?!.*secret).*503/);
  });
  it("network error throws a typed error without the original message", async () => {
    await expect(
      fetchCpscRecalls({ ProductName: "x" }, { fetch: async () => { throw new Error("https://leak.example/?q=1"); } }),
    ).rejects.toThrow(/^(?!.*leak).*network/);
  });
  it("invalid JSON throws", async () => {
    const res: HttpResponse = { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } };
    await expect(fetchCpscRecalls({ ProductName: "x" }, { fetch: async () => res })).rejects.toBeInstanceOf(CpscApiError);
  });
  it("applies the ceiling", async () => {
    await expect(fetchCpscRecalls({ ProductName: "x" }, { fetch: async () => ok([...boon, ...boon]), maxRecords: 1 })).rejects.toThrow(/ceiling/);
  });
  it("is not retried", async () => {
    let n = 0;
    await expect(fetchCpscRecalls({ ProductName: "x" }, { fetch: async () => (n++, status(500)) })).rejects.toBeInstanceOf(CpscApiError);
    expect(n).toBe(1);
  });
});

describe("fetchNhtsaRecalls", () => {
  it("returns parsed recalls", async () => {
    const h = harness([ok(crv)]);
    const out = await fetchNhtsaRecalls(V, h.deps);
    expect(out).toHaveLength(4);
    expect(h.calls[0]?.url).toBe("https://api.nhtsa.gov/recalls/recallsByVehicle?make=HONDA&model=CR-V&modelYear=2021");
  });
  it("makes no sleep before the first call", async () => {
    const h = harness([ok(crv)]);
    await fetchNhtsaRecalls(V, h.deps);
    expect(h.sleeps).toEqual([]);
  });
  it("invalid vehicle throws before any fetch", async () => {
    const h = harness([]);
    await expect(fetchNhtsaRecalls({ ...V, model: "" }, h.deps)).rejects.toBeInstanceOf(NhtsaApiError);
    expect(h.calls).toHaveLength(0);
  });
  it("never retries 400", async () => {
    const h = harness([status(400), ok(crv)]);
    await expect(fetchNhtsaRecalls(V, h.deps)).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(1);
  });
  it.each([401, 403, 404])("never retries %i", async (s) => {
    const h = harness([status(s), ok(crv)]);
    await expect(fetchNhtsaRecalls(V, h.deps)).rejects.toBeInstanceOf(NhtsaApiError);
    expect(h.calls).toHaveLength(1);
  });
  it.each([429, 500, 502, 503])("retries %i then succeeds", async (s) => {
    const h = harness([status(s), ok(crv)]);
    expect(await fetchNhtsaRecalls(V, h.deps)).toHaveLength(4);
    expect(h.calls).toHaveLength(2);
  });
  it("retries a network error", async () => {
    const h = harness([new Error("ECONNRESET"), ok(crv)]);
    expect(await fetchNhtsaRecalls(V, h.deps)).toHaveLength(4);
  });
  it("gives up after 3 attempts", async () => {
    const h = harness([status(503), status(503), status(503), ok(crv)]);
    await expect(fetchNhtsaRecalls(V, h.deps)).rejects.toThrow(/3 attempts/);
    expect(h.calls).toHaveLength(3);
  });
  it("backs off exponentially: 500 then 1000", async () => {
    const h = harness([status(503), status(503), status(503)]);
    await fetchNhtsaRecalls(V, h.deps).catch(() => {});
    expect(h.sleeps).toEqual([500, 1000]);
    expect(h.calls[1]!.at - h.calls[0]!.at).toBe(500);
    expect(h.calls[2]!.at - h.calls[1]!.at).toBe(1000);
  });
  it("final error does not leak the error text of a network failure", async () => {
    const h = harness([new Error("https://leak.example/x"), new Error("a"), new Error("b")]);
    await expect(fetchNhtsaRecalls(V, h.deps)).rejects.toThrow(/^(?!.*leak)/);
  });
  it("error after non-JSON body", async () => {
    const res: HttpResponse = { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } };
    await expect(fetchNhtsaRecalls(V, harness([res]).deps)).rejects.toBeInstanceOf(NhtsaApiError);
  });
  it("a malformed body throws and is not retried", async () => {
    const h = harness([ok({ nope: 1 }), ok(crv)]);
    await expect(fetchNhtsaRecalls(V, h.deps)).rejects.toBeInstanceOf(NhtsaApiError);
    expect(h.calls).toHaveLength(1);
  });
});

describe("pacing", () => {
  it("spaces consecutive calls on one client by at least 250 ms", async () => {
    const h = harness([ok(crv), ok(crv), ok(crv)]);
    const c = createNhtsaClient(h.deps);
    await c.recalls(V);
    await c.recalls(V);
    await c.recalls(V);
    expect(h.calls[1]!.at - h.calls[0]!.at).toBe(250);
    expect(h.calls[2]!.at - h.calls[1]!.at).toBe(250);
    expect(h.sleeps).toEqual([250, 250]);
  });
  it("only sleeps for the remainder when time has already passed", async () => {
    const h = harness([ok(crv), ok(crv)]);
    const c = createNhtsaClient(h.deps);
    await c.recalls(V);
    h.advance(100);
    await c.recalls(V);
    expect(h.sleeps).toEqual([150]);
  });
  it("does not sleep when 250 ms or more has passed", async () => {
    const h = harness([ok(crv), ok(crv)]);
    const c = createNhtsaClient(h.deps);
    await c.recalls(V);
    h.advance(400);
    await c.recalls(V);
    expect(h.sleeps).toEqual([]);
  });
  it("retries are paced too", async () => {
    const h = harness([status(429), status(429), ok(crv)]);
    await fetchNhtsaRecalls(V, h.deps);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i]!.at - h.calls[i - 1]!.at).toBeGreaterThanOrEqual(250);
  });
});

describe("canonicalize via client", () => {
  it("fetches the models list and resolves CRV", async () => {
    const h = harness([ok(models)]);
    const out = await createNhtsaClient(h.deps).canonicalize({ make: "Honda", model: "CRV", year: 2021 });
    expect(out).toEqual({ nhtsaMake: "HONDA", nhtsaModel: "CR-V" });
    expect(h.calls[0]?.url).toBe("https://api.nhtsa.gov/products/vehicle/models?modelYear=2021&make=Honda&issueType=r");
  });
  it("unknown model gives null", async () => {
    const h = harness([ok(models)]);
    expect(await createNhtsaClient(h.deps).canonicalize({ make: "Honda", model: "Zzz", year: 2021 })).toBeNull();
  });
});

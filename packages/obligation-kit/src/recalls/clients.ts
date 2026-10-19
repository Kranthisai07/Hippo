// NOTE: DAILY JOB ONLY. The clients (fetchCpscRecalls, createNhtsaClient, fetchNhtsaRecalls) do outbound HTTP and must
// never be reachable from the voice or MCP path. Nothing enforces that here: it is a convention, so a caller in a
// request handler is a bug. Only the pure parsers and matchers are safe to import from request code.
// HTTP clients for the Recall Radar. DAILY JOB ONLY: never call these from the voice or MCP path (CLAUDE.md: no
// outbound HTTP inside MCP tool handlers). fetch, sleep and now are injected, so nothing here touches the network on its
// own and tests run on a fake clock. URLs and bodies are never logged or put in error messages.

import { CpscApiError, buildCpscUrl, normalizeCpscRecall, parseCpscResponse, type CpscRecall } from "./cpsc";
import { NhtsaApiError, canonicalizeVehicle, modelsUrl, parseNhtsaResponse, recallsByVehicleUrl, type NhtsaRecall } from "./nhtsa";

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string) => Promise<HttpResponse>;

export async function fetchCpscRecalls(
  params: Record<string, string>,
  deps: { fetch: FetchLike; maxRecords?: number },
): Promise<CpscRecall[]> {
  const url = buildCpscUrl(params);
  let res: HttpResponse;
  try {
    res = await deps.fetch(url);
  } catch {
    throw new CpscApiError("CPSC request failed (network)");
  }
  if (!res.ok) throw new CpscApiError(`CPSC request failed (HTTP ${res.status})`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CpscApiError("CPSC response is not JSON");
  }
  return parseCpscResponse(body, { maxRecords: deps.maxRecords }).map(normalizeCpscRecall);
}

const PACE_MS = 250;
/** More queued time than this means the clock went backwards, so the backlog is dropped instead of slept. */
const MAX_BACKLOG_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;

export interface NhtsaDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** One client per daily run: the 250 ms pacing is shared by every call made through it. */
export function createNhtsaClient(deps: NhtsaDeps) {
  let last: number | null = null;

  async function getJson(url: string): Promise<unknown> {
    let why = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await deps.sleep(BACKOFF_MS * 2 ** (attempt - 2));
      // Reserve the slot synchronously so concurrent calls queue behind each other instead of racing.
      const now = deps.now();
      if (last !== null && last - now > MAX_BACKLOG_MS) last = null;
      const slot = last === null ? now : Math.max(now, last + PACE_MS);
      last = slot;
      if (slot > now) await deps.sleep(slot - now);
      let res: HttpResponse | undefined;
      try {
        res = await deps.fetch(url);
      } catch {
        why = "network error";
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        why = `HTTP ${res.status}`;
        continue;
      }
      // 400 (blank or unknown model, bad year) and every other 4xx is final: retrying cannot help.
      if (!res.ok) throw new NhtsaApiError(`NHTSA request failed (HTTP ${res.status})`, res.status);
      try {
        return await res.json();
      } catch {
        throw new NhtsaApiError("NHTSA response is not JSON");
      }
    }
    throw new NhtsaApiError(`NHTSA request failed after ${MAX_ATTEMPTS} attempts (${why})`);
  }

  return {
    recalls: async (v: { make: string; model: string; year: number }): Promise<NhtsaRecall[]> =>
      parseNhtsaResponse(await getJson(recallsByVehicleUrl(v))),
    /** Canonical NHTSA spelling for a vehicle, or null. Run once per asset and store the result. */
    canonicalize: async (v: { make: string; model: string; year: number }) =>
      canonicalizeVehicle(v, await getJson(modelsUrl({ make: v.make, year: v.year }))),
  };
}

export const fetchNhtsaRecalls = (v: { make: string; model: string; year: number }, deps: NhtsaDeps): Promise<NhtsaRecall[]> =>
  createNhtsaClient(deps).recalls(v);

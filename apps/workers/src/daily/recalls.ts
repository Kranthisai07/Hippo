import type { Alert, Asset, Repository } from "core/src/contracts";
import {
  CpscApiError,
  NhtsaApiError,
  matchCpscRecalls,
  matchNhtsaRecall,
  nhtsaSpeech,
  type CpscRecall,
  type NhtsaRecall,
  type RecallAsset,
} from "obligation-kit/src/recalls";
import { addDays } from "obligation-kit";
// Deep paths on purpose: the network clients are for this job only (CLAUDE.md: no outbound HTTP in MCP handlers).
import { createNhtsaClient, fetchCpscRecalls, type FetchLike } from "obligation-kit/src/recalls/clients";
import type { DailyConfig, RunError } from "./types";

export const recallAlertId = (source: "cpsc" | "nhtsa", recallId: string, assetId: string): string =>
  `alert-recall-${source}-${recallId}-${assetId}`;

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_MAX_NHTSA = 20;
const clip = (s: string | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Only the client's own message (fixed strings, no URL or body) or the error class name ever reaches the report. */
function describe(source: "cpsc" | "nhtsa", e: unknown, assetId?: string): RunError {
  const typed = e instanceof CpscApiError || e instanceof NhtsaApiError;
  return {
    source,
    kind: typed ? "api_error" : "unexpected",
    message: typed ? e.message : `unexpected error (${e instanceof Error ? e.name : "unknown"})`,
    ...(assetId ? { assetId } : {}),
  };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

export interface RadarResult {
  recallsChecked: number;
  created: number;
  leftAlone: number;
  errors: RunError[];
}

const toRecallAsset = (a: Asset): RecallAsset => ({
  id: a.id,
  name: a.name,
  brand: a.brand ?? null,
  modelNumber: a.modelNumber ?? null,
  upc: a.upc ?? null,
  vehicle: a.vehicle ?? null,
});

/**
 * One radar per run. It makes at most one CPSC request (shared by every household) and at most `maxNhtsaRequests`
 * NHTSA requests, and remembers every answer, so two households with the same car cost one lookup.
 * A failed API never reads as "no recalls": the failure is returned as an error and existing recall alerts stay as they are.
 */
export function createRecallRadar(deps: {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  config?: DailyConfig;
}) {
  const maxNhtsa = deps.config?.maxNhtsaRequests ?? DEFAULT_MAX_NHTSA;
  const requests = { cpsc: 0, nhtsa: 0, nhtsaCap: maxNhtsa, nhtsaCapReached: false };

  const countedNhtsaFetch: FetchLike = async (url) => {
    if (requests.nhtsa >= maxNhtsa) {
      requests.nhtsaCapReached = true;
      throw new Error("NHTSA request cap reached");
    }
    requests.nhtsa++;
    return deps.fetch(url);
  };
  const nhtsa = createNhtsaClient({ fetch: countedNhtsaFetch, sleep: deps.sleep, now: deps.now });

  let cpscOnce: Promise<Attempt<CpscRecall[]>> | null = null;
  const cpsc = (today: string): Promise<Attempt<CpscRecall[]>> => {
    cpscOnce ??= attempt(() => {
      requests.cpsc++;
      const days = deps.config?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
      // Both ends, always: an End date alone returns the whole database (G-013).
      return fetchCpscRecalls(
        { LastPublishDateStart: addDays(today, -days), LastPublishDateEnd: today },
        { fetch: deps.fetch },
      );
    });
    return cpscOnce;
  };

  const canonical = new Map<string, Promise<Attempt<{ nhtsaMake: string; nhtsaModel: string } | null>>>();
  const byVehicle = new Map<string, Promise<Attempt<NhtsaRecall[]>>>();
  const memo = <T>(m: Map<string, Promise<Attempt<T>>>, key: string, run: () => Promise<T>): Promise<Attempt<T>> => {
    if (!m.has(key)) m.set(key, attempt(run));
    return m.get(key)!;
  };

  async function putIfAbsent(repo: Repository, hh: string, alert: Alert, r: RadarResult): Promise<void> {
    if (await repo.getAlert(hh, alert.id)) {
      r.leftAlone++;
      return;
    }
    await repo.putAlert(hh, alert);
    r.created++;
  }

  async function run(repo: Repository, hh: string, today: string): Promise<RadarResult> {
    const r: RadarResult = { recallsChecked: 0, created: 0, leftAlone: 0, errors: [] };
    const assets = await repo.listAssets(hh);
    const suppressions = await repo.listSuppressions(hh);
    const suppressed = new Set(suppressions.map((s) => `${s.source}|${s.recallId}|${s.assetId}`));

    // A "not mine" answer wins over an alert that is still waiting. Announced alerts are left alone.
    for (const s of suppressions) {
      const old = await repo.getAlert(hh, recallAlertId(s.source, s.recallId, s.assetId));
      if (old?.status === "pending") await repo.putAlert(hh, { ...old, status: "dismissed" });
    }

    const cpscAssets = assets.filter((a) => !a.vehicle).map(toRecallAsset);
    if (cpscAssets.length > 0) {
      const got = await cpsc(today);
      if (!got.ok) r.errors.push(describe("cpsc", got.error));
      else {
        r.recallsChecked += got.value.length;
        const byNumber = new Map(got.value.map((x) => [x.recallNumber, x]));
        const assetById = new Map(assets.map((a) => [a.id, a]));
        const matches = matchCpscRecalls(cpscAssets, got.value, {
          suppressed: (assetId, num) => suppressed.has(`cpsc|${num}|${assetId}`),
        });
        for (const m of matches) {
          const recall = byNumber.get(m.recallNumber)!;
          const asset = assetById.get(m.assetId)!;
          const hazard = clip(recall.hazards[0], 300);
          const remedy = clip(recall.remedies[0], 300);
          await putIfAbsent(
            repo,
            hh,
            {
              id: recallAlertId("cpsc", m.recallNumber, m.assetId),
              source: "recall",
              severity: m.confidence,
              status: "pending",
              label: `${asset.name} recall`,
              detail: `${m.confidence === "possible" ? "Possible match. " : ""}Hazard: ${hazard} Remedy: ${remedy}`,
              refId: m.recallNumber,
              assetId: m.assetId,
            },
            r,
          );
        }
      }
    }

    for (const asset of assets) {
      const v = asset.vehicle;
      if (!v) continue;
      let { nhtsaMake: make, nhtsaModel: model } = v;
      if (!make || !model) {
        if (!canonical.has(`${v.make}|${v.model}|${v.modelYear}`) && requests.nhtsa >= maxNhtsa) {
          requests.nhtsaCapReached = true;
          r.errors.push({
            source: "nhtsa",
            kind: "request_cap",
            message: "NHTSA request cap reached, vehicle not checked",
            assetId: asset.id,
          });
          continue;
        }
        const c = await memo(canonical, `${v.make}|${v.model}|${v.modelYear}`, () =>
          nhtsa.canonicalize({ make: v.make, model: v.model, year: v.modelYear }),
        );
        if (!c.ok) {
          r.errors.push(describe("nhtsa", c.error, asset.id));
          continue;
        }
        if (!c.value) {
          // Never query with the spoken spelling: "CRV" returns Count 0 and would read as a clear (G-011).
          r.errors.push({
            source: "nhtsa",
            kind: "no_canonical_vehicle",
            message: "no single NHTSA spelling found for this vehicle",
            assetId: asset.id,
          });
          continue;
        }
        ({ nhtsaMake: make, nhtsaModel: model } = c.value);
        // The only place these two fields are set.
        await repo.putAsset(hh, { ...asset, vehicle: { ...v, nhtsaMake: make, nhtsaModel: model } });
      }
      const key = `${make}|${model}|${v.modelYear}`;
      if (!byVehicle.has(key) && requests.nhtsa >= maxNhtsa) {
        requests.nhtsaCapReached = true;
        r.errors.push({
          source: "nhtsa",
          kind: "request_cap",
          message: "NHTSA request cap reached, vehicle not checked",
          assetId: asset.id,
        });
        continue;
      }
      const got = await memo(byVehicle, key, () => nhtsa.recalls({ make: make!, model: model!, year: v.modelYear }));
      if (!got.ok) {
        r.errors.push(describe("nhtsa", got.error, asset.id));
        continue;
      }
      r.recallsChecked += got.value.length;
      const forMatch: RecallAsset = {
        ...toRecallAsset(asset),
        vehicle: { nhtsaMake: make, nhtsaModel: model, modelYear: v.modelYear },
      };
      for (const recall of got.value) {
        if (!matchNhtsaRecall(forMatch, recall) || suppressed.has(`nhtsa|${recall.recallId}|${asset.id}`)) continue;
        await putIfAbsent(
          repo,
          hh,
          {
            id: recallAlertId("nhtsa", recall.recallId, asset.id),
            source: "recall",
            severity: "high",
            status: "pending",
            label: `${asset.name} recall`,
            detail: nhtsaSpeech(recall, asset.name.toLowerCase()),
            refId: recall.recallId,
            assetId: asset.id,
          },
          r,
        );
      }
    }
    return r;
  }

  return { run, requests };
}

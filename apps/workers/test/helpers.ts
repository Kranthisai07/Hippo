import { createMemoryRepository } from "core/src/repository";
import type { Agreement, Asset, Repository } from "core/src/contracts";
import type { FieldStatus } from "obligation-kit";
import type { HttpResponse } from "obligation-kit/src/recalls/clients";
import { seedDemoHousehold, DEMO_HOUSEHOLD } from "../src/daily/demo";
import { recordedFetch } from "../src/daily/recorded";
import { runDaily } from "../src/daily/runDaily";
import type { DailyConfig, DailyDeps, Email, EmailSender, RunReport } from "../src/daily/types";

export const ANCHOR = "2026-10-21";
export const NOW = Date.parse(`${ANCHOR}T12:00:00.000Z`);
export const A = DEMO_HOUSEHOLD;
export const B = "hh_other";

export const res = (body: unknown, status = 200): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

type Handler = (url: URL) => HttpResponse | Promise<HttpResponse>;

/** Recorded answers by default; any of the three endpoints can be replaced. Every URL asked for is kept. */
export function fakeNet(over: { cpsc?: Handler; models?: Handler; recalls?: Handler } = {}) {
  const calls: string[] = [];
  const base = recordedFetch();
  const fetch = async (url: string): Promise<HttpResponse> => {
    calls.push(url);
    const u = new URL(url);
    const h =
      u.hostname === "www.saferproducts.gov"
        ? over.cpsc
        : u.pathname.endsWith("/models")
          ? over.models
          : u.pathname.endsWith("/recallsByVehicle")
            ? over.recalls
            : undefined;
    return h ? h(u) : base(url);
  };
  return {
    fetch,
    calls,
    cpsc: () => calls.filter((c) => c.includes("saferproducts")),
    nhtsa: () => calls.filter((c) => c.includes("api.nhtsa.gov")),
  };
}

export function fakeSender(opts: { fail?: boolean } = {}) {
  const sent: Email[] = [];
  const state = { fail: opts.fail ?? false };
  const sender: EmailSender = {
    send: async (e) => {
      if (state.fail) throw new Error("smtp secret detail 4111111111111111");
      sent.push(e);
    },
  };
  return { sender, sent, state };
}

export interface World {
  repo: Repository;
  net: ReturnType<typeof fakeNet>;
  mail: ReturnType<typeof fakeSender>;
  sleeps: number[];
  clock: { t: number };
  ids: string[];
  deps: (over?: Partial<DailyDeps>) => DailyDeps;
  run: (today?: string, over?: Partial<DailyDeps>) => Promise<RunReport>;
}

/** An empty memory repository. `demo` seeds hh_demo (the same household as the CLI). */
export async function makeWorld(
  opts: { demo?: boolean; net?: Parameters<typeof fakeNet>[0]; config?: DailyConfig } = {},
): Promise<World> {
  const repo = createMemoryRepository();
  if (opts.demo !== false) await seedDemoHousehold(repo, ANCHOR);
  const net = fakeNet(opts.net);
  const mail = fakeSender();
  const sleeps: number[] = [];
  const clock = { t: NOW };
  const w: World = {
    repo,
    net,
    mail,
    sleeps,
    clock,
    ids: opts.demo === false ? [] : [A],
    deps: (over = {}) => ({
      repository: repo,
      listHouseholdIds: async () => w.ids,
      fetch: net.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      sender: mail.sender,
      now: () => clock.t,
      appUrl: "https://app.hippo.test",
      config: opts.config,
      ...over,
    }),
    run: (today = ANCHOR, over = {}) => runDaily(w.deps(over), today),
  };
  return w;
}

export const addHousehold = async (w: World, id: string, over: { email?: string | null; digestOn?: boolean } = {}) => {
  await w.repo.putHousehold(id, {
    id,
    digestOn: over.digestOn ?? true,
    createdAt: `${ANCHOR}T00:00:00.000Z`,
    ...(over.email === null ? {} : { email: over.email ?? `${id}@example.com` }),
  });
  w.ids.push(id);
};

export async function addWarranty(
  repo: Repository,
  hh: string,
  id: string,
  endDate: string,
  status: FieldStatus = "confirmed",
  extra: Partial<Agreement> = {},
): Promise<void> {
  await repo.putAgreement(hh, {
    id,
    kind: "warranty",
    title: id,
    assetIds: [],
    fields: { endDate },
    fieldStatus: { endDate: status },
    sourceRefs: {},
    createdAt: `${ANCHOR}T00:00:00.000Z`,
    ...extra,
  });
}

export const addAsset = (repo: Repository, hh: string, a: Partial<Asset> & { id: string; name: string }) =>
  repo.putAsset(hh, { createdAt: `${ANCHOR}T00:00:00.000Z`, ...a } as Asset);

export const alertOf = (repo: Repository, hh: string, id: string) => repo.getAlert(hh, id);
export const days = (n: number, from = ANCHOR) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

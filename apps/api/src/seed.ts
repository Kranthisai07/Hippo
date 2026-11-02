import { readFileSync } from "node:fs";
import type { Agreement, Alert, Asset, Doc, Repository } from "core/src/contracts";
import { chunkPages, buildIndex, serializeIndex, type Chunk } from "core/src/retrieval";
import { pageTextKey } from "core/src/repository/shared";
import { ExtractionSchemas, leavesToAgreementFields, type AgreementKind } from "obligation-kit";
import { PARTY_FIELD, syncObligations } from "./obligations";

// Seeds one demo household from the fixtures (fixtures/README.md). The seed stands in for "the person already confirmed
// every extracted date in the web app", so every field is `confirmed`. It never calls anything but the repository.

const FIXTURES = new URL("../../../fixtures/", import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

export const DEMO_HOUSEHOLD = "hh_demo";

interface ExpectedFile {
  docType: AgreementKind;
  pages: number;
  fields: Record<string, unknown>;
}
interface PagesFile {
  pages: string[];
}
interface AssetFixture extends Record<string, unknown> {
  id: string;
  name: string;
  linkedDoc?: string | null;
}

/** The five documents with an agreement. The phone photo of the warranty is the same page 3 as the PDF, so it is left out. */
const DOCS = [
  "warranty_dishwasher",
  "insurance_auto",
  "lease",
  "subscription_fernwood",
  "subscription_kestrel",
] as const;

export interface SeedOptions {
  /** ISO date the deadlines are computed against. */
  today: string;
  householdId?: string;
  /** Receives the serialized clause index of the household. */
  indexSource?: { put(householdId: string, serialized: string): void };
  /** Receives the page text of each document, so the web app can show a clause (the key is core pageTextKey). */
  pageStore?: { put(key: string, bytes: Uint8Array): Promise<void> };
}

export interface SeedResult {
  householdId: string;
  docIds: string[];
  agreementIds: string[];
  assetIds: string[];
  chunkCount: number;
}

const clipText = (s: unknown, n: number): string =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "";

function recallAlerts(): Alert[] {
  const cpsc = read<Record<string, unknown>[]>("recalls/cpsc/recall_26530_boon_nursh_bottles.json")[0] ?? {};
  const hazard = clipText((cpsc.Hazards as { Name?: string }[] | undefined)?.[0]?.Name, 300);
  const remedy = clipText((cpsc.Remedies as { Name?: string }[] | undefined)?.[0]?.Name, 300);
  const nhtsa = read<{ results: Record<string, unknown>[] }>(
    "recalls/nhtsa/recallsByVehicle_HONDA_CR-V_2021.json",
  ).results.find((c) => c.NHTSACampaignNumber === "26V332000");
  const component = clipText(nhtsa?.Component, 120).toLowerCase();
  const nhtsaRemedy = clipText(String(nhtsa?.Remedy ?? "").split(/(?<=\.)\s/)[0], 200);
  return [
    {
      id: "alert-recall-26530",
      source: "recall",
      severity: "high",
      status: "pending",
      label: "Boon NURSH baby bottles recall",
      detail: `Hazard: ${hazard} Remedy: ${remedy}`,
      refId: "26530",
      assetId: "A-baby-bottles",
    },
    {
      id: "alert-recall-26V332000",
      source: "recall",
      severity: "high",
      status: "pending",
      label: "Honda CR-V recall",
      detail: `May affect your car. Hazard: ${component}. Remedy: ${nhtsaRemedy}`,
      refId: "26V332000",
      assetId: "A-car",
    },
  ];
}

export async function seedHousehold(repo: Repository, opts: SeedOptions): Promise<SeedResult> {
  const hh = opts.householdId ?? DEMO_HOUSEHOLD;
  const today = opts.today;
  const createdAt = `${today}T00:00:00.000Z`;

  await repo.putHousehold(hh, { id: hh, digestOn: true, createdAt });

  const fixtureAssets = read<AssetFixture[]>("expected/assets.json");
  const linkedDocs = new Map<string, string[]>();
  const assets: Asset[] = fixtureAssets.map((raw) => {
    const { linkedDoc, _fixtureNotes, ...rest } = raw as AssetFixture & { _fixtureNotes?: unknown };
    void _fixtureNotes;
    if (linkedDoc) linkedDocs.set(linkedDoc, [...(linkedDocs.get(linkedDoc) ?? []), raw.id]);
    return { ...(rest as unknown as Asset), createdAt };
  });
  for (const a of assets) await repo.putAsset(hh, a);

  const chunks: Chunk[] = [];
  const docIds: string[] = [];
  const agreements: Agreement[] = [];
  for (const key of DOCS) {
    const expected = read<ExpectedFile>(`expected/${key}.json`);
    const kind = expected.docType;
    const parsed = ExtractionSchemas[kind].parse(expected.fields) as Record<string, unknown>;
    const flat = leavesToAgreementFields(kind, parsed);
    const assetIds = linkedDocs.get(key) ?? [];
    const docId = `doc-${key}`;
    const doc: Doc = {
      id: docId,
      s3Key: `demo/${hh}/${key}.pdf`,
      filename: `${key}.pdf`,
      docType: kind,
      status: "active",
      pages: expected.pages,
      uploadedAt: createdAt,
      assetIds,
    };
    await repo.putDoc(hh, doc);

    const party = flat.fields[PARTY_FIELD[kind]];
    const agreement: Agreement = {
      id: `agr-${key}`,
      kind,
      ...(typeof party === "string" ? { party } : {}),
      title: typeof flat.fields.plan === "string" ? flat.fields.plan : kind,
      assetIds,
      docId,
      fields: flat.fields,
      // The person confirmed every date in review, so everything is confirmed here.
      fieldStatus: Object.fromEntries(Object.keys(flat.fields).map((k) => [k, "confirmed" as const])),
      sourceRefs: flat.sourceRefs,
      createdAt,
    };
    await repo.putAgreement(hh, agreement);
    agreements.push(agreement);

    const pages = read<PagesFile>(`expected/pages/${key}.json`).pages.map((text, i) => ({ page: i + 1, text }));
    await opts.pageStore?.put(
      pageTextKey(hh, docId),
      new TextEncoder().encode(JSON.stringify({ pages: pages.map((p) => p.text) })),
    );
    const docChunks = chunkPages(docId, pages);
    chunks.push(...docChunks);
    await repo.putChunkMeta(hh, {
      docId,
      s3Key: `derived/${hh}/${docId}/chunks.json`,
      indexVersion: 1,
      chunkCount: docChunks.length,
    });
    docIds.push(docId);
  }

  for (const agreement of agreements) await syncObligations(repo, hh, agreement, assets, today);
  for (const alert of recallAlerts()) await repo.putAlert(hh, alert);

  opts.indexSource?.put(hh, serializeIndex(buildIndex(chunks)));
  return {
    householdId: hh,
    docIds,
    agreementIds: agreements.map((a) => a.id),
    assetIds: assets.map((a) => a.id),
    chunkCount: chunks.length,
  };
}

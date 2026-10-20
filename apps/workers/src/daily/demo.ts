import { readFileSync } from "node:fs";
import type { Agreement, Asset, Repository } from "core/src/contracts";
import { ExtractionSchemas, leavesToAgreementFields, type AgreementKind } from "obligation-kit";

// The minimal slice of apps/api/src/seed.ts that the daily job needs: the household, its assets and its agreements.
// No documents, pages or clause index. Not exported from the package entry, it is for the CLI and the tests.
const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

export const DEMO_HOUSEHOLD = "hh_demo";
export const DEMO_EMAIL = "demo@example.com";

const DOCS = [
  "warranty_dishwasher",
  "insurance_auto",
  "lease",
  "subscription_fernwood",
  "subscription_kestrel",
] as const;
const PARTY_FIELD: Record<AgreementKind, string> = {
  warranty: "provider",
  insurance: "insurer",
  lease: "landlord",
  subscription: "vendor",
  service_plan: "provider",
};

interface ExpectedFile {
  docType: AgreementKind;
  fields: Record<string, unknown>;
}

export async function seedDemoHousehold(repo: Repository, today: string, householdId = DEMO_HOUSEHOLD): Promise<void> {
  const createdAt = `${today}T00:00:00.000Z`;
  await repo.putHousehold(householdId, { id: householdId, email: DEMO_EMAIL, digestOn: true, createdAt });

  const linked = new Map<string, string[]>();
  for (const raw of read<(Record<string, unknown> & { id: string; linkedDoc?: string | null })[]>(
    "expected/assets.json",
  )) {
    const { linkedDoc, _fixtureNotes, ...rest } = raw;
    void _fixtureNotes;
    if (linkedDoc) linked.set(linkedDoc, [...(linked.get(linkedDoc) ?? []), raw.id]);
    const asset = { ...rest, createdAt } as unknown as Asset;
    // Left out on purpose so the job has to canonicalize the vehicle itself (the one place these two fields are set).
    if (asset.vehicle)
      asset.vehicle = { make: asset.vehicle.make, model: asset.vehicle.model, modelYear: asset.vehicle.modelYear };
    await repo.putAsset(householdId, asset);
  }

  for (const key of DOCS) {
    const expected = read<ExpectedFile>(`expected/${key}.json`);
    const kind = expected.docType;
    const flat = leavesToAgreementFields(
      kind,
      ExtractionSchemas[kind].parse(expected.fields) as Record<string, unknown>,
    );
    const party = flat.fields[PARTY_FIELD[kind]];
    const agreement: Agreement = {
      id: `agr-${key}`,
      kind,
      ...(typeof party === "string" ? { party } : {}),
      title: typeof flat.fields.plan === "string" ? flat.fields.plan : kind,
      assetIds: linked.get(key) ?? [],
      docId: `doc-${key}`,
      fields: flat.fields,
      // The seed stands in for "the person confirmed every date in review".
      fieldStatus: Object.fromEntries(Object.keys(flat.fields).map((k) => [k, "confirmed" as const])),
      sourceRefs: flat.sourceRefs,
      createdAt,
    };
    await repo.putAgreement(householdId, agreement);
  }
}

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { ExtractionSchemas, leavesToAgreementFields, type AgreementKind } from "obligation-kit";
import { saveIngested, type FixtureIngestDeps, type OnUploaded } from "./fixtureIngest";

// Demo only: reads the hand written extractions in fixtures/. It uses node:fs, so a Workers build must not import it.

const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Expected {
  docType: AgreementKind;
  pages: number;
  fields: Record<string, unknown>;
}

/** SHA-256 of every fixture document to its file stem, read once on first use. */
let fixtureHashes: Map<string, string> | undefined;
function knownFixtures(): Map<string, string> {
  fixtureHashes ??= new Map(
    readdirSync(new URL("docs/", FIXTURES))
      .filter((f) => /\.(pdf|jpg)$/.test(f))
      .map((f) => [sha256(readFileSync(new URL(`docs/${f}`, FIXTURES))), f.replace(/\.[^.]+$/, "")]),
  );
  return fixtureHashes;
}
const readJsonFile = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

export const NOT_A_DEMO_DOC = "This build can only read the demo documents until the real reader is connected.";

/**
 * Stand-in for the ingest worker (T2.2) so the web app can be built today: a file that is byte for byte one of
 * fixtures/docs gets its hand written extraction (fields `extracted`, never confirmed) and page text; anything else fails.
 */
export function createFixtureIngest(deps: FixtureIngestDeps): OnUploaded {
  const { repo, objectStore } = deps;
  return async ({ householdId: hh, docId }) => {
    const doc = await repo.getDoc(hh, docId);
    if (!doc) return;
    const bytes = await objectStore.get(doc.s3Key);
    const stem = bytes ? knownFixtures().get(sha256(bytes)) : undefined;
    if (!stem) {
      await repo.putDoc(hh, { ...doc, status: "failed", failureReason: NOT_A_DEMO_DOC });
      return;
    }
    const expected = readJsonFile<Expected>(`expected/${stem}.json`);
    const kind = expected.docType;
    const parsed = ExtractionSchemas[kind].parse(expected.fields) as Record<string, unknown>;
    const flat = leavesToAgreementFields(kind, parsed);
    const pages = readJsonFile<{ pages: string[] }>(`expected/pages/${stem}.json`).pages;
    await saveIngested(deps, { householdId: hh, doc, kind, flat, pages, agreementId: `agr-${deps.newId()}` });
  };
}

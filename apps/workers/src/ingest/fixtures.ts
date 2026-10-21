// FIXTURE MODE stand-ins for OCR and for the model. They read the demo files under fixtures/ and exist so the pipeline
// runs end to end at zero cost with no AWS call (the AWS credits are gone). They are NOT a reader: the OCR knows one
// photo by the SHA-256 of its bytes, and the extractor knows six documents by their page text. Anything else is
// refused or called `other`. Real reading is the Textract and Bedrock adapters, behind explicit flags.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ocr } from "core/src/pages";
import type { AgreementKind } from "obligation-kit";
import { IngestFailure, type Extractor, type ExtractorPage, type Kind } from "./types";

const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

export const DEMO_STEMS = [
  "lease",
  "warranty_dishwasher",
  "insurance_auto",
  "subscription_kestrel",
  "subscription_fernwood",
  "warranty_dishwasher_photo",
] as const;

export const NO_FIXTURE_OCR = "This build can only read the demo photo until the real reader is connected.";

/** STAND-IN OCR: the known text of the demo photo, found by a hash of the image bytes. Any other image is refused. */
export function createFixtureOcr(): Ocr {
  const photo = new Uint8Array(readFileSync(new URL("docs/warranty_dishwasher_photo.jpg", FIXTURES)));
  const hash = createHash("sha256").update(photo).digest("hex");
  const text = readJson<{ pages: string[] }>("expected/pages/warranty_dishwasher_photo.json").pages;
  return async ({ number, image }) => {
    if (!image || createHash("sha256").update(image).digest("hex") !== hash) throw new IngestFailure(NO_FIXTURE_OCR);
    return text[number - 1] ?? "";
  };
}

/** Lowercase letters and digits only, so spacing, line breaks and punctuation do not matter. */
export const fold = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

interface Known {
  /** Folded text of each page as recorded in fixtures/expected/pages (without running headers and footers). */
  folded: string[];
  docType: AgreementKind;
  fields: unknown;
}

/**
 * STAND-IN MODEL: picks the hand written extraction whose page text is the extracted page text (folded), and
 * returns its fields. The choice comes from the text that was read from the file, never from a file hash.
 */
export function createFixtureExtractor(): Extractor {
  const known: Known[] = DEMO_STEMS.map((stem) => {
    const e = readJson<{ docType: AgreementKind; fields: unknown }>(`expected/${stem}.json`);
    return { folded: readJson<{ pages: string[] }>(`expected/pages/${stem}.json`).pages.map(fold), ...e };
  });
  // The PDFs print a running header or footer on each page that the recorded page text leaves out, so a document
  // matches when it has the same page count and every page contains the recorded page text.
  const find = (pages: ExtractorPage[]) => {
    const folded = pages.map((p) => fold(p.text));
    return known.find((k) => k.folded.length === folded.length && k.folded.every((t, i) => folded[i]!.includes(t)));
  };
  return {
    classify: async (pages): Promise<Kind> => find(pages)?.docType ?? "other",
    extract: async (_kind, pages) => {
      const hit = find(pages);
      if (!hit)
        throw new IngestFailure("This build can only read the demo documents until the real reader is connected.");
      return structuredClone(hit.fields);
    },
  };
}

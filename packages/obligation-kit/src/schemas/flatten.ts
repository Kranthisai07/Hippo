import type { AgreementKind, FieldStatus } from "../deadlines";
import type { SourceRef } from "../sourceRefs";

/** One cited field is a ref, a list of cited statements is a list of refs, a group like `contact` is a ref per part. */
export type SourceRefTree = SourceRef | SourceRef[] | { [part: string]: SourceRef };

export interface AgreementFields {
  /** Plain values named as in SPEC section 4: what the deadline engine and the asset linker read. */
  fields: Record<string, unknown>;
  /** Everything starts `extracted`. Only a person (web review) or a voice add makes it `confirmed`. */
  fieldStatus: Record<string, FieldStatus>;
  /** Where in the document each value came from, for the review screen and for citations. */
  sourceRefs: Record<string, SourceRefTree>;
}

const isLeaf = (v: unknown): v is { value: unknown; sourceRef: SourceRef } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "value" in v && "sourceRef" in v;

/**
 * Turns a parsed extraction (every value wrapped as `{value, sourceRef}`) into the flat shape the engine reads.
 * Null and missing fields are dropped: "the document does not say" carries nothing forward. Input must already have
 * passed its zod schema; this only reshapes it.
 */
export function leavesToAgreementFields(_kind: AgreementKind, extraction: Record<string, unknown>): AgreementFields {
  const out: AgreementFields = { fields: {}, fieldStatus: {}, sourceRefs: {} };
  for (const [key, v] of Object.entries(extraction)) {
    if (v === null || v === undefined) continue;
    if (isLeaf(v)) {
      out.fields[key] = v.value;
      out.sourceRefs[key] = v.sourceRef;
    } else if (Array.isArray(v)) {
      const items = v.filter(isLeaf);
      if (items.length === 0) continue;
      out.fields[key] = items.map((i) => i.value);
      out.sourceRefs[key] = items.map((i) => i.sourceRef);
    } else if (typeof v === "object") {
      const values: Record<string, unknown> = {};
      const refs: Record<string, SourceRef> = {};
      for (const [part, p] of Object.entries(v)) {
        if (isLeaf(p)) {
          values[part] = p.value;
          refs[part] = p.sourceRef;
        }
      }
      if (Object.keys(values).length === 0) continue;
      out.fields[key] = values;
      out.sourceRefs[key] = refs;
    } else continue;
    out.fieldStatus[key] = "extracted";
  }
  return out;
}

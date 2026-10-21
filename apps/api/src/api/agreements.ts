import type { Agreement, Doc } from "core/src/contracts";
import {
  computeObligations,
  ExtractionSchemas,
  IsoDate,
  type AgreementKind,
  type FieldStatus,
  type SourceRefTree,
} from "obligation-kit";
import type { z } from "zod";
import { maskNumbers } from "../mcp/speak";

export interface FieldView {
  name: string;
  value: unknown;
  status: FieldStatus;
  sourceRef: SourceRefTree | null;
  isDate: boolean;
}

export interface AgreementView {
  id: string;
  kind: AgreementKind;
  fields: FieldView[];
}

export type DocView = Omit<Doc, "s3Key">;
/** The storage key holds the household id and is of no use to the browser. */
export const docView = ({ s3Key: _s3Key, ...rest }: Doc): DocView => rest;

type Def = { type: string; innerType?: Def; element?: Def; shape?: Record<string, Def> };
type Schema = { def: Def; shape?: Record<string, Schema> };

/** The `{ value, sourceRef }` object of a top level field, seen through nullish. Null for groups and lists. */
function leafOf(kind: AgreementKind, name: string): { shape: { value: z.ZodType } } | null {
  const shape = ExtractionSchemas[kind].shape as unknown as Record<string, Schema>;
  if (!Object.hasOwn(shape, name)) return null;
  let s = shape[name] as unknown as { def: { type: string; innerType?: unknown } };
  while (s.def.type === "optional" || s.def.type === "nullable") s = s.def.innerType as typeof s;
  const obj = s as unknown as { def: { type: string }; shape?: Record<string, unknown> };
  if (obj.def.type !== "object" || !obj.shape || !("value" in obj.shape) || !("sourceRef" in obj.shape)) return null;
  return obj as unknown as { shape: { value: z.ZodType } };
}

/** Names the schema knows for this kind, in the order the extraction schema lists them (the display order). */
export const schemaFieldNames = (kind: AgreementKind): string[] => Object.keys(ExtractionSchemas[kind].shape);

/** The value schema of a simple field, or null when the name is unknown or is a group or list (not editable as one). */
export const valueSchemaOf = (kind: AgreementKind, name: string): z.ZodType | null =>
  leafOf(kind, name)?.shape.value ?? null;

export const isKnownField = (kind: AgreementKind, name: string): boolean =>
  Object.hasOwn(ExtractionSchemas[kind].shape, name);

/**
 * Fields "Confirm all dates" covers: the date typed ones, plus whatever else a deadline is computed from (for a lease the
 * days of notice), found by running the engine with everything confirmed so there is no list to keep in step.
 */
export function dateFieldNames(agreement: Agreement): Set<string> {
  const names = new Set<string>();
  for (const name of schemaFieldNames(agreement.kind)) {
    if (valueSchemaOf(agreement.kind, name) === (IsoDate as unknown)) names.add(name);
  }
  const confirmed = Object.fromEntries(Object.keys(agreement.fields).map((k) => [k, "confirmed" as const]));
  for (const o of computeObligations(
    { kind: agreement.kind, fields: agreement.fields, fieldStatus: confirmed },
    "2000-01-01",
  )) {
    for (const f of o.sourceFields) names.add(f);
  }
  return names;
}

/**
 * Masks every string inside a value or a source quote tree, so the browser never gets a full policy or account number
 * (hard rule, WEB_API.md). Only what is returned changes: the stored agreement keeps the real quote for verification.
 */
function maskDeep<T>(v: T): T {
  if (typeof v === "string") return maskNumbers(v) as T;
  if (Array.isArray(v)) return v.map(maskDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) as T;
  return v;
}

export function agreementView(agreement: Agreement): AgreementView {
  const dates = dateFieldNames(agreement);
  const known = schemaFieldNames(agreement.kind).filter((n) => Object.hasOwn(agreement.fields, n));
  const extra = Object.keys(agreement.fields).filter((n) => !known.includes(n));
  return {
    id: agreement.id,
    kind: agreement.kind,
    fields: [...known, ...extra].map((name) => ({
      name,
      value: maskDeep(agreement.fields[name]),
      // Anything not listed counts as unconfirmed (core contract).
      status: agreement.fieldStatus[name] ?? "extracted",
      sourceRef: Object.hasOwn(agreement.sourceRefs, name) ? maskDeep(agreement.sourceRefs[name] ?? null) : null,
      isDate: dates.has(name),
    })),
  };
}

export const isReviewed = (s: FieldStatus | undefined): boolean => s === "confirmed" || s === "edited";

export const allReviewed = (a: Agreement): boolean => Object.keys(a.fields).every((k) => isReviewed(a.fieldStatus[k]));

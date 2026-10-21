import type { Alert, Asset, ObligationRecord, ServiceEvent } from "core/src/contracts";
import { maskNumbers } from "../mcp/speak";

// Free text that came from a document or a person (labels, names, file names) is masked like every other answer: a
// run of 5 or more digits becomes "ending" plus its last 4 (CLAUDE.md hard rule). Only text fields are touched: ids,
// reference strings and dates contain digits on purpose and must stay exactly as stored.

export const maskAlert = (a: Alert): Alert => ({
  ...a,
  label: maskNumbers(a.label),
  ...(a.detail !== undefined ? { detail: maskNumbers(a.detail) } : {}),
});

export const maskObligation = <T extends ObligationRecord>(o: T): T => ({ ...o, label: maskNumbers(o.label) });

export const maskAsset = (a: Asset): Asset => ({
  ...a,
  name: maskNumbers(a.name),
  ...(a.aliases ? { aliases: a.aliases.map((x) => maskNumbers(x)) } : {}),
  ...(a.brand ? { brand: maskNumbers(a.brand) } : {}),
  ...(a.modelNumber ? { modelNumber: maskNumbers(a.modelNumber) } : {}),
  ...(a.location ? { location: maskNumbers(a.location) } : {}),
});

export const maskEvent = (e: ServiceEvent): ServiceEvent => ({
  ...e,
  action: maskNumbers(e.action),
  ...(e.note !== undefined ? { note: maskNumbers(e.note) } : {}),
});

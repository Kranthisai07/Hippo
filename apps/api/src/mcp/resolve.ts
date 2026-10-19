import type { Agreement, Asset, ToolResult } from "core/src/contracts";
import { resolveAgreement, resolveAsset } from "core/src/resolver";
import type { ToolContext } from "./context";
import { ok, orList } from "./result";
import { speak } from "./speak";

export type Resolved<T> = { found: T } | { reply: ToolResult };

const said = (phrase: string): string => speak(phrase.slice(0, 60)).replace(/[.]+$/, "");

/** Asks which one, with at most 3 options. The ids are in the structure so a follow up can name one. */
export function ask(what: "asset" | "agreement", options: { id: string; label: string }[]): ToolResult {
  const opts = options.slice(0, 3);
  const q = `Which one do you mean, ${orList(opts.map((o) => `the ${o.label}`))}?`;
  return ok(q, { kind: "ambiguous", what, question: speak(q), options: opts });
}

export function notFound(what: "asset" | "agreement", phrase: string): ToolResult {
  const noun = what === "asset" ? "item" : "agreement";
  const text =
    what === "asset"
      ? `I could not find ${said(phrase)} among your things. Try just the name, like dishwasher.`
      : `I could not find a ${noun} for ${said(phrase)}. Try something like car insurance or my lease.`;
  return ok(text, { kind: "not_found", what, query: phrase.slice(0, 200) });
}

/** Never guesses: one sure match, a short question, or a plain "not found". */
export async function findAsset(ctx: ToolContext, phrase: string): Promise<Resolved<Asset>> {
  const assets = await ctx.repo.listAssets(ctx.householdId);
  const r = resolveAsset(phrase, assets);
  if (r.status === "match") return { found: r.item as Asset };
  if (r.status === "ambiguous") {
    return {
      reply: ask(
        "asset",
        r.candidates.map((c) => ({ id: c.id, label: c.name })),
      ),
    };
  }
  return { reply: notFound("asset", phrase) };
}

const agreementLabel = (a: Agreement): string =>
  `${a.party ?? a.title ?? a.kind} ${a.kind === "service_plan" ? "service plan" : a.kind}`;

export async function findAgreement(ctx: ToolContext, phrase: string): Promise<Resolved<Agreement>> {
  const [agreements, assets] = await Promise.all([
    ctx.repo.listAgreements(ctx.householdId),
    ctx.repo.listAssets(ctx.householdId),
  ]);
  const r = resolveAgreement(phrase, agreements, assets);
  if (r.status === "match") return { found: r.item as Agreement };
  if (r.status === "ambiguous") {
    return {
      reply: ask(
        "agreement",
        (r.candidates as Agreement[]).map((c) => ({ id: c.id, label: agreementLabel(c) })),
      ),
    };
  }
  return { reply: notFound("agreement", phrase) };
}

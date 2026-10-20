import type { Agreement, CoverageResult, Doc, QuotedClause } from "core/src/contracts";
import { CheckCoverageInput } from "core/src/contracts";
import { searchIndex, type Chunk, type Hit } from "core/src/retrieval";
import { claimByDate, computeObligations } from "obligation-kit";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import {
  docNameOf,
  exclusionApplies,
  exclusionLead,
  lowerGeneric,
  num,
  pageOf,
  quote,
  speakDate,
  str,
  strList,
} from "../format";
import { findAsset } from "../resolve";
import { ok, okFit } from "../result";
import { maskNumbers } from "../speak";

export const description =
  "Checks whether a broken or damaged item is covered: finds the warranty or insurance linked to it, checks it is still in term, and returns the coverage clause, any exclusion, the claim steps and the claim-by date, each with document and page. " +
  "Use it when something is broken, leaking or damaged. Do not use it for general document questions (use ask_documents) or for upcoming dates (use whats_coming_up). " +
  'Examples: "my dishwasher is leaking, am I covered", "the car got dented". ' +
  "Pass only the thing as asset (for example dishwasher), not the whole sentence, and the problem as issue (for example leaking).";

type Args = z.infer<typeof CheckCoverageInput>;

export const DISCLAIMER = "This is what your document says, not a claim decision.";

const isExclusion = (c: Chunk): boolean =>
  /\b(?:not\s+cover(?:ed)?|does\s+not\s+cover|exclu(?:de|des|ded|sion|sions)|limitations?)\b/i.test(
    `${c.heading ?? ""} ${c.text}`,
  );
const isCoverage = (c: Chunk): boolean =>
  !isExclusion(c) &&
  /\b(?:cover(?:ed|s|age|ages)?|repair\s+or\s+replace|will\s+pay|reimburse)\b/i.test(`${c.heading ?? ""} ${c.text}`);

interface Term {
  startDate: string | null;
  endDate: string | null;
  inTerm: boolean | null;
  confirmed: boolean;
}

function termOf(a: Agreement, today: string): Term {
  const startDate = str(a.fields, a.kind === "insurance" ? "effectiveDate" : "startDate");
  const end = computeObligations({ kind: a.kind, fields: a.fields, fieldStatus: a.fieldStatus }, today).find(
    (o) => o.type === "expires" || o.type === "renews",
  );
  const endDate = end?.dueDate ?? null;
  const inTerm = endDate === null ? null : today <= endDate && (startDate === null || today >= startDate);
  return { startDate, endDate, inTerm, confirmed: end?.confirmed ?? false };
}

const KIND_ORDER = { warranty: 0, insurance: 1 } as const;

function pickAgreement(candidates: { a: Agreement; t: Term }[]): { a: Agreement; t: Term } {
  // An agreement that is in term wins, then a warranty over a policy, then the order the repository gives.
  const sorted = candidates
    .map((c, i) => ({ c, i }))
    .sort(
      (x, y) =>
        Number(y.c.t.inTerm === true) - Number(x.c.t.inTerm === true) ||
        KIND_ORDER[x.c.a.kind as "warranty" | "insurance"] - KIND_ORDER[y.c.a.kind as "warranty" | "insurance"] ||
        x.i - y.i,
    );
  return sorted[0]!.c;
}

const best = (hits: Hit[], pred: (c: Chunk) => boolean): Chunk | null => hits.find((h) => pred(h.chunk))?.chunk ?? null;

const RECEIPT = /receipt|invoice|proof\s+of\s+purchase/i;

export const checkCoverage: ToolHandler<Args> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const found = await findAsset(ctx, args.asset);
  if ("reply" in found) return found.reply;
  const asset = found.found;

  const linked = (await repo.listAgreements(hh, { assetId: asset.id })).filter(
    (a) => a.kind === "warranty" || a.kind === "insurance",
  );
  if (linked.length === 0) {
    return ok(`I do not have a warranty or insurance linked to your ${asset.name}. You can upload one in the app.`, {
      kind: "not_found",
      what: "agreement",
      query: asset.name,
    });
  }
  const { a: agreement, t: term } = pickAgreement(linked.map((a) => ({ a, t: termOf(a, today) })));
  const doc: Doc | null = agreement.docId ? await repo.getDoc(hh, agreement.docId) : null;
  const docName = agreement.docId ? docNameOf(doc) : null;
  const noun = agreement.kind === "warranty" ? "warranty" : "insurance";
  const name = lowerGeneric(asset.name).split(/\s+/).slice(0, 4).join(" ");

  // Claim window and the claim-by date. The incident is taken to be today (Q-007 part 2): claimByDate is called here
  // at check time, and severityFor is not, because a claim-by date is an answer, not a stored obligation or alert.
  const windowDays = num(agreement.fields, agreement.kind === "warranty" ? "claimWindowDays" : "claimReportWindowDays");
  const active = term.inTerm !== false;
  const claimBy = active && windowDays !== null ? claimByDate(today, windowDays) : null;
  const claimSteps = active
    ? strList(agreement.fields, "claimSteps")
        .slice(0, 4)
        .map((text, i) => ({ text: maskNumbers(text).slice(0, 500), page: pageOf(agreement, "claimSteps", i) }))
    : [];

  const missingProof: string[] = [];
  if (agreement.kind === "warranty" && agreement.fields.requiresProofOfPurchase === true) {
    const docs = await repo.listDocs(hh);
    const hasReceipt = docs.some(
      (d) => d.assetIds.includes(asset.id) && d.docType === "other" && RECEIPT.test(d.filename),
    );
    if (!hasReceipt) missingProof.push("Dated sales receipt (proof of purchase). No receipt has been uploaded.");
  }

  // Clauses: only searched inside this agreement's own document, and only when the agreement is in term.
  let topClause: QuotedClause | null = null;
  let exclusionClause: QuotedClause | null = null;
  let top: Chunk | null = null;
  let exclusion: Chunk | null = null;
  if (term.inTerm === true && term.confirmed && agreement.docId) {
    const index = await ctx.indexes.get(repo, hh);
    if (index) {
      const docIds = [agreement.docId];
      const relevant = searchIndex(index, args.issue, { docIds, limit: 6 });
      if (relevant.length > 0) {
        exclusion = best(relevant, (c) => isExclusion(c) && exclusionApplies(c, args.issue));
        top = best(relevant, isCoverage);
        if (!top) top = best(searchIndex(index, `covered ${args.issue}`, { docIds, limit: 6 }), isCoverage);
        if (top) topClause = quote(top, docName ?? "document");
        if (exclusion) exclusionClause = quote(exclusion, docName ?? "document");
      }
    }
  }

  const badge: CoverageResult["badge"] =
    term.inTerm === false ? "not_covered" : term.inTerm === true && term.confirmed && topClause ? "covered" : "unclear";

  const provider = str(agreement.fields, agreement.kind === "warranty" ? "provider" : "insurer");
  const structured: CoverageResult = {
    kind: "coverage",
    badge,
    asset: { id: asset.id, name: asset.name },
    issue: args.issue,
    agreement: {
      id: agreement.id,
      kind: agreement.kind as "warranty" | "insurance",
      provider,
      docId: agreement.docId ?? null,
      docName,
    },
    term: {
      startDate: term.startDate,
      endDate: term.endDate,
      asOf: today,
      inTerm: term.inTerm,
      datesConfirmed: term.confirmed,
    },
    topClause,
    exclusionClause,
    claimSteps,
    claimWindowDays: windowDays,
    claimByDate: claimBy,
    missingProof,
    disclaimer: DISCLAIMER,
  };

  const end = term.endDate;
  if (badge === "not_covered") {
    const when =
      end && end < today
        ? `ended on ${speakDate(end, today)}`
        : `starts on ${speakDate(term.startDate ?? today, today)}`;
    return okFit(`Your ${name} ${noun} ${when}, so it does not cover this.`, [DISCLAIMER], structured);
  }
  if (term.inTerm === null) {
    return okFit(`I found your ${name} ${noun}, but I cannot tell if it is still active.`, [DISCLAIMER], structured);
  }
  if (!term.confirmed) {
    return okFit(
      `I found your ${name} ${noun}, but its dates are not confirmed yet. Please confirm them in the app.`,
      [DISCLAIMER],
      structured,
    );
  }
  if (badge === "unclear") {
    const lead = exclusion ? exclusionLead(exclusion, args.issue) : null;
    if (exclusion && lead) {
      return okFit(
        `Your ${name} ${noun} runs to ${speakDate(end!, today)}, but page ${exclusion.page} excludes ${lead}, so I cannot say it is covered.`,
        [DISCLAIMER],
        structured,
      );
    }
    return okFit(
      `I found your ${name} ${noun}, which runs to ${speakDate(end!, today)}, but nothing relevant to that problem was found in it.`,
      [DISCLAIMER],
      structured,
    );
  }

  const lead = exclusion ? exclusionLead(exclusion, args.issue) : null;
  const first = `Yes, your ${name} ${noun} runs to ${speakDate(end!, today)}${exclusion ? (lead ? `, but page ${exclusion.page} excludes ${lead}` : `, but page ${exclusion.page} has an exclusion that may apply`) : ""}.`;
  const report =
    claimBy && windowDays !== null ? `Report within ${windowDays} days, by ${speakDate(claimBy, today)}` : "";
  const receipt = missingProof.length > 0 ? (report ? "and upload your receipt" : "Upload your receipt") : "";
  const steps = [report, receipt].filter(Boolean).join(", ");
  const disclaimer = DISCLAIMER.charAt(0).toLowerCase() + DISCLAIMER.slice(1);
  return okFit(first, steps ? [`${steps}; ${disclaimer}`, DISCLAIMER] : [DISCLAIMER], structured);
};

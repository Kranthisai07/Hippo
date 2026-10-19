import type { Agreement, Asset } from "core/src/contracts";
import { GetAgreementInput } from "core/src/contracts";
import { computeObligations } from "obligation-kit";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { docNameOf, num, pageOf, speakDate, speakRange, str } from "../format";
import { findAgreement } from "../resolve";
import { ok } from "../result";
import { maskNumbers } from "../speak";

export const description =
  "Reads the key terms of one agreement: a warranty, insurance policy, lease or subscription, with dates, amounts, notice period and who to contact. Numbers are masked to the last 4. " +
  "Use it when the person asks about one agreement in general. Do not use it for a specific clause question (use ask_documents) or for a broken item (use check_coverage). " +
  'Examples: "tell me about my car insurance", "when does my lease end", "how much is Kestrel". ' +
  "Pass only the agreement (for example car insurance), not the whole sentence.";

type Args = z.infer<typeof GetAgreementInput>;
type Kind = "money" | "date" | "days" | "text" | "last4";
interface Row {
  key: string;
  label: string;
  kind: Kind;
}

const ROWS: Record<Agreement["kind"], Row[]> = {
  warranty: [
    { key: "provider", label: "Provider", kind: "text" },
    { key: "startDate", label: "Starts", kind: "date" },
    { key: "termMonths", label: "Term in months", kind: "text" },
    { key: "endDate", label: "Ends", kind: "date" },
    { key: "claimWindowDays", label: "Claim window", kind: "days" },
    { key: "requiresProofOfPurchase", label: "Proof of purchase required", kind: "text" },
  ],
  insurance: [
    { key: "insurer", label: "Insurer", kind: "text" },
    { key: "policyType", label: "Policy type", kind: "text" },
    { key: "policyNumberLast4", label: "Policy number", kind: "last4" },
    { key: "effectiveDate", label: "Starts", kind: "date" },
    { key: "expirationDate", label: "Ends", kind: "date" },
    { key: "renewal", label: "Renewal", kind: "text" },
    { key: "premium", label: "Premium", kind: "money" },
    { key: "deductibles", label: "Deductibles", kind: "text" },
    { key: "claimReportWindowDays", label: "Claim report window", kind: "days" },
  ],
  lease: [
    { key: "landlord", label: "Landlord", kind: "text" },
    { key: "startDate", label: "Starts", kind: "date" },
    { key: "endDate", label: "Ends", kind: "date" },
    { key: "rentAmount", label: "Rent", kind: "money" },
    { key: "rentDueDay", label: "Rent due on day", kind: "text" },
    { key: "noticeDaysToVacate", label: "Notice to vacate", kind: "days" },
    { key: "securityDeposit", label: "Security deposit", kind: "money" },
    { key: "lateFeeRule", label: "Late fee", kind: "text" },
    { key: "earlyTerminationTerms", label: "Early termination", kind: "text" },
  ],
  subscription: [
    { key: "vendor", label: "Vendor", kind: "text" },
    { key: "plan", label: "Plan", kind: "text" },
    { key: "amount", label: "Price", kind: "money" },
    { key: "cycle", label: "Billing", kind: "text" },
    { key: "nextChargeDate", label: "Next charge", kind: "date" },
    { key: "trialEndDate", label: "Trial ends", kind: "date" },
    { key: "cancelNoticeDays", label: "Cancel notice", kind: "days" },
    { key: "cancelMethod", label: "How to cancel", kind: "text" },
  ],
  service_plan: [
    { key: "provider", label: "Provider", kind: "text" },
    { key: "intervalDays", label: "Service every", kind: "days" },
    { key: "nextServiceDate", label: "Next service", kind: "date" },
  ],
};

const flat = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join("; ");
  if (typeof v === "object")
    return Object.values(v as Record<string, unknown>)
      .map(flat)
      .filter(Boolean)
      .join(" ");
  return String(v);
};

function show(v: unknown, kind: Kind, today: string): string {
  if (kind === "date" && typeof v === "string") return speakDate(v, today);
  if (kind === "days") return `${flat(v)} days`;
  if (kind === "last4") return `ending ${flat(v)}`;
  if (kind === "money") {
    if (v !== null && typeof v === "object") {
      const o = v as { amount?: unknown; cycle?: unknown };
      return `$${flat(o.amount)}${o.cycle ? ` ${flat(o.cycle)}` : ""}`;
    }
    return `$${flat(v)}`;
  }
  return flat(v);
}

export const getAgreement: ToolHandler<Args> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const found = await findAgreement(ctx, args.about);
  if ("reply" in found) return found.reply;
  const a = found.found;
  const doc = a.docId ? await repo.getDoc(hh, a.docId) : null;

  const terms = ROWS[a.kind].flatMap((row) => {
    const v = a.fields[row.key];
    if (v === null || v === undefined || flat(v) === "") return [];
    const value = maskNumbers(show(v, row.kind, today)).slice(0, 500);
    return [{ label: row.label, value, page: pageOf(a, row.key) }];
  });
  const confirmed =
    Object.keys(a.fields).length > 0 &&
    Object.keys(a.fields).every((k) => a.fieldStatus[k] === "confirmed" || a.fieldStatus[k] === "edited");

  const structured = {
    kind: "agreement",
    agreement: {
      id: a.id,
      kind: a.kind,
      party: a.party ?? null,
      title: a.title ?? null,
      docId: a.docId ?? null,
      docName: a.docId ? docNameOf(doc) : null,
      assetIds: a.assetIds,
    },
    terms,
    datesConfirmed: confirmed,
    quotedFromDocument: a.docId !== undefined,
  };

  const assets = await repo.listAssets(hh);
  return ok(summary(a, assets, today), structured);
};

function summary(a: Agreement, assets: Asset[], today: string): string[] {
  const f = a.fields;
  const asset = assets.find((x) => a.assetIds.includes(x.id));
  const range = (start: string | null, end: string | null) =>
    start && end ? `runs ${speakRange(start, end, today)}` : end ? `ends ${speakDate(end, today)}` : "";
  const end = (k: "endDate" | "expirationDate") =>
    str(f, k) ??
    computeObligations({ kind: a.kind, fields: f, fieldStatus: a.fieldStatus }, today).find((o) => o.type === "expires")
      ?.dueDate ??
    null;

  switch (a.kind) {
    case "warranty": {
      const win = num(f, "claimWindowDays");
      return [
        `Your ${asset ? asset.name.toLowerCase() + " " : ""}warranty from ${str(f, "provider") ?? "the maker"} ${range(str(f, "startDate"), end("endDate")) || "has no dates on file"}.`,
        win !== null ? `Claims must be reported within ${win} days.` : "",
      ];
    }
    case "insurance": {
      const last4 = str(f, "policyNumberLast4");
      const auto = f.renewal === "auto" ? " and renews automatically" : "";
      return [
        `Your ${asset ? asset.name.toLowerCase() + " " : ""}insurance with ${str(f, "insurer") ?? "your insurer"}${last4 ? `, policy ending ${last4},` : ""} ${range(str(f, "effectiveDate"), end("expirationDate")) || "has no dates on file"}${auto}.`,
      ];
    }
    case "lease": {
      const notice = num(f, "noticeDaysToVacate");
      return [
        `Your lease with ${str(f, "landlord") ?? "your landlord"} ${range(str(f, "startDate"), end("endDate")) || "has no dates on file"}.`,
        notice !== null ? `You must give ${notice} days notice to leave.` : "",
      ];
    }
    case "subscription": {
      const amount = num(f, "amount");
      const next = str(f, "nextChargeDate");
      const notice = num(f, "cancelNoticeDays");
      return [
        `${str(f, "vendor") ?? a.party ?? "That subscription"} costs ${amount !== null ? `$${amount}` : "an unknown amount"} ${str(f, "cycle") ?? ""}${next ? `, with the next charge on ${speakDate(next, today)}` : ""}.`,
        notice !== null ? `Cancel at least ${notice} days before.` : "",
      ];
    }
    case "service_plan":
      return [`Your service plan from ${str(f, "provider") ?? "your provider"} is on file.`];
  }
}

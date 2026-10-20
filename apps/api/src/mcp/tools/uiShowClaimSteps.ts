import { UiShowClaimStepsInput } from "core/src/contracts";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { docNameOf, num, pageOf, str, strList } from "../format";
import { fail, ok } from "../result";
import { maskNumbers } from "../speak";

export const description =
  "Card button: shows the claim steps and contact of one agreement. Called by the card, not by the model.";

export const uiShowClaimSteps: ToolHandler<z.infer<typeof UiShowClaimStepsInput>> = async (ctx, args) => {
  const { householdId: hh, repo } = ctx;
  const a = await repo.getAgreement(hh, args.agreement_id);
  if (!a)
    return { ...fail("I could not find that agreement."), structuredContent: { kind: "not_found", what: "agreement" } };
  const doc = a.docId ? await repo.getDoc(hh, a.docId) : null;
  const contact = (a.fields.contact ?? {}) as Record<string, unknown>;
  const steps = strList(a.fields, "claimSteps")
    .slice(0, 4)
    .map((text, i) => ({ text: maskNumbers(text).slice(0, 500), page: pageOf(a, "claimSteps", i) }));
  return ok(steps.length > 0 ? `Here are the ${steps.length} claim steps.` : "That document lists no claim steps.", {
    kind: "claim_steps",
    agreementId: a.id,
    docName: a.docId ? docNameOf(doc) : null,
    steps,
    claimWindowDays: num(a.fields, "claimWindowDays") ?? num(a.fields, "claimReportWindowDays"),
    contact: { phone: str(contact, "phone"), email: str(contact, "email"), url: str(contact, "url") },
    quotedFromDocument: true,
  });
};

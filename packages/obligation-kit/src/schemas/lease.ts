import { z } from "zod";
import { ContactSchema, IsoDate, count, field, leaf, money, text, textLeaves } from "./common";

export const NoticeDaysType = z.enum(["calendar", "business"]);

export const LeaseSchema = z.strictObject({
  landlord: field(leaf(text)),
  address: field(leaf(text)),
  startDate: field(leaf(IsoDate)),
  endDate: field(leaf(IsoDate)),
  rentAmount: field(leaf(money)),
  rentDueDay: field(leaf(z.number().int().min(1).max(31))),
  lateFeeRule: field(leaf(text)),
  noticeDaysToVacate: field(leaf(count)),
  /** Whether the clause counts business days (US federal holidays excluded) or calendar days. Absent means calendar. */
  noticeDaysType: field(leaf(NoticeDaysType)),
  renewalTerms: field(leaf(text)),
  earlyTerminationTerms: field(leaf(text)),
  securityDeposit: field(leaf(money)),
  maintenanceResponsibilities: textLeaves,
  contact: field(ContactSchema),
});

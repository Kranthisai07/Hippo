// Two synthetic few-shot examples per document kind (SPEC section 7 step 3). Invented people, companies and numbers
// only, never a real person's document. A test checks that every example passes its own schema and that every quote
// is really on its page, so a broken example cannot teach the model to cite text that is not there.
import { ExtractionSchemas, type AgreementKind } from "obligation-kit";

export interface Example {
  pages: string[];
  fields: Record<string, unknown>;
}

const L = (value: unknown, quote: string, page = 1) => ({ value, sourceRef: { page, quote } });

/** Every key of the kind's schema, null unless the example gives it: this is what "missing is null" looks like. */
export function withNulls(kind: AgreementKind, partial: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(ExtractionSchemas[kind].shape);
  return Object.fromEntries(keys.map((k) => [k, partial[k] ?? null]));
}

const raw: Record<AgreementKind, { pages: string[]; fields: Record<string, unknown> }[]> = {
  warranty: [
    {
      pages: [
        "Zephyr Appliance Limited Warranty\nCovers the Aerolux Refrigerator model AR-200, serial number ending 4471.\nThe warranty starts March 3, 2025 and lasts 24 months, ending March 3, 2027.\nKeep your receipt as proof of purchase. Call 1-800-555-0100 to make a claim.",
      ],
      fields: {
        provider: L("Zephyr Appliance", "Zephyr Appliance Limited Warranty"),
        assetHint: {
          brand: L("Aerolux", "Covers the Aerolux Refrigerator model AR-200"),
          model: L("AR-200", "Covers the Aerolux Refrigerator model AR-200"),
          serial: L("4471", "serial number ending 4471"),
        },
        startDate: L("2025-03-03", "The warranty starts March 3, 2025"),
        termMonths: L(24, "lasts 24 months"),
        endDate: L("2027-03-03", "ending March 3, 2027"),
        requiresProofOfPurchase: L(true, "Keep your receipt as proof of purchase."),
        contact: { phone: L("1-800-555-0100", "Call 1-800-555-0100 to make a claim.") },
      },
    },
    {
      pages: [
        "Terra Tools Two Year Guarantee\nThis guarantee does not cover blades worn by normal use.\nTo claim, report the fault within 30 days of finding it.\nWritten for the Terra T9 Trimmer.",
      ],
      fields: {
        provider: L("Terra Tools", "Terra Tools Two Year Guarantee"),
        assetHint: { model: L("Terra T9 Trimmer", "Written for the Terra T9 Trimmer.") },
        exclusions: [L("Blades worn by normal use", "does not cover blades worn by normal use")],
        claimWindowDays: L(30, "report the fault within 30 days of finding it"),
      },
    },
  ],
  insurance: [
    {
      pages: [
        "Lakeside Mutual Auto Policy\nPolicy number ending 9921.\nPolicy period: June 1, 2026 to June 1, 2027. Renews automatically.\nCovered vehicle: 2020 Orchid Sedan.\nCollision deductible: $500.",
      ],
      fields: {
        insurer: L("Lakeside Mutual", "Lakeside Mutual Auto Policy"),
        policyType: L("auto", "Lakeside Mutual Auto Policy"),
        policyNumberLast4: L("9921", "Policy number ending 9921"),
        effectiveDate: L("2026-06-01", "Policy period: June 1, 2026"),
        expirationDate: L("2027-06-01", "to June 1, 2027"),
        renewal: L("auto", "Renews automatically."),
        deductibles: [L({ coverage: "Collision", amount: 500 }, "Collision deductible: $500.")],
        coveredAssetHints: [L({ make: "Orchid", model: "Sedan", year: 2020 }, "Covered vehicle: 2020 Orchid Sedan.")],
      },
    },
    {
      pages: [
        "Harbor Renters Insurance\nRenters policy. Premium: $14.50 per month.\nReport any loss within 60 days.\nNot covered: flood damage.",
      ],
      fields: {
        insurer: L("Harbor Renters Insurance", "Harbor Renters Insurance"),
        policyType: L("renters", "Renters policy."),
        premium: { amount: L(14.5, "Premium: $14.50 per month."), cycle: L("monthly", "Premium: $14.50 per month.") },
        claimReportWindowDays: L(60, "Report any loss within 60 days."),
        exclusions: [L("Flood damage", "Not covered: flood damage.")],
      },
    },
  ],
  lease: [
    {
      pages: [
        "Willow Row Lease\nLandlord: Willow Row Holdings LLC\nPremises: 88 Willow Row, Apt 2, Rivertown\nLease term: February 1, 2026 through January 31, 2027.\nRent is $1,200.00, due on the 1st day of each month.",
        "Tenant may end the lease by giving 60 calendar days written notice.\nSecurity deposit: $1,200.00.",
      ],
      fields: {
        landlord: L("Willow Row Holdings LLC", "Landlord: Willow Row Holdings LLC"),
        address: L("88 Willow Row, Apt 2, Rivertown", "Premises: 88 Willow Row, Apt 2, Rivertown"),
        startDate: L("2026-02-01", "Lease term: February 1, 2026"),
        endDate: L("2027-01-31", "through January 31, 2027."),
        rentAmount: L(1200, "Rent is $1,200.00"),
        rentDueDay: L(1, "due on the 1st day of each month"),
        noticeDaysToVacate: L(60, "giving 60 calendar days written notice", 2),
        noticeDaysType: L("calendar", "giving 60 calendar days written notice", 2),
        securityDeposit: L(1200, "Security deposit: $1,200.00.", 2),
      },
    },
    {
      pages: [
        "Month to month rental, Pine Street Flats.\nLandlord: R. Quill.\nIf rent is late by 3 days, a fee of $40 applies.",
      ],
      fields: {
        landlord: L("R. Quill", "Landlord: R. Quill."),
        lateFeeRule: L(
          "A fee of $40 applies if rent is late by 3 days",
          "If rent is late by 3 days, a fee of $40 applies.",
        ),
      },
    },
  ],
  subscription: [
    {
      pages: [
        "Streamly Plus receipt\nPlan: Streamly Plus Annual\nAmount: $59.99 billed annually.\nNext charge date: 2027-01-15.\nCancel by email at least 7 days before the charge.",
      ],
      fields: {
        vendor: L("Streamly", "Streamly Plus receipt"),
        plan: L("Streamly Plus Annual", "Plan: Streamly Plus Annual"),
        amount: L(59.99, "Amount: $59.99 billed annually."),
        cycle: L("annual", "Amount: $59.99 billed annually."),
        nextChargeDate: L("2027-01-15", "Next charge date: 2027-01-15."),
        cancelNoticeDays: L(7, "at least 7 days before the charge"),
        cancelMethod: L("Email", "Cancel by email"),
      },
    },
    {
      pages: ["Gardenbox free trial\nYour free trial ends on November 9, 2026. After that, $12.00 per month."],
      fields: {
        vendor: L("Gardenbox", "Gardenbox free trial"),
        trialEndDate: L("2026-11-09", "Your free trial ends on November 9, 2026."),
        amount: L(12, "After that, $12.00 per month."),
        cycle: L("monthly", "After that, $12.00 per month."),
      },
    },
  ],
  service_plan: [
    {
      pages: [
        "CoolAir HVAC Service Plan\nCovers the Breezo furnace model BF-90.\nA tune-up visit every 180 days.\nNext visit: April 12, 2027.\nIncluded: filter change, safety check.",
      ],
      fields: {
        provider: L("CoolAir HVAC", "CoolAir HVAC Service Plan"),
        assetHint: {
          brand: L("Breezo", "Covers the Breezo furnace model BF-90."),
          model: L("BF-90", "Covers the Breezo furnace model BF-90."),
        },
        intervalDays: L(180, "A tune-up visit every 180 days."),
        nextServiceDate: L("2027-04-12", "Next visit: April 12, 2027."),
        included: [L("Filter change", "Included: filter change"), L("Safety check", "safety check")],
      },
    },
    {
      pages: ["Poolside Care Plan. We service your pool every 90 days."],
      fields: {
        provider: L("Poolside Care", "Poolside Care Plan."),
        intervalDays: L(90, "every 90 days"),
      },
    },
  ],
};

export const EXAMPLES: Record<AgreementKind, Example[]> = Object.fromEntries(
  (Object.keys(raw) as AgreementKind[]).map((k) => [
    k,
    raw[k].map((e) => ({ pages: e.pages, fields: withNulls(k, e.fields) })),
  ]),
) as Record<AgreementKind, Example[]>;

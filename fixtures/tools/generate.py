"""Builds fixtures/docs/* and fixtures/expected/*.json. Run: python fixtures/tools/generate.py

Needs: reportlab, pypdf, pillow. Anchor date for all demo deadlines: 2026-10-21.
Fails loudly if any expected sourceRef quote is not found on its cited page.
"""
import json
import random
import re
import sys
from pathlib import Path

from pypdf import PdfReader
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[1]
DOCS, EXP = ROOT / "docs", ROOT / "expected"
DOCS.mkdir(exist_ok=True)
EXP.mkdir(exist_ok=True)

# ---- page text. (style, text); styles: h1 h2 p li ----
WARRANTY = [
    [("h1", "Northwind Appliances"), ("h2", "Limited Warranty Certificate"),
     ("p", "Product: Northwind Quietline Dishwasher"),
     ("p", "Model number: NW-DW500"),
     ("p", "Serial number: ending 7731"),
     ("p", "Date of purchase: November 12, 2025"),
     ("p", "Warranty period: twelve (12) months from the date of purchase."),
     ("p", "Warranty provider: Northwind Appliances, Inc. (the Warrantor)"),
     ("p", "Thank you for choosing Northwind. This certificate describes what the Warrantor will repair or "
           "replace, what is not covered, and how to make a claim. Please keep it with your sales receipt.")],
    [("h2", "Section 1. What is covered"),
     ("p", "During the warranty period, the Warrantor will repair or replace, at its option, any part that fails "
           "because of a defect in materials or workmanship under normal household use. Covered parts include "
           "the circulation pump, the drain motor, the main control board, the door latch, and the door seals."),
     ("p", "Labor for covered repairs is included when performed by a Northwind authorized technician."),
     ("h2", "Section 2. Proof of purchase"),
     ("p", "A dated sales receipt is required for all warranty service. Without proof of the purchase date, "
           "the Warrantor may decline the claim.")],
    [("h2", "Section 3. What is not covered"),
     ("p", "This warranty does not cover damage caused by improper installation, including water damage "
           "resulting from improperly connected supply or drain lines."),
     ("p", "This warranty also does not cover cosmetic damage, damage from commercial use, or damage from "
           "repairs made by anyone other than a Northwind authorized technician."),
     ("h2", "Section 4. How to make a claim"),
     ("p", "You must report a defect within thirty (30) days of discovering it."),
     ("li", "1. Stop using the dishwasher and shut off the water supply."),
     ("li", "2. Find your sales receipt, model number, and serial number."),
     ("li", "3. Call Northwind Warranty Service at 1-800-555-0142 or email warranty@northwind-appliances.example."),
     ("li", "4. A technician visit is scheduled within five (5) business days."),
     ("p", "Online: www.northwind-appliances.example/warranty")],
]

INSURANCE = [
    [("h1", "Harbor Mutual Insurance Company"), ("h2", "Personal Auto Policy: Declarations Page"),
     ("p", "Policy number: HM-AU-0048-4821"),
     ("p", "Named insured: Alex Sample, 1200 Maple Court Way, Unit 4B, Springfield"),
     ("p", "Policy period: April 30, 2026 to October 30, 2026"),
     ("p", "Renewal: This policy renews automatically for another six-month term unless you or Harbor Mutual "
           "cancels it before the expiration date."),
     ("p", "Insured vehicle: 2021 Honda CR-V EX"),
     ("p", "Total premium for this period: $684.00, billed every six months."),
     ("h2", "Coverages and limits"),
     ("li", "Bodily injury liability: $100,000 per person / $300,000 per accident"),
     ("li", "Property damage liability: $100,000 per accident"),
     ("li", "Collision: $500 deductible"),
     ("li", "Comprehensive: $250 deductible"),
     ("li", "Uninsured motorist: $100,000 per person / $300,000 per accident")],
    [("h2", "Exclusions"),
     ("p", "This policy does not cover loss while the vehicle is used to carry people or property for a fee, "
           "including delivery or rideshare driving."),
     ("p", "This policy does not cover intentional damage caused by an insured person."),
     ("h2", "Reporting a claim"),
     ("p", "Report any accident or loss to Harbor Mutual within fourteen (14) days of the date it occurs."),
     ("p", "Call the 24-hour claims line at 1-800-555-0177 or email claims@harbor-mutual.example."),
     ("p", "Do not admit fault or agree to a settlement before speaking with a claims representative.")],
]

LEASE = [
    [("h1", "Maple Court Apartments"), ("h2", "Residential Lease Agreement"),
     ("p", "Landlord: Maple Court Apartments LLC"),
     ("p", "Tenant: Alex Sample"),
     ("p", "Premises: 1200 Maple Court Way, Unit 4B, Springfield"),
     ("p", "Lease term: January 1, 2026 through December 31, 2026 (12 months)."),
     ("p", "Monthly rent: $1,850.00, due on the 1st day of each month."),
     ("p", "Late fee: If rent is not received by the 5th day of the month, Tenant will pay a late fee of $75.00."),
     ("p", "Landlord contact: Maple Court Management Office, 1-800-555-0119, office@maple-court.example")],
    [("h2", "Section 2. Security deposit"),
     ("p", "Tenant has paid a security deposit of $1,850.00. The deposit will be returned within thirty (30) "
           "days after Tenant vacates, less lawful deductions for unpaid rent or damage beyond normal wear."),
     ("h2", "Section 3. Utilities"),
     ("p", "Tenant pays electricity and internet. Landlord pays water, sewer, and trash.")],
    [("h2", "Section 4. Maintenance"),
     ("p", "Landlord is responsible for the plumbing, heating, and cooling systems, the roof, and the exterior "
           "of the building."),
     ("p", "Tenant is responsible for replacing light bulbs and smoke detector batteries and keeping the unit clean."),
     ("p", "Tenant must report any leak or maintenance problem to the management office within 48 hours.")],
    [("h2", "Section 5. End of term and notice to vacate"),
     ("p", "Tenant must give Landlord written notice of intent to vacate at least sixty (60) days before the "
           "end of the lease term."),
     ("p", "If Tenant does not give this notice, the lease renews on a month-to-month basis at a monthly rent "
           "of $1,950.00."),
     ("h2", "Section 6. Early termination"),
     ("p", "Tenant may end this lease before the end of the term by giving sixty (60) days written notice and "
           "paying an early termination fee equal to two (2) months' rent.")],
]

FERNWOOD = [[
    ("h1", "Fernwood Streaming"), ("h2", "Membership Confirmation"),
    ("p", "Plan: Standard"),
    ("p", "Price: $15.99 per month"),
    ("p", "Billing cycle: monthly"),
    ("p", "Next charge date: November 3, 2026"),
    ("p", "Account email: a***@example.com"),
    ("p", "Cancel at least 1 day before your next charge date to avoid being billed for the next month."),
    ("p", "How to cancel: Account > Membership > Cancel membership."),
]]

KESTREL = [[
    ("h1", "Kestrel Learning"), ("h2", "Free Trial Confirmation"),
    ("p", "Plan: Premium"),
    ("p", "Your 14-day free trial started on October 14, 2026 and ends on October 28, 2026."),
    ("p", "Price after trial: $9.99 per month, billed monthly."),
    ("p", "First charge date: October 28, 2026"),
    ("p", "To avoid being charged, cancel at least 2 days before the trial ends."),
    ("p", "How to cancel: email cancel@kestrel-learning.example or use Settings > Billing > End trial."),
    ("p", "Account email: j***@example.com"),
]]

STY = {
    "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=20, leading=26, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13, leading=18, spaceBefore=12, spaceAfter=6),
    "p": ParagraphStyle("p", fontName="Helvetica", fontSize=11, leading=16, spaceAfter=8),
    "li": ParagraphStyle("li", fontName="Helvetica", fontSize=11, leading=16, spaceAfter=4, leftIndent=18),
}
esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_pdf(name, title, pages):
    def footer(c, d):
        c.setFont("Helvetica", 9)
        c.drawString(inch, 0.6 * inch, f"{title}  |  Page {d.page} of {len(pages)}")

    doc = SimpleDocTemplate(str(DOCS / name), pagesize=letter, invariant=1, title=title,
                            leftMargin=inch, rightMargin=inch, topMargin=inch, bottomMargin=inch)
    flow = []
    for i, page in enumerate(pages):
        if i:
            flow.append(PageBreak())
        flow += [Paragraph(esc(t), STY[s]) for s, t in page]
    doc.build(flow, onFirstPage=footer, onLaterPages=footer)


def page_texts(name):
    return [p.extract_text() for p in PdfReader(str(DOCS / name)).pages]


def load_font(name, size):
    """Arial where it exists, else a common system font, else Pillow's built-in (the photo then differs from the committed one)."""
    for d in ("C:/Windows/Fonts/", "/Library/Fonts/", "/System/Library/Fonts/Supplemental/", "/usr/share/fonts/truetype/msttcorefonts/", "/usr/share/fonts/truetype/dejavu/"):
        for n in (name, "DejaVuSans-Bold.ttf" if "bd" in name else "DejaVuSans.ttf"):
            try:
                return ImageFont.truetype(d + n, size)
            except OSError:
                pass
    return ImageFont.load_default(size)


def make_photo(name, lines):
    """Phone-photo look: skew, uneven shadow, noise, slight blur, JPEG."""
    random.seed(7)
    paper = Image.new("RGB", (1100, 1450), (248, 246, 240))
    d = ImageDraw.Draw(paper)
    font, bold = load_font("arial.ttf", 30), load_font("arialbd.ttf", 34)
    y = 90
    for style, text in lines:
        f = bold if style.startswith("h") else font
        x = 80 + (30 if style == "li" else 0)
        words, row = text.split(), ""
        for w in words:
            if d.textlength(row + " " + w, font=f) > 1100 - x - 80:
                d.text((x, y), row.strip(), font=f, fill=(25, 25, 30)); y += 44; row = w
            else:
                row += " " + w
        d.text((x, y), row.strip(), font=f, fill=(25, 25, 30)); y += 44 + (14 if style != "li" else 0)
    desk = Image.new("RGB", (1500, 1900), (92, 78, 66))
    desk.paste(paper.rotate(2.6, expand=True, resample=Image.BICUBIC, fillcolor=(92, 78, 66)), (60, 110))
    # Shadow from the right and bottom: two linear gradients darken the image, then seeded noise is added.
    w, h = desk.size
    across = Image.linear_gradient("L").rotate(90).resize((w, h)).point(lambda v: int(v * 0.38))
    down = Image.linear_gradient("L").resize((w, h)).point(lambda v: int(v * 0.18))
    light = ImageChops.invert(ImageChops.add(across, down))
    desk = ImageChops.multiply(desk, Image.merge("RGB", [light] * 3))
    noise = Image.frombytes("L", (w, h), random.randbytes(w * h)).point(lambda v: v // 14)
    desk = ImageChops.add(desk, Image.merge("RGB", [noise] * 3), offset=-9)
    desk.filter(ImageFilter.GaussianBlur(0.9)).save(DOCS / name, "JPEG", quality=78)


# ---- expected extractions ----
def F(value, page, quote):
    return {"value": value, "sourceRef": {"page": page, "quote": quote}}


def warranty_fields(p, q3):
    """p = page numbers (purchase/summary, coverage, claims); q3 shared quotes live on the claims page."""
    a, b, c = p
    return {
        "provider": F("Northwind Appliances, Inc.", a, "Warranty provider: Northwind Appliances, Inc. (the Warrantor)"),
        "assetHint": {
            "brand": F("Northwind", a, "Product: Northwind Quietline Dishwasher"),
            "model": F("NW-DW500", a, "Model number: NW-DW500"),
            "serial": F("7731", a, "Serial number: ending 7731"),
        },
        "startDate": F("2025-11-12", a, "Date of purchase: November 12, 2025"),
        "termMonths": F(12, a, "twelve (12) months from the date of purchase"),
        "endDate": None,
        "coverageSummary": [
            F("Repair or replace parts that fail from defects in materials or workmanship under normal household use",
              b, "any part that fails because of a defect in materials or workmanship under normal household use"),
            F("Covered parts: circulation pump, drain motor, main control board, door latch, door seals",
              b, "Covered parts include the circulation pump, the drain motor, the main control board, the door latch, and the door seals."),
        ],
        "exclusions": [
            F("Damage caused by improper installation, including water damage from improperly connected supply or drain lines",
              c, "This warranty does not cover damage caused by improper installation, including water damage resulting from improperly connected supply or drain lines."),
            F("Cosmetic damage, commercial use, repairs by anyone other than an authorized technician",
              c, "This warranty also does not cover cosmetic damage, damage from commercial use, or damage from repairs made by anyone other than a Northwind authorized technician."),
        ],
        "claimSteps": [
            F("Stop using the dishwasher and shut off the water supply.", c, "1. Stop using the dishwasher and shut off the water supply."),
            F("Find your sales receipt, model number, and serial number.", c, "2. Find your sales receipt, model number, and serial number."),
            F("Call Northwind Warranty Service or email warranty@northwind-appliances.example.", c,
              "3. Call Northwind Warranty Service at 1-800-555-0142 or email warranty@northwind-appliances.example."),
            F("A technician visit is scheduled within five business days.", c, "4. A technician visit is scheduled within five (5) business days."),
        ],
        "claimWindowDays": F(30, c, "You must report a defect within thirty (30) days of discovering it."),
        "contact": {
            "phone": F("1-800-555-0142", c, "Call Northwind Warranty Service at 1-800-555-0142"),
            "email": F("warranty@northwind-appliances.example", c, "email warranty@northwind-appliances.example"),
            "url": F("www.northwind-appliances.example/warranty", c, "Online: www.northwind-appliances.example/warranty"),
        },
        "requiresProofOfPurchase": F(True, b, "A dated sales receipt is required for all warranty service."),
    }


def warranty_photo_fields():
    """The phone photo shows only the claims page (single image, so page 1)."""
    full = warranty_fields((1, 1, 1), None)
    keep = ["exclusions", "claimSteps", "claimWindowDays", "contact"]
    out = {k: full[k] for k in keep}
    for k in ("provider", "assetHint", "startDate", "termMonths", "endDate", "coverageSummary", "requiresProofOfPurchase"):
        out[k] = None
    return out


EXPECTED = {
    "warranty_dishwasher": ("warranty", "warranty_dishwasher.pdf", 3, warranty_fields((1, 2, 3), None)),
    "warranty_dishwasher_photo": ("warranty", "warranty_dishwasher_photo.jpg", 1, warranty_photo_fields()),
    "insurance_auto": ("insurance", "insurance_auto.pdf", 2, {
        "insurer": F("Harbor Mutual Insurance Company", 1, "Harbor Mutual Insurance Company"),
        "policyType": F("auto", 1, "Personal Auto Policy: Declarations Page"),
        "policyNumberLast4": F("4821", 1, "Policy number: HM-AU-0048-4821"),
        "effectiveDate": F("2026-04-30", 1, "Policy period: April 30, 2026 to October 30, 2026"),
        "expirationDate": F("2026-10-30", 1, "Policy period: April 30, 2026 to October 30, 2026"),
        "renewal": F("auto", 1, "Renewal: This policy renews automatically for another six-month term"),
        "premium": {"amount": F(684.0, 1, "Total premium for this period: $684.00, billed every six months."),
                    "cycle": F("six-month", 1, "Total premium for this period: $684.00, billed every six months.")},
        "deductibles": [F({"coverage": "collision", "amount": 500}, 1, "Collision: $500 deductible"),
                        F({"coverage": "comprehensive", "amount": 250}, 1, "Comprehensive: $250 deductible")],
        "coverages": [F("Bodily injury liability $100,000 per person / $300,000 per accident", 1, "Bodily injury liability: $100,000 per person / $300,000 per accident"),
                      F("Property damage liability $100,000 per accident", 1, "Property damage liability: $100,000 per accident"),
                      F("Collision", 1, "Collision: $500 deductible"),
                      F("Comprehensive", 1, "Comprehensive: $250 deductible"),
                      F("Uninsured motorist $100,000 per person / $300,000 per accident", 1, "Uninsured motorist: $100,000 per person / $300,000 per accident")],
        "exclusions": [F("Use of the vehicle to carry people or property for a fee, including delivery or rideshare driving", 2,
                         "This policy does not cover loss while the vehicle is used to carry people or property for a fee, including delivery or rideshare driving."),
                       F("Intentional damage caused by an insured person", 2, "This policy does not cover intentional damage caused by an insured person.")],
        "claimSteps": [F("Report any accident or loss to Harbor Mutual within 14 days.", 2, "Report any accident or loss to Harbor Mutual within fourteen (14) days of the date it occurs."),
                       F("Call the 24-hour claims line or email claims@harbor-mutual.example.", 2, "Call the 24-hour claims line at 1-800-555-0177 or email claims@harbor-mutual.example."),
                       F("Do not admit fault or agree to a settlement before speaking with a claims representative.", 2, "Do not admit fault or agree to a settlement before speaking with a claims representative.")],
        "claimReportWindowDays": F(14, 2, "Report any accident or loss to Harbor Mutual within fourteen (14) days of the date it occurs."),
        "contact": {"phone": F("1-800-555-0177", 2, "Call the 24-hour claims line at 1-800-555-0177"),
                    "email": F("claims@harbor-mutual.example", 2, "email claims@harbor-mutual.example"),
                    "url": None},
        "coveredAssetHints": [F({"make": "Honda", "model": "CR-V", "year": 2021}, 1, "Insured vehicle: 2021 Honda CR-V EX")],
    }),
    "lease": ("lease", "lease.pdf", 4, {
        "landlord": F("Maple Court Apartments LLC", 1, "Landlord: Maple Court Apartments LLC"),
        "address": F("1200 Maple Court Way, Unit 4B, Springfield", 1, "Premises: 1200 Maple Court Way, Unit 4B, Springfield"),
        "startDate": F("2026-01-01", 1, "Lease term: January 1, 2026 through December 31, 2026 (12 months)."),
        "endDate": F("2026-12-31", 1, "Lease term: January 1, 2026 through December 31, 2026 (12 months)."),
        "rentAmount": F(1850.0, 1, "Monthly rent: $1,850.00, due on the 1st day of each month."),
        "rentDueDay": F(1, 1, "Monthly rent: $1,850.00, due on the 1st day of each month."),
        "lateFeeRule": F("$75.00 late fee if rent is not received by the 5th day of the month", 1,
                         "Late fee: If rent is not received by the 5th day of the month, Tenant will pay a late fee of $75.00."),
        "noticeDaysToVacate": F(60, 4, "Tenant must give Landlord written notice of intent to vacate at least sixty (60) days before the end of the lease term."),
        "renewalTerms": F("Without notice, the lease renews month-to-month at $1,950.00", 4,
                          "If Tenant does not give this notice, the lease renews on a month-to-month basis at a monthly rent of $1,950.00."),
        "earlyTerminationTerms": F("60 days written notice plus a fee equal to two months' rent", 4,
                                   "Tenant may end this lease before the end of the term by giving sixty (60) days written notice and paying an early termination fee equal to two (2) months' rent."),
        "securityDeposit": F(1850.0, 2, "Tenant has paid a security deposit of $1,850.00."),
        "maintenanceResponsibilities": [
            F("Landlord: plumbing, heating, cooling, roof, building exterior", 3, "Landlord is responsible for the plumbing, heating, and cooling systems, the roof, and the exterior of the building."),
            F("Tenant: light bulbs, smoke detector batteries, keeping the unit clean", 3, "Tenant is responsible for replacing light bulbs and smoke detector batteries and keeping the unit clean."),
        ],
        "contact": {"phone": F("1-800-555-0119", 1, "Maple Court Management Office, 1-800-555-0119, office@maple-court.example"),
                    "email": F("office@maple-court.example", 1, "Maple Court Management Office, 1-800-555-0119, office@maple-court.example"),
                    "url": None},
    }),
    "subscription_fernwood": ("subscription", "subscription_fernwood.pdf", 1, {
        "vendor": F("Fernwood Streaming", 1, "Fernwood Streaming"),
        "plan": F("Standard", 1, "Plan: Standard"),
        "amount": F(15.99, 1, "Price: $15.99 per month"),
        "cycle": F("monthly", 1, "Billing cycle: monthly"),
        "nextChargeDate": F("2026-11-03", 1, "Next charge date: November 3, 2026"),
        "trialEndDate": None,
        "cancelNoticeDays": F(1, 1, "Cancel at least 1 day before your next charge date"),
        "cancelMethod": F("Account > Membership > Cancel membership", 1, "How to cancel: Account > Membership > Cancel membership."),
        "accountEmailHint": F("a***@example.com", 1, "Account email: a***@example.com"),
    }),
    "subscription_kestrel": ("subscription", "subscription_kestrel.pdf", 1, {
        "vendor": F("Kestrel Learning", 1, "Kestrel Learning"),
        "plan": F("Premium", 1, "Plan: Premium"),
        "amount": F(9.99, 1, "Price after trial: $9.99 per month, billed monthly."),
        "cycle": F("monthly", 1, "Price after trial: $9.99 per month, billed monthly."),
        "nextChargeDate": F("2026-10-28", 1, "First charge date: October 28, 2026"),
        "trialEndDate": F("2026-10-28", 1, "Your 14-day free trial started on October 14, 2026 and ends on October 28, 2026."),
        "cancelNoticeDays": F(2, 1, "To avoid being charged, cancel at least 2 days before the trial ends."),
        "cancelMethod": F("Email cancel@kestrel-learning.example or Settings > Billing > End trial", 1,
                          "How to cancel: email cancel@kestrel-learning.example or use Settings > Billing > End trial."),
        "accountEmailHint": F("j***@example.com", 1, "Account email: j***@example.com"),
    }),
}

# Deadlines the engine should derive from the confirmed fields above, anchor date 2026-10-21.
OBLIGATIONS = {
    "anchorDate": "2026-10-21",
    "note": "Expected output of the deadline engine once every source field is confirmed. Calendar days.",
    "obligations": [
        {"from": "subscription_kestrel", "type": "cancel_by", "dueDate": "2026-10-26", "daysFromAnchor": 5, "rule": "trial end 2026-10-28 minus 2 days"},
        {"from": "subscription_kestrel", "type": "trial_end", "dueDate": "2026-10-28", "daysFromAnchor": 7},
        {"from": "insurance_auto", "type": "renews", "dueDate": "2026-10-30", "daysFromAnchor": 9, "rule": "renewal is auto, so renews not expires"},
        {"from": "lease", "type": "notice_by", "dueDate": "2026-11-01", "daysFromAnchor": 11, "rule": "end 2026-12-31 minus 60 calendar days"},
        {"from": "subscription_fernwood", "type": "cancel_by", "dueDate": "2026-11-02", "daysFromAnchor": 12, "rule": "next charge 2026-11-03 minus 1 day"},
        {"from": "subscription_fernwood", "type": "charge", "dueDate": "2026-11-03", "daysFromAnchor": 13},
        {"from": "warranty_dishwasher", "type": "expires", "dueDate": "2026-11-12", "daysFromAnchor": 22, "rule": "start 2025-11-12 plus 12 months"},
        {"from": "lease", "type": "expires", "dueDate": "2026-12-31", "daysFromAnchor": 71, "note": "outside the 30 day alert window"},
    ],
    "severity": {"high": ["subscription_kestrel cancel_by (5 days)", "subscription_kestrel trial_end (7 days)", "insurance_auto renews (9 days)", "lease notice_by (11 days)", "subscription_fernwood cancel_by (12 days)"],
                 "possible": ["subscription_fernwood charge (13 days)", "warranty_dishwasher expires (22 days)"],
                 "rule": "D-015 / SPEC 5: high within 14 days for expires, renews, notice_by and cancel_by; high within 7 days for charge, service_due, trial_end and claim_by; otherwise possible within 30 days",
                 "resolved": "Q-006 part 1: the 9 day insurance renewal is high under D-015, so moment 3 can speak it."},
}

ASSETS = [
    {"id": "A-dishwasher", "name": "Dishwasher", "aliases": ["dish washer", "kitchen dishwasher"], "category": "appliance",
     "brand": "Northwind", "modelNumber": "NW-DW500", "upc": None, "serialLast4": "7731", "purchaseDate": "2025-11-12",
     "location": "kitchen", "linkedDoc": "warranty_dishwasher"},
    {"id": "A-car", "name": "Car", "aliases": ["Honda", "CR-V", "my car"], "category": "vehicle",
     "brand": "Honda", "modelNumber": None, "upc": None, "serialLast4": None, "purchaseDate": None, "location": "garage",
     "vehicle": {"make": "Honda", "model": "CR-V", "modelYear": 2021, "nhtsaMake": "HONDA", "nhtsaModel": "CR-V"},
     "linkedDoc": "insurance_auto"},
    {"id": "A-baby-bottles", "name": "Boon NURSH baby bottles", "aliases": ["baby bottles", "bottles", "Boon bottles"],
     "category": "child_safety", "brand": "Boon", "modelNumber": None, "upc": "669028116546", "serialLast4": None,
     "purchaseDate": "2026-02-14", "location": "kitchen", "linkedDoc": None,
     "_fixtureNotes": "Matches CPSC 26530 truthfully (D-016): Boon NURSH 8 oz Reusable Baby Bottles 3-Pack, pink tie dye, UPC 669028116546, sold at Walmart November 2025 to May 2026. The match is on the structured UPC. The record's Model field is empty; item number B11654 appears only in Description. The purchase date is invented but inside the sales window."},
]

RECALL_MATCHES = {
    "cpsc": [{"asset": "A-baby-bottles", "recallNumber": "26530", "file": "recalls/cpsc/recall_26530_boon_nursh_bottles.json",
              "expectedConfidence": "high",
              "why": "Deterministic evidence: the asset UPC 669028116546 equals ProductUPCs[0].UPC in the record (INTENT principle 2). The matching rule is unchanged."},
             {"asset": None, "recallNumber": "26569", "file": "recalls/cpsc/recall_26569_title_mismatch_record.json",
              "expectedConfidence": "no_match",
              "why": "Standalone negative control, no seeded asset. Real CPSC data error: Title says Joolz Aer2 car seat adapters but the record is CooCooBaby baby loungers. A matcher that trusts Title would raise a false alert. Match on Products[].Name and Description too."}],
    "nhtsa": [{"asset": "A-car", "file": "recalls/nhtsa/recallsByVehicle_HONDA_CR-V_2021.json", "expectedConfidence": "high",
               "wording": "may affect your car", "demoCampaign": "26V332000",
               "campaigns": ["26V332000", "24V064000", "23V858000", "21V900000"],
               "why": "Canonical HONDA / CR-V / 2021 match. Not VIN specific, so always say may affect. Demo campaign is 26V332000."}],
}


def norm(s):
    return re.sub(r"\s+", "", s)


def walk(node, path=""):
    if isinstance(node, dict):
        if "sourceRef" in node:
            yield path, node["sourceRef"]
        else:
            for k, v in node.items():
                yield from walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")


def main():
    build_pdf("warranty_dishwasher.pdf", "Northwind Appliances Limited Warranty", WARRANTY)
    build_pdf("insurance_auto.pdf", "Harbor Mutual Auto Declarations", INSURANCE)
    build_pdf("lease.pdf", "Maple Court Apartments Lease", LEASE)
    build_pdf("subscription_fernwood.pdf", "Fernwood Streaming Membership", FERNWOOD)
    build_pdf("subscription_kestrel.pdf", "Kestrel Learning Trial", KESTREL)
    make_photo("warranty_dishwasher_photo.jpg", WARRANTY[2])

    errors = []
    for stem, (kind, fname, pages, fields) in EXPECTED.items():
        texts = [norm(t) for t in page_texts(fname)] if fname.endswith(".pdf") else [norm(" ".join(t for _, t in WARRANTY[2]))]
        if len(texts) != pages:
            errors.append(f"{fname}: expected {pages} pages, got {len(texts)}")
        for path, ref in walk(fields):
            if len(ref["quote"]) > 200:
                errors.append(f"{fname}{path}: quote over 200 chars")
            if not (1 <= ref["page"] <= len(texts)) or norm(ref["quote"]) not in texts[ref["page"] - 1]:
                errors.append(f"{fname}{path}: quote not on page {ref['page']}: {ref['quote'][:60]}")
        doc = {"file": f"docs/{fname}", "docType": kind, "pages": pages, "fields": fields}
        if stem.endswith("_photo"):
            doc["ocrRequired"] = True
        (EXP / f"{stem}.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for name, obj in (("obligations", OBLIGATIONS), ("assets", ASSETS), ("recall_matches", RECALL_MATCHES)):
        (EXP / f"{name}.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if errors:
        print("\n".join(errors)); sys.exit(1)
    print("ok: all sourceRef quotes verified on their cited pages")


if __name__ == "__main__":
    main()

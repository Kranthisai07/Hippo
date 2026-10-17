# Fixtures

Synthetic demo documents, real recall responses, and hand-written expected extractions. Anchor date for every deadline is **2026-10-21**.

Everything is fictional (Northwind Appliances, Harbor Mutual Insurance, Maple Court Apartments, Fernwood Streaming, Kestrel Learning, "Alex Sample"). Phone numbers use the 555 range and emails use `.example`. The recalls are real.

Rebuild everything: `python fixtures/tools/generate.py` (needs reportlab, pypdf, pillow). It fails if any expected source quote is missing from its cited page, so the expected JSON cannot drift from the PDFs.

## Documents (`docs/`)

| File | Pages | What it tests |
| :--- | :--- | :--- |
| `warranty_dishwasher.pdf` | 3 | Hero moment. 12 month term from 2025-11-12 (expires 2026-11-12). Page 3 has the improper-installation water damage exclusion, the 30 day claim window, and 4 claim steps. Page 2 requires proof of purchase. `endDate` is not stated, so it must be null. |
| `insurance_auto.pdf` | 2 | Policy 2026-04-30 to 2026-10-30, auto renew (9 days after anchor). Collision $500 and comprehensive $250 deductibles. 14 day claim report window. Insured vehicle is a 2021 Honda CR-V. Policy number must mask to `4821`. |
| `lease.pdf` | 4 | 2026-01-01 to 2026-12-31. 60 day notice to vacate on page 4, so notice by 2026-11-01. Month-to-month renewal at $1,950 and early termination terms, also page 4. |
| `subscription_fernwood.pdf` | 1 | Monthly $15.99, next charge 2026-11-03, cancel 1 day before. No trial, so `trialEndDate` is null. |
| `subscription_kestrel.pdf` | 1 | 14 day trial ending 2026-10-28 (7 days out), cancel 2 days before, so cancel by 2026-10-26. Then $9.99 monthly. |
| `warranty_dishwasher_photo.jpg` | 1 | Phone photo of warranty page 3: skew, uneven shadow, noise, blur. For the OCR path. Expected JSON covers only what that page shows. |

The photo is untested against a real OCR engine (none installed when it was made). Run it through Textract in T2.1 before trusting it as an OCR fixture.

## Expected extractions (`expected/`)

Shape: `{file, docType, pages, fields}`. Field names follow SPEC section 4. Every non-null leaf is `{value, sourceRef: {page, quote}}`; arrays hold one such leaf per item. A field the document does not state is `null`. Quotes are at most 200 chars and appear verbatim on the cited page. Dates are ISO.

Judgment calls for the schema owner (T1.1): the warranty `startDate` is the purchase date, since the document gives no separate start; the insurance `premium.cycle` is the free text `six-month` because SPEC does not enumerate cycles; deductibles are `{coverage, amount}` objects.

| File | Source |
| :--- | :--- |
| `warranty_dishwasher.json`, `warranty_dishwasher_photo.json`, `insurance_auto.json`, `lease.json`, `subscription_fernwood.json`, `subscription_kestrel.json` | one per document |
| `obligations.json` | Deadlines the engine must derive once all fields are confirmed, with days from the anchor and expected severity. Severity follows D-015: the 9 day insurance renewal is `high`. |
| `assets.json` | Seed household: dishwasher, the Honda CR-V (with canonical NHTSA spellings), and the Boon NURSH baby bottles (UPC 669028116546). |
| `recall_matches.json` | Expected confidence for each recall against the seeded assets. |

## Recalls (`recalls/`)

Raw API responses, unedited except where noted.

| File | Source | Notes |
| :--- | :--- | :--- |
| `cpsc/recall_26530_boon_nursh_bottles.json` | `saferproducts.gov/RestWebServices/Recall?format=json&RecallNumber=26530` | **CPSC recall 26530**, Boon NURSH 8 oz Reusable Baby Bottles (3-Pack, pink tie dye), TOMY, 2026-06-04. Choking hazard, store credit or replacement. `ProductUPCs` lists **669028116546**, so a UPC match gives `high`. `Model` is empty; item number B11654 is only in the free text. Chosen under D-016 because no child car seat recall in the last 12 months had a UPC or model. |
| `cpsc/recall_26569_title_mismatch_record.json` | Same API, one record extracted from a wider `ProductName=baby` response | **CPSC recall 26569**. Real data defect: the `Title` says Joolz but the record is CooCooBaby baby loungers. Standalone negative control for title-only matching; no seeded asset. |
| `nhtsa/recallsByVehicle_HONDA_CR-V_2021.json` | `api.nhtsa.gov/recalls/recallsByVehicle?make=HONDA&model=CR-V&modelYear=2021` | **NHTSA campaigns** 26V332000 (the demo campaign, newest, 2026-05-21, front passenger seat weight sensor, air bags), 24V064000, 23V858000, 21V900000. Dates are `DD/MM/YYYY`. |
| `nhtsa/models_HONDA_2021_issueType-r.json` | `api.nhtsa.gov/products/vehicle/models?modelYear=2021&make=HONDA&issueType=r` | Canonical model spellings. Returns duplicate rows (CR-V twice). |
| `nhtsa/recallsByVehicle_HONDA_CRV_2021_zero_results.json` | same endpoint with `model=CRV` | Returns `Count: 0` with no error. Proves canonicalization is required. |

The demo recall is therefore a baby bottle, not a car seat. Scan behind D-016: of 594 CPSC recalls from the last 12 months, 18 carry a Model or UPC, and 26530 is the only genuine child product among them. The demo NHTSA campaign is **26V332000** (2021 Honda CR-V).

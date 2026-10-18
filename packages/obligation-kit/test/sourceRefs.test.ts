import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quoteOnPage, verifySourceRefs, type PageText } from "../src";

const leaf = (value: unknown, page: number, quote: string) => ({ value, sourceRef: { page, quote } });
const page1 = "Section 4. How to make a claim\nYou must report a defect within thirty (30) days of discovering it.\nCall 1-800-555-0142.";
const verify = (fields: unknown, pages: PageText[] = [page1]) => verifySourceRefs(fields, pages);

describe("quoteOnPage: folding", () => {
  it("finds an exact quote", () => {
    expect(quoteOnPage("report a defect within thirty (30) days", page1)).toBe(true);
  });
  it("ignores case", () => {
    expect(quoteOnPage("REPORT A DEFECT WITHIN THIRTY (30) DAYS", page1)).toBe(true);
  });
  it("ignores spacing and line breaks", () => {
    expect(quoteOnPage("report  a defect\nwithin   thirty (30)\ndays", page1)).toBe(true);
  });
  it("ignores a line wrapped across the page text", () => {
    expect(quoteOnPage("a defect within thirty (30) days", "must report a\ndefect within\nthirty (30)\ndays of")).toBe(true);
  });
  it("ignores hyphenation and punctuation", () => {
    expect(quoteOnPage("improperly connected supply", "improperly con-\nnected supply or drain")).toBe(true);
    expect(quoteOnPage("call 1-800-555-0142", page1)).toBe(true);
    expect(quoteOnPage("call 18005550142", page1)).toBe(false); // merging digit groups is a different number as written
  });
  it("ignores smart quotes and dashes", () => {
    expect(quoteOnPage("Tenant’s two months’ rent", "Tenant's two months' rent")).toBe(true);
  });
  it("folds ligatures and full width digits", () => {
    expect(quoteOnPage("the ﬁnal ３０ days", "The final 30 days")).toBe(true);
  });
  it("keeps accents, so a quote must carry the same letters the page has", () => {
    expect(quoteOnPage("Café machine warranty", "cafe machine warranty")).toBe(false); // accents are kept, not folded away
    expect(quoteOnPage("Café machine warranty", "Café machine warranty card")).toBe(true);
  });
});

describe("quoteOnPage: strict on text layer pages", () => {
  it("rejects an invented quote", () => {
    expect(quoteOnPage("the warranty is void if the unit is moved", page1)).toBe(false);
  });
  it("rejects a quote that differs by one letter", () => {
    expect(quoteOnPage("report a defect within thirty (30) dayz of discovering it", page1)).toBe(false);
  });
  it("rejects a changed digit", () => {
    expect(quoteOnPage("report a defect within thirty (60) days", page1)).toBe(false);
  });
  it("rejects a quote that is too short to prove anything", () => {
    expect(quoteOnPage("30", page1)).toBe(false);
    expect(quoteOnPage("a b", page1)).toBe(false);
    expect(quoteOnPage("", page1)).toBe(false);
    expect(quoteOnPage("!!!", page1)).toBe(false);
  });
  it("accepts the shortest allowed quote", () => {
    expect(quoteOnPage("days", page1)).toBe(true);
  });
});

describe("quoteOnPage: numbers keep their boundaries (text layer pages)", () => {
  it.each([
    ["Renew by 12/3/2024", "Renew by 1/23/2024"],
    ["$10,00 per claim", "$1,000 per claim"],
    ["Pay 1.5 dollars", "Pay 15 dollars"],
    ["Deductible: $1,000", "Deductible: $10,000 per claim"],
    ["30 days", "notice of 130 days"],
    ["30 days", "notice of 1,030 days"],
    ["30 days", "notice of 30,000 days"],
    ["¼ percent", "14 percent"],
    ["rent is 1850 due", "rent is 18 50 due"],
  ])("rejects %j on a page that says %j", (quote, text) => {
    expect(quoteOnPage(quote, text)).toBe(false);
  });
  it.each([
    ["Renew by 12/3/2024", "Renew by 12/3/2024."],
    ["$1,000 per claim", "Deductible: $1,000 per claim"],
    ["30 days", "within 30\ndays of"],
    ["30days", "within 30 days of"],
    ["1-800-555-0142", "Call 1-800-555-0142 now"],
    ["Section 4", "Section\n4. How"],
  ])("still accepts %j on a page that says %j", (quote, text) => {
    expect(quoteOnPage(quote, text)).toBe(true);
  });
  it("does not let OCR tolerance blur a number boundary", () => {
    const page = { text: "You must report a defect within thirty 1,030 days of discovering it", ocr: true };
    expect(quoteOnPage("You must report a defect within thirty 30 days of discovering it", page)).toBe(false);
  });
  it("does not forgive a number split in two on an OCR page, even when only the edges differ", () => {
    const page = { text: "You must report a defect within 3 0 days of discovering it", ocr: true };
    expect(quoteOnPage("You must report a defect within 30 days of discovering it", page)).toBe(false);
  });
  it("treats non-ASCII digits as digits on OCR pages", () => {
    const page = { text: "You must report a defect within ٣٠ days of discovering it", ocr: true };
    expect(quoteOnPage("You must report a defect within ٣١ days of discovering it", page)).toBe(false);
  });
});

describe("verifySourceRefs: only the checked claim survives, and bad input fails closed", () => {
  it("returns just value and sourceRef, so extra claims beside a good quote are dropped", () => {
    const r = verify({ a: { value: "x", sourceRef: { page: 1, quote: "How to make a claim" }, note: "FAKE claim", extra: { value: "FAKE", sourceRef: { page: 1, quote: "nope nope" } } } });
    expect(r.fields).toEqual({ a: { value: "x", sourceRef: { page: 1, quote: "How to make a claim" } } });
  });
  it("does not carry a fabricated source on a null value", () => {
    expect(verify({ a: { value: null, sourceRef: { page: 1, quote: "made up quote here" } } }).fields).toEqual({ a: { value: null } });
  });
  it("rejects every quote on a page with no text, or a missing page, instead of throwing", () => {
    const f = { a: leaf(1, 1, "How to make a claim") };
    expect(verify(f, [null as unknown as PageText]).rejected.map((e) => e.reason)).toEqual(["quote_not_found"]);
    expect(verify(f, [{} as unknown as PageText]).rejected.map((e) => e.reason)).toEqual(["quote_not_found"]);
  });
  it("does not stall on a huge OCR page: fuzzy matching is capped", () => {
    const big = "lorem ipsum dolor sit amet ".repeat(40000); // about 1 MB
    const t = performance.now();
    const r = verify({ a: leaf(1, 1, "a two hundred character quote that is nowhere on this very large page ".repeat(3).slice(0, 200)) }, [{ text: big, ocr: true }]);
    expect(r.rejected.length).toBe(1);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("quoteOnPage: OCR pages", () => {
  const ocr = (text: string) => ({ text, ocr: true });
  const page = ocr("You must report a defect within thirty (30) days of discovering it. Call Northwind Warranty Service.");
  it("forgives a letter OCR got wrong", () => {
    expect(quoteOnPage("You must report a defect within thirty (30) days of discovcring it.", page)).toBe(true);
  });
  it("forgives a dropped letter", () => {
    expect(quoteOnPage("You must report a defct within thirty (30) days of discovering it.", page)).toBe(true);
  });
  it("never forgives a changed digit", () => {
    expect(quoteOnPage("You must report a defect within thirty (38) days of discovering it.", page)).toBe(false);
    expect(quoteOnPage("You must report a defect within thirty (30) days of discovering it. 1", page)).toBe(false);
  });
  it("never forgives a dropped digit", () => {
    expect(quoteOnPage("You must report a defect within thirty () days of discovering it.", page)).toBe(false);
  });
  it("does not let a changed number word through", () => {
    expect(quoteOnPage("You must report a defect within sixty (30) days of discovering it.", page)).toBe(false);
  });
  it("still rejects an invented quote", () => {
    expect(quoteOnPage("The manufacturer will replace the unit free of charge within one year.", page)).toBe(false);
  });
  it("is exact for short quotes", () => {
    expect(quoteOnPage("Northwind Warrenty", page)).toBe(false);
    expect(quoteOnPage("Northwind Warranty", page)).toBe(true);
  });
  it("is exact on a text layer page with the same words", () => {
    expect(quoteOnPage("You must report a defect within thirty (30) days of discovcring it.", page.text)).toBe(false);
  });
});

describe("verifySourceRefs", () => {
  it("keeps a verified leaf unchanged", () => {
    const f = { claimWindowDays: leaf(30, 1, "within thirty (30) days of discovering it") };
    const r = verify(f);
    expect(r.fields).toEqual(f);
    expect(r.rejected).toEqual([]);
  });
  it("nulls an object field whose quote is not on the page", () => {
    const r = verify({ claimWindowDays: leaf(60, 1, "within sixty (60) days of discovering it") });
    expect(r.fields).toEqual({ claimWindowDays: null });
    expect(r.rejected).toEqual([{ path: "claimWindowDays", reason: "quote_not_found", page: 1 }]);
  });
  it("rejects a real quote cited on the wrong page", () => {
    const r = verify({ x: leaf(30, 2, "within thirty (30) days of discovering it") }, [page1, "Other page text here"]);
    expect(r.fields).toEqual({ x: null });
    expect(r.rejected[0]?.reason).toBe("quote_not_found");
  });
  it.each([0, 2, -1])("rejects page %i as out of range", (p) => {
    const r = verify({ x: leaf(30, p, "within thirty (30) days") });
    expect(r.rejected).toEqual([{ path: "x", reason: "page_out_of_range", page: p }]);
  });
  it("rejects a non-integer page as a missing source", () => {
    expect(verify({ x: { value: 1, sourceRef: { page: 1.5, quote: "within thirty (30) days" } } }).rejected[0]?.reason).toBe("missing_source_ref");
  });
  it("rejects a value with no source", () => {
    const r = verify({ x: { value: 30 }, y: { value: 30, sourceRef: null }, z: { value: 30, sourceRef: { page: 1 } } });
    expect(r.fields).toEqual({ x: null, y: null, z: null });
    expect(r.rejected.map((e) => e.reason)).toEqual(["missing_source_ref", "missing_source_ref", "missing_source_ref"]);
  });
  it("rejects an empty or tiny quote", () => {
    const r = verify({ a: leaf(1, 1, ""), b: leaf(1, 1, "30") });
    expect(r.rejected.map((e) => e.reason)).toEqual(["empty_quote", "empty_quote"]);
  });
  it("keeps a null value without needing a source", () => {
    const r = verify({ endDate: { value: null }, other: { value: null, sourceRef: null } });
    expect(r.fields).toEqual({ endDate: { value: null }, other: { value: null } });
    expect(r.rejected).toEqual([]);
  });
  it("removes failed array items and keeps the good ones in order", () => {
    const r = verify({
      exclusions: [leaf("a", 1, "How to make a claim"), leaf("b", 1, "invented exclusion text"), leaf("c", 1, "Call 1-800-555-0142")],
    });
    expect(r.fields).toEqual({ exclusions: [leaf("a", 1, "How to make a claim"), leaf("c", 1, "Call 1-800-555-0142")] });
    expect(r.rejected).toEqual([{ path: "exclusions[1]", reason: "quote_not_found", page: 1 }]);
  });
  it("reports nested paths", () => {
    const r = verify({
      contact: { phone: leaf("x", 1, "Call 1-800-555-0142"), email: leaf("y", 1, "nobody@example.invalid") },
      assetHint: { model: leaf("m", 1, "made up model number") },
    });
    expect(r.rejected.map((e) => e.path)).toEqual(["contact.email", "assetHint.model"]);
    expect((r.fields as { contact: { phone: unknown; email: unknown } }).contact.email).toBeNull();
  });
  it("does not look inside a value", () => {
    const f = { deductibles: [leaf({ coverage: "collision", amount: 500, value: 1 }, 1, "How to make a claim")] };
    expect(verify(f).rejected).toEqual([]);
  });
  it("passes plain fields and primitives through", () => {
    const f = { docType: "warranty", pages: 1, flag: true, nothing: null };
    expect(verify(f).fields).toEqual(f);
    expect(verify("text").fields).toBe("text");
    expect(verify(null).fields).toBeNull();
  });
  it("does not change its input", () => {
    const f = { a: leaf(1, 1, "invented text for this field"), b: [leaf(2, 1, "How to make a claim")] };
    const copy = JSON.parse(JSON.stringify(f));
    verify(f);
    expect(f).toEqual(copy);
  });
  it("returns a copy, not the same objects", () => {
    const f = { a: leaf(1, 1, "How to make a claim") };
    const r = verify(f);
    expect(r.fields).toEqual(f);
    expect((r.fields as typeof f).a).not.toBe(f.a);
  });
  it("is deterministic", () => {
    const f = { a: leaf(1, 1, "invented text for this field"), b: leaf(2, 1, "How to make a claim") };
    expect(verify(f)).toEqual(verify(f));
  });
  it("uses the OCR tolerance only for OCR pages", () => {
    const f = { a: leaf(30, 1, "You must report a defect within thirty (30) days of discovcring it.") };
    expect(verify(f, [{ text: page1, ocr: true }]).rejected).toEqual([]);
    expect(verify(f, [page1]).rejected.length).toBe(1);
  });
  it("copes with a large page quickly", () => {
    const big = `${"lorem ipsum dolor sit amet ".repeat(800)} within thirty (30) days of discovering it`;
    const t = performance.now();
    expect(verify({ a: leaf(1, 1, "within thirty (30) days of discovering it") }, [{ text: big, ocr: true }]).rejected).toEqual([]);
    expect(verify({ a: leaf(1, 1, "a quote that is not anywhere on this very large page at all") }, [{ text: big, ocr: true }]).rejected.length).toBe(1);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("the fixture documents", () => {
  const dir = fileURLToPath(new URL("../../../fixtures/expected/", import.meta.url));
  const stems = readdirSync(`${dir}pages`).map((f) => f.replace(/\.json$/, ""));
  const load = (path: string) => JSON.parse(readFileSync(`${dir}${path}.json`, "utf8"));
  const pagesOf = (stem: string): PageText[] => {
    const p = load(`pages/${stem}`) as { ocr: boolean; pages: string[] };
    return p.pages.map((text) => ({ text, ocr: p.ocr }));
  };

  it("has page text for all six documents", () => {
    expect(stems.sort()).toEqual(
      ["insurance_auto", "lease", "subscription_fernwood", "subscription_kestrel", "warranty_dishwasher", "warranty_dishwasher_photo"].sort(),
    );
  });
  it.each(["insurance_auto", "lease", "subscription_fernwood", "subscription_kestrel", "warranty_dishwasher", "warranty_dishwasher_photo"])(
    "%s: every expected quote is on its cited page",
    (stem) => {
      const doc = load(stem) as { fields: unknown; pages: number };
      const r = verifySourceRefs(doc.fields, pagesOf(stem));
      expect(r.rejected).toEqual([]);
      expect(r.fields).toEqual(doc.fields);
    },
  );
  it("nulls a tampered warranty exclusion and a tampered claim window", () => {
    const doc = load("warranty_dishwasher") as { fields: Record<string, any> };
    doc.fields.claimWindowDays.sourceRef.quote = "You must report a defect within sixty (60) days of discovering it.";
    doc.fields.exclusions[0].sourceRef.quote = "This warranty does cover damage caused by improper installation.";
    const r = verifySourceRefs(doc.fields, pagesOf("warranty_dishwasher"));
    expect(r.rejected.map((e) => e.path)).toEqual(["exclusions[0]", "claimWindowDays"]);
    expect(r.fields.claimWindowDays).toBeNull();
    expect(r.fields.exclusions).toHaveLength(1);
  });
  it("rejects a lease quote moved to the wrong page", () => {
    const doc = load("lease") as { fields: Record<string, any> };
    doc.fields.noticeDaysToVacate.sourceRef.page = 1;
    const r = verifySourceRefs(doc.fields, pagesOf("lease"));
    expect(r.rejected).toEqual([{ path: "noticeDaysToVacate", reason: "quote_not_found", page: 1 }]);
  });
});

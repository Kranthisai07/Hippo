import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractPages, fillOcrPages, PdfError, OCR_MIN_CHARS, type Ocr } from "../src/pages";
import { buildPdf } from "./pages.helpers";

const LONG = "This line is comfortably longer than fifty characters in total.";
const bytes = (...b: number[]) => new Uint8Array(b);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PdfError) return e.code;
    throw e;
  }
  return "no error";
}

describe("extractPages synthetic PDFs", () => {
  it("keeps page order and 1 based numbers", async () => {
    const r = await extractPages(buildPdf([`${LONG} alpha`, `${LONG} bravo`, `${LONG} charlie`]));
    expect(r.kind).toBe("pdf");
    expect(r.pages.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(r.pages.map((p) => ["alpha", "bravo", "charlie"].filter((w) => p.text.includes(w)))).toEqual([
      ["alpha"],
      ["bravo"],
      ["charlie"],
    ]);
    expect(r.pages.every((p) => !p.needsOcr)).toBe(true);
  });

  it("flags a text-less page and keeps its number", async () => {
    const r = await extractPages(buildPdf([LONG, null, LONG]));
    expect(r.pages.map((p) => [p.number, p.needsOcr])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(r.pages[1]!.text).toBe("");
  });

  it("uses a 50 char threshold on trimmed text", async () => {
    expect(OCR_MIN_CHARS).toBe(50);
    const r = await extractPages(buildPdf(["x".repeat(49), "x".repeat(50), "   " + "x".repeat(47) + "   "]));
    expect(r.pages.map((p) => p.needsOcr)).toEqual([true, false, true]);
  });

  it("fails over the page cap and extracts nothing", async () => {
    const pdf = buildPdf(Array.from({ length: 41 }, () => LONG));
    expect(await codeOf(extractPages(pdf))).toBe("too_many_pages");
    expect((await extractPages(buildPdf(Array.from({ length: 40 }, () => LONG)))).pages).toHaveLength(40);
    expect(await codeOf(extractPages(buildPdf([LONG, LONG, LONG]), { maxPages: 2 }))).toBe("too_many_pages");
  });
});

describe("extractPages errors and images", () => {
  it("rejects empty input", async () => {
    expect(await codeOf(extractPages(new Uint8Array()))).toBe("empty");
  });
  it("rejects garbage and text files", async () => {
    expect(await codeOf(extractPages(new TextEncoder().encode("hello, this is not a pdf at all")))).toBe("not_pdf");
  });
  it("rejects a PDF header with a corrupt body", async () => {
    expect(await codeOf(extractPages(new TextEncoder().encode("%PDF-1.4\nthis is garbage, no objects here\n")))).toBe(
      "corrupt",
    );
  });
  it("rejects a truncated PDF without partial text", async () => {
    const full = buildPdf([LONG, LONG]);
    expect(await codeOf(extractPages(full.slice(0, 120)))).toBe("corrupt");
  });
  it("rejects a password protected PDF", async () => {
    // One blank page, RC4-40 with a user password, made with pypdf.
    const enc =
      "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDFlZGMzNzFmYWM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAxCi9SIDIKL0xlbmd0aCA0MAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDxlNDJjZTg5ZGZmMmQzOGQ4MWI3OWZiNjhlZDNkYTI2NjlkOWY3NTY0YTFmYjQ5NWNmNTdkY2ZjYTllZTRiYWU1PgovVSA8OTFhNGY4OWI1YmIxNzZiZDk0NGE5NWM3YmIyYjUyNjA5NDFkZTc0NTcwNTBhMzhiMmRjNWFjNWNlOWU0NDViYT4KPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjYxIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzUzOTYzMzIzMDYyNjI2MTY1NjMzODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjQ3NQolJUVPRgo=";
    expect(await codeOf(extractPages(new Uint8Array(Buffer.from(enc, "base64"))))).toBe("encrypted");
  });
  it("detects images by magic bytes, one page needing OCR", async () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
    const jpg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
    const heic = bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0);
    for (const b of [png, jpg, heic]) {
      expect(await extractPages(b)).toEqual({
        kind: "image",
        pages: [{ number: 1, text: "", needsOcr: true, ocrDone: false }],
      });
    }
  });
  it("does not treat a non image ftyp brand as an image", async () => {
    const mp4 = bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0);
    expect(await codeOf(extractPages(mp4))).toBe("unsupported");
  });
});

describe("fillOcrPages", () => {
  it("calls ocr only for needsOcr pages and keeps numbers", async () => {
    const r = await extractPages(buildPdf([LONG, null, LONG, null]));
    const seen: number[] = [];
    const ocr: Ocr = async (p) => {
      seen.push(p.number);
      return `ocr page ${p.number}`;
    };
    const filled = await fillOcrPages(r, ocr);
    expect(seen).toEqual([2, 4]);
    expect(filled.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    expect(filled.pages[1]!.text).toBe("ocr page 2");
    expect(filled.pages[0]!.text).toBe(r.pages[0]!.text);
    expect(r.pages[1]!.text).toBe("");
  });
});

describe("fixtures", () => {
  const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const root = new URL("../../../fixtures/", import.meta.url);
  const names = ["warranty_dishwasher", "insurance_auto", "lease", "subscription_fernwood", "subscription_kestrel"];

  for (const name of names) {
    it(`${name}: pages, text layer, and quotes`, async () => {
      const exp = JSON.parse(readFileSync(new URL(`expected/pages/${name}.json`, root), "utf8")) as { pages: string[] };
      const r = await extractPages(new Uint8Array(readFileSync(new URL(`docs/${name}.pdf`, root))));
      expect(r.pages).toHaveLength(exp.pages.length);
      r.pages.forEach((p, i) => {
        expect(p.number).toBe(i + 1);
        expect(p.needsOcr).toBe(false);
        expect(fold(p.text)).toContain(fold(exp.pages[i]!));
      });
      const fields = JSON.parse(readFileSync(new URL(`expected/${name}.json`, root), "utf8")).fields;
      const quotes: { page: number; quote: string }[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          const ref = o.sourceRef as { page?: number; quote?: string } | undefined;
          if (ref && typeof ref.page === "number" && typeof ref.quote === "string")
            quotes.push({ page: ref.page, quote: ref.quote });
          Object.values(o).forEach(walk);
        }
      };
      walk(fields);
      expect(quotes.length).toBeGreaterThan(0);
      for (const q of quotes) expect(fold(r.pages[q.page - 1]!.text)).toContain(fold(q.quote));
    });
  }

  it("the photo is an image needing OCR", async () => {
    const r = await extractPages(new Uint8Array(readFileSync(new URL("docs/warranty_dishwasher_photo.jpg", root))));
    expect(r).toEqual({ kind: "image", pages: [{ number: 1, text: "", needsOcr: true, ocrDone: false }] });
  });
});

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPages, fillOcrPages, PdfError, type Ocr } from "../src/pages";
import { countsAsText } from "../src/pages/extract";
import { buildBinaryPdf, buildPdf } from "./pages.helpers";

const LONG = "This line is comfortably longer than fifty characters in total.";
const bytes = (...b: number[]) => new Uint8Array(b);
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const PNG_SIG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPG_SIG = bytes(0xff, 0xd8, 0xff, 0xe0);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PdfError) return e.code;
    throw e;
  }
  return "no error";
}

describe("lying page tree", () => {
  it("rejects 2 real pages with /Count 1 instead of dropping page 2", async () => {
    expect(await codeOf(extractPages(buildPdf([LONG, "second page quote"], { count: 1 })))).toBe("corrupt");
  });
  it("rejects 41 real pages with /Count 2 as too_many_pages", async () => {
    const pdf = buildPdf(Array.from({ length: 41 }, () => LONG), { count: 2 });
    expect(await codeOf(extractPages(pdf))).toBe("too_many_pages");
  });
  it("never returns a wrong page list when /Count is too high", async () => {
    const r = await extractPages(buildPdf([LONG, LONG], { count: 5 }).slice()).catch((e) => e);
    if (r instanceof PdfError) expect(r.code).toBe("corrupt");
    else expect(r.pages).toHaveLength(2);
  });
  it("still accepts an honest tree", async () => {
    expect((await extractPages(buildPdf([LONG, LONG, LONG]))).pages).toHaveLength(3);
  });
});

describe("resource limits", () => {
  it("rejects input over maxBytes before parsing", async () => {
    const pdf = buildPdf([LONG]);
    expect(await codeOf(extractPages(pdf, { maxBytes: pdf.length - 1 }))).toBe("too_large");
    expect((await extractPages(pdf, { maxBytes: pdf.length })).pages).toHaveLength(1);
    expect(await codeOf(extractPages(new Uint8Array(26 * 1024 * 1024)))).toBe("too_large");
  });

  // A fake timer that the test fires by hand, so no real waiting and no flakiness.
  function fakeTimers() {
    let fire: () => void = () => {};
    let cleared = false;
    return {
      timers: {
        setTimeout: (fn: () => void) => ((fire = fn), 1),
        clearTimeout: () => void (cleared = true),
      },
      fire: () => fire(),
      wasCleared: () => cleared,
    };
  }

  it("times out while loading the document", async () => {
    const t = fakeTimers();
    const p = extractPages(buildPdf([LONG]), { timeoutMs: 5, timers: t.timers });
    t.fire();
    expect(await codeOf(p)).toBe("timeout");
  });
  it("times out in the page loop", async () => {
    const t = fakeTimers();
    const p = extractPages(buildPdf(Array.from({ length: 40 }, () => LONG)), { timers: t.timers });
    // Fire the deadline when page 1 text is requested: loading is done, 39 pages are not.
    const probe = pdfjs.getDocument({ data: buildPdf([LONG]) });
    const proto = Object.getPrototypeOf(await (await probe.promise).getPage(1)) as { getTextContent: (...a: unknown[]) => Promise<unknown> };
    await probe.destroy();
    const orig = proto.getTextContent;
    proto.getTextContent = function (this: unknown, ...a: unknown[]) {
      t.fire();
      return orig.apply(this, a);
    };
    try {
      expect(await codeOf(p)).toBe("timeout");
    } finally {
      proto.getTextContent = orig;
    }
  });
  it("clears its timer on success and uses a 10 second default", async () => {
    const t = fakeTimers();
    let ms = 0;
    await extractPages(buildPdf([LONG]), { timers: { ...t.timers, setTimeout: (fn, m) => ((ms = m), t.timers.setTimeout(fn)) } });
    expect(ms).toBe(10_000);
    expect(t.wasCleared()).toBe(true);
  });

  it("survives a 20 MB decompression bomb within the byte cap, quickly", async () => {
    const raw = Buffer.alloc(20 * 1024 * 1024, 0x20);
    const bomb = buildBinaryPdf("/Filter /FlateDecode", deflateSync(raw));
    expect(bomb.length).toBeLessThan(200_000);
    const started = Date.now();
    const r = await extractPages(bomb);
    expect(r.pages).toEqual([{ number: 1, text: "", needsOcr: true, ocrDone: false }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("file type detection", () => {
  const pdf = buildPdf([LONG]);
  it("needs the full PNG signature", async () => {
    expect(await codeOf(extractPages(bytes(0x89, 0x50, 0x4e, 0x47)))).toBe("not_pdf");
    expect((await extractPages(cat(PNG_SIG, bytes(0, 0)))).kind).toBe("image");
  });
  it("needs three JPEG bytes", async () => {
    expect(await codeOf(extractPages(bytes(0xff, 0xd8)))).toBe("not_pdf");
    expect((await extractPages(cat(JPG_SIG, bytes(0, 0x10)))).kind).toBe("image");
  });
  it("treats a PDF header within the first KB as a PDF even after a JPEG or PNG prefix", async () => {
    for (const prefix of [JPG_SIG, PNG_SIG]) {
      const r = await extractPages(cat(prefix, pdf));
      expect(r.kind).toBe("pdf");
      expect(r.pages[0]!.text).toContain("comfortably");
    }
  });
  it("does not let a PDF header after 1024 bytes rescue an image", async () => {
    const r = await extractPages(cat(JPG_SIG, new Uint8Array(2000), pdf));
    expect(r.kind).toBe("image");
  });
  it("names known but unsupported formats", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const ftyp = (brand: string) => cat(bytes(0, 0, 0, 0x18), enc("ftyp"), enc(brand), new Uint8Array(8));
    const cases: Record<string, Uint8Array> = {
      tiffLE: bytes(0x49, 0x49, 0x2a, 0x00, 1, 2),
      tiffBE: bytes(0x4d, 0x4d, 0x00, 0x2a, 1, 2),
      gif: enc("GIF89a\x01\x00"),
      webp: cat(enc("RIFF"), bytes(1, 2, 3, 4), enc("WEBPVP8 ")),
      svg: enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      svgBare: enc("<svg></svg>"),
      zip: bytes(0x50, 0x4b, 0x03, 0x04, 0, 0),
      avif: ftyp("avif"),
      mp4: ftyp("isom"),
    };
    for (const [name, b] of Object.entries(cases)) expect([name, await codeOf(extractPages(b))]).toEqual([name, "unsupported"]);
    expect(await codeOf(extractPages(enc("plain text, nothing special")))).toBe("not_pdf");
  });
});

describe("countsAsText", () => {
  const zw = ["​", "‌", "‍", "⁠", "﻿"].join("");
  it("counts only letters and digits", () => {
    expect(countsAsText("abc 123")).toBe(6);
    expect(countsAsText(zw.repeat(40))).toBe(0);
    expect(countsAsText("\u0000\u0001\u0007\u007f́̂ \t\n")).toBe(0);
    expect(countsAsText("é")).toBe(1);
    expect(countsAsText("\u{1d7d8}\u{20bb7}")).toBe(2);
    expect(countsAsText("...---!!!")).toBe(0);
  });
});

describe("page flags", () => {
  it("documents that a corrupt content stream looks like a scanned page", async () => {
    const bad = buildBinaryPdf("/Filter /FlateDecode", bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    const r = await extractPages(bad);
    expect(r.pages).toEqual([{ number: 1, text: "", needsOcr: true, ocrDone: false }]);
  });
  it("documents that invisible (Tr 3) text is extracted like visible text", async () => {
    const r = await extractPages(buildPdf([LONG], { renderMode: 3 }));
    expect(r.pages[0]!.text).toContain("comfortably");
    expect(r.pages[0]!.needsOcr).toBe(false);
  });
});

describe("fillOcrPages state", () => {
  const ocrOf = (f: (n: number) => unknown): Ocr => (async (p: { number: number }) => f(p.number)) as Ocr;
  it("marks filled pages ocrDone, keeps needsOcr, trims, and copies untouched pages", async () => {
    const r = await extractPages(buildPdf([LONG, null]));
    const out = await fillOcrPages(r, ocrOf((n) => `  ocr ${n}\n`));
    expect(out.pages[1]).toEqual({ number: 2, text: "ocr 2", needsOcr: true, ocrDone: true });
    expect(out.pages[0]).toEqual(r.pages[0]);
    expect(out.pages[0]!.ocrDone).toBe(false);
    expect(out.pages[0]).not.toBe(r.pages[0]);
    expect(r.pages[1]!.ocrDone).toBe(false);
  });
  it("fails closed on a non string OCR result", async () => {
    const r = await extractPages(buildPdf([null]));
    for (const bad of [undefined, null, 42, { text: "x" }]) {
      expect(await codeOf(fillOcrPages(r, ocrOf(() => bad)))).toBe("bad_ocr");
    }
  });
});

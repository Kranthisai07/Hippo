import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { extractPages, PdfError } from "../src/pages";
import { buildBinaryPdf, buildPdf, buildRawPdf, streamObj } from "./pages.helpers";

const LONG = "This line is comfortably longer than fifty characters in total.";
const MB = 1024 * 1024;

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    const r = (await p) as { pages: unknown[] };
    return `ok:${r.pages.length}`;
  } catch (e) {
    if (e instanceof PdfError) return e.code;
    throw e;
  }
}
async function timed(p: Promise<unknown>): Promise<{ out: string; ms: number }> {
  const t = Date.now();
  const out = await outcome(p);
  return { out, ms: Date.now() - t };
}

const BASE: Record<number, string> = {
  1: "<< /Type /Catalog /Pages 2 0 R >>",
  2: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
  3: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  4: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
};
const withObjStm = (dictExtra: string, data: Buffer) => buildRawPdf({ ...BASE, 6: streamObj(`/Type /ObjStm /N 1 /First 4 ${dictExtra}`, data) });
const pageObjs = (n: number) => Buffer.from("7 0 " + Array.from({ length: n }, () => "<< /Type /Page /Parent 2 0 R >>").join(" "), "latin1");

describe("pre-scan cost is linear", () => {
  for (const mb of [1.6, 3.2]) {
    it(`${mb} MB of /Type /ObjStm markers finishes quickly with a typed result`, async () => {
      const markers = Buffer.from("/Type /ObjStm ".repeat(Math.floor((mb * MB) / 14)), "latin1");
      const r = await timed(extractPages(buildBinaryPdf("", markers)));
      expect(r.out).toMatch(/^(ok:1|corrupt|unsupported)$/);
      expect(r.ms).toBeLessThan(4000) /* the quadratic scan took 7 s and 23 s */;
    });
  }
  for (const unit of ["stream\n", "/", "/Type %", "/Type /Page\n", "endstream stream\r"]) {
    it(`10 MB of ${JSON.stringify(unit)} stays linear and typed`, async () => {
      const junk = Buffer.from(unit.repeat(Math.floor((10 * MB) / unit.length)), "latin1");
      const r = await timed(extractPages(buildBinaryPdf("", junk)));
      expect(r.out).toMatch(/^(ok:1|corrupt|unsupported|too_large|too_many_pages)$/);
      expect(r.ms).toBeLessThan(12_000); // a quadratic scan takes minutes here; the margin keeps a loaded CI machine from flaking
    });
  }
  it("thousands of markers before a deflate bomb: rejected too_large, fast, and the bomb is unreferenced so pdf.js never saw it", async () => {
    const bomb = deflateSync(Buffer.alloc(100 * MB, 0x20));
    const pdf = buildRawPdf({
      ...BASE,
      5: streamObj("", Buffer.from("/Type /ObjStm ".repeat(5000), "latin1")),
      6: streamObj("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", bomb),
    });
    const r = await timed(extractPages(pdf));
    expect(r.out).toBe("too_large");
    expect(r.ms).toBeLessThan(8000);
  });
});

describe("decompression is bounded before pdf.js runs", () => {
  it("rejects a 100 MB flate stream (over the per stream cap) as too_large", async () => {
    const r = await timed(extractPages(buildBinaryPdf("/Filter /FlateDecode", deflateSync(Buffer.alloc(100 * MB, 0x20)))));
    expect(r.out).toBe("too_large");
    expect(r.ms).toBeLessThan(8000);
  });
  it("caps how many compressed streams it will try (corrupt ones too)", async () => {
    const objs: Record<number, string | Buffer> = { ...BASE };
    for (let i = 0; i < 5001; i++) objs[10 + i] = streamObj("/Filter /FlateDecode", Buffer.from([0x78, 0x9c, 1, 2, 3]));
    const r = await timed(extractPages(buildRawPdf(objs)));
    expect(r.out).toBe("too_large");
    expect(r.ms).toBeLessThan(8000);
  });
  it("rejects many streams that together decode past the total cap", async () => {
    const one = deflateSync(Buffer.alloc(40 * MB, 0x20)); // each is under the per stream cap
    const objs: Record<number, string | Buffer> = { ...BASE };
    for (let i = 0; i < 8; i++) objs[10 + i] = streamObj("/Filter /FlateDecode", one);
    expect(await outcome(extractPages(buildRawPdf(objs)))).toBe("too_large");
  });
});

describe("lying /Count with page objects the byte scan used to miss", () => {
  const forms: Record<string, string> = {
    "name escape in Type": "/Ty#70e /Page",
    "name escape in Page": "/Type /Pa#67e",
    "comment between tokens": "/Type %c\n /Page",
  };
  for (const [name, pageType] of Object.entries(forms)) {
    for (const n of [5, 45]) {
      it(`${name}, ${n} real pages, /Count 1`, async () => {
        const pdf = buildPdf(Array.from({ length: n }, () => LONG), { count: 1, pageType });
        expect(await outcome(extractPages(pdf))).toBe(n > 40 ? "too_many_pages" : "corrupt");
      });
    }
  }
  it("still accepts an honest tree written with the odd forms", async () => {
    const pdf = buildPdf([LONG, LONG, LONG], { pageType: "/Ty#70e /Pa#67e" });
    expect(await outcome(extractPages(pdf))).toBe("ok:3");
  });
  it("counts page objects inside a flate object stream", async () => {
    expect(await outcome(extractPages(withObjStm("/Filter /FlateDecode", deflateSync(pageObjs(3)))))).toBe("corrupt");
  });
});

describe("object streams the scan cannot read fail closed", () => {
  it("ASCIIHex object stream", async () => {
    const hex = Buffer.from(pageObjs(44).toString("hex") + ">", "latin1");
    expect(await outcome(extractPages(withObjStm("/Filter /ASCIIHexDecode", hex)))).toBe("unsupported");
  });
  it("[ASCIIHex Flate] object stream", async () => {
    const hex = Buffer.from(deflateSync(pageObjs(44)).toString("hex") + ">", "latin1");
    expect(await outcome(extractPages(withObjStm("/Filter [/ASCIIHexDecode /FlateDecode]", hex)))).toBe("unsupported");
  });
  it("flate object stream that does not inflate", async () => {
    expect(await outcome(extractPages(withObjStm("/Filter /FlateDecode", Buffer.from([0x78, 0x9c, 1, 2, 3, 4, 5, 6]))))).toBe("unsupported");
  });
  it("object stream hidden behind a name escape and a long dictionary", async () => {
    const pad = "/Pad (" + "x".repeat(900) + ")";
    expect(await outcome(extractPages(buildRawPdf({ ...BASE, 6: streamObj(`/Type /Obj#53tm /N 1 /First 4 ${pad} /Filter /ASCIIHexDecode`, Buffer.from("00>")) })))).toBe("unsupported");
  });
  it("an unfiltered object stream is plain text the raw scan reads", async () => {
    expect(await outcome(extractPages(withObjStm("", pageObjs(2))))).toBe("corrupt");
  });
});

// RC4 40 bit, empty user password, built by hand (the existing encrypted fixture has no object streams).
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}
describe("encrypted PDF with flate object streams", () => {
  it("lying /Count over an object stream pdf.js can decrypt but we cannot inflate gives a typed error", async () => {
    const pad = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
    const O = Buffer.alloc(32, 7);
    const id = Buffer.alloc(16, 9);
    const key = createHash("md5").update(Buffer.concat([pad, O, Buffer.from([0xfc, 0xff, 0xff, 0xff]), id])).digest().subarray(0, 5);
    const U = rc4(key, pad);
    const objKey = createHash("md5").update(Buffer.concat([key, Buffer.from([7, 0, 0, 0, 0])])).digest().subarray(0, 10);
    const data = rc4(objKey, deflateSync(pageObjs(44)));
    const pdf = buildRawPdf(
      {
        ...BASE,
        6: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P -4 >>`,
        7: streamObj("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", data),
      },
      `/Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`,
    );
    const out = await outcome(extractPages(pdf));
    expect(["unsupported", "encrypted"]).toContain(out);
  });
});

describe("input handling", () => {
  it("is not affected by the caller zeroing its buffer after the call (lying tree is still caught)", async () => {
    const buf = buildPdf([LONG, LONG], { count: 1 });
    const p = extractPages(buf);
    buf.fill(0);
    expect(await outcome(p)).toBe("corrupt");
  });
  it("is not affected by the caller mutating an honest buffer after the call", async () => {
    const buf = buildPdf([LONG, LONG, LONG]);
    const p = extractPages(buf);
    buf.fill(0x41);
    const r = await p;
    expect(r.pages.map((x) => x.number)).toEqual([1, 2, 3]);
  });
  it("accepts a Node Buffer", async () => {
    const r = await extractPages(Buffer.from(buildPdf([LONG])));
    expect(r.pages).toHaveLength(1);
  });
});

describe("deadline between pages", () => {
  it("timeoutMs 1 on a 40 page document throws timeout", async () => {
    expect(await outcome(extractPages(buildPdf(Array.from({ length: 40 }, () => LONG)), { timeoutMs: 1 }))).toBe("timeout");
  });
});

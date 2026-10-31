// Hand-written minimal PDFs for tests. Offsets in the xref table are computed so the files are valid.
export interface BuildOpts {
  /** Overrides the /Count entry so it can lie about the real page tree. */
  count?: number;
  /** Text render mode (Tr) for the page text; 3 is invisible. */
  renderMode?: number;
  /** Replaces the literal `/Type /Page` in page objects (e.g. with name escapes or comments pdf.js still accepts). */
  pageType?: string;
}

export function buildPdf(pageTexts: (string | null)[], opts: BuildOpts = {}): Uint8Array {
  const objs: string[] = [];
  const n = pageTexts.length;
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${opts.count ?? n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((t, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    const res = "/Resources << /Font << /F1 3 0 R >> >>";
    if (t === null) {
      objs[pageId] = `<< ${opts.pageType ?? "/Type /Page"} /Parent 2 0 R /MediaBox [0 0 612 792] ${res} >>`;
      objs[contentId] = "<< /Length 0 >>\nstream\n\nendstream";
    } else {
      const stream = `BT /F1 12 Tf ${opts.renderMode ?? 0} Tr 72 700 Td (${t.replace(/[()\\]/g, "\\$&")}) Tj ET`;
      objs[pageId] =
        `<< ${opts.pageType ?? "/Type /Page"} /Parent 2 0 R /MediaBox [0 0 612 792] ${res} /Contents ${contentId} 0 R >>`;
      objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** One page whose content stream is the given raw bytes, with extra stream dictionary entries (for filters). */
export function buildBinaryPdf(streamDictExtra: string, streamBytes: Uint8Array): Uint8Array {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    len += buf.length;
  };
  push("%PDF-1.4\n");
  const simple = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
  ];
  simple.forEach((o, i) => {
    offsets[i + 1] = len;
    push(`${i + 1} 0 obj\n${o}\nendobj\n`);
  });
  offsets[5] = len;
  push(`5 0 obj\n<< /Length ${streamBytes.length} ${streamDictExtra} >>\nstream\n`);
  push(Buffer.from(streamBytes));
  push("\nendstream\nendobj\n");
  const xref = len;
  let x = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(`${x}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

/** An indirect object body for a stream: dictionary plus raw data. */
export function streamObj(dictExtra: string, data: Buffer): Buffer {
  const head = Buffer.from(`<< /Length ${data.length} ${dictExtra} >>\nstream\n`, "latin1");
  return Buffer.concat([head, data, Buffer.from("\nendstream", "latin1")]);
}

/** Assembles numbered objects (missing numbers become free xref entries) into a valid file with an xref table. */
export function buildRawPdf(objs: Record<number, string | Buffer>, trailerExtra = ""): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let len = parts[0]!.length;
  const max = Math.max(...Object.keys(objs).map(Number));
  const offsets: (number | undefined)[] = [];
  for (let i = 1; i <= max; i++) {
    const o = objs[i];
    if (o === undefined) continue;
    offsets[i] = len;
    const body = typeof o === "string" ? Buffer.from(o, "latin1") : o;
    const b = Buffer.concat([Buffer.from(`${i} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(b);
    len += b.length;
  }
  let x = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++)
    x += offsets[i] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  parts.push(
    Buffer.from(
      `${x}trailer\n<< /Size ${max + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${len}\n%%EOF\n`,
      "latin1",
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}

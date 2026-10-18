// Hand-written minimal PDFs for tests. Offsets in the xref table are computed so the files are valid.
export function buildPdf(pageTexts: (string | null)[]): Uint8Array {
  const objs: string[] = [];
  const n = pageTexts.length;
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((t, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    const res = "/Resources << /Font << /F1 3 0 R >> >>";
    if (t === null) {
      objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${res} >>`;
      objs[contentId] = "<< /Length 0 >>\nstream\n\nendstream";
    } else {
      const stream = `BT /F1 12 Tf 72 700 Td (${t.replace(/[()\\]/g, "\\$&")}) Tj ET`;
      objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${res} /Contents ${contentId} 0 R >>`;
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

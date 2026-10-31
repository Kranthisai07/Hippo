// Kept apart from extract.ts so code that only needs to recognise a PDF failure does not import the PDF reader.

export type PdfErrorCode =
  | "not_pdf" // bytes that are neither a PDF nor a known format
  | "unsupported" // a known format we do not read (TIFF, GIF, WebP, SVG, ZIP, AVIF, mp4)
  | "corrupt"
  | "encrypted"
  | "too_many_pages"
  | "too_large"
  | "timeout"
  | "bad_ocr" // the injected OCR function returned something other than a string
  | "empty";

export class PdfError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfError";
  }
}

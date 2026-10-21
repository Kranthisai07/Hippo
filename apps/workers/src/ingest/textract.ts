// Textract adapter (docs/VERIFIED.md section 4), behind an explicit flag and never called by default. Uses the
// synchronous DetectDocumentText call: JPEG, PNG, or a 1 page PDF, at most 10 MB, never HEIC. A multi page PDF whose
// pages are pictures cannot be read page by page without rasterizing it, so the pipeline refuses that case before it
// gets here (see `ocrReadsPdfPages`). Tested with a fake client only.
import { DetectDocumentTextCommand, TextractClient } from "@aws-sdk/client-textract";
import type { Ocr } from "core/src/pages";
import { IngestFailure } from "./types";

export interface TextractLike {
  send(command: DetectDocumentTextCommand): Promise<{ Blocks?: { BlockType?: string; Text?: string }[] }>;
}

export const TEXTRACT_MAX_BYTES = 10 * 1024 * 1024;

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const isReadable = (b: Uint8Array) =>
  startsWith(b, [0xff, 0xd8, 0xff]) ||
  startsWith(b, [0x89, 0x50, 0x4e, 0x47]) ||
  startsWith(b, [0x25, 0x50, 0x44, 0x46]);

export function createTextractOcr(client: TextractLike): Ocr {
  return async ({ image }) => {
    if (!image) throw new IngestFailure("We could not read this file. Try uploading it again.");
    if (image.length > TEXTRACT_MAX_BYTES)
      throw new IngestFailure("This file is too large to read. Upload a smaller copy.");
    if (!isReadable(image))
      throw new IngestFailure(
        "We can only read JPEG, PNG and PDF files. Convert this photo to JPEG and upload it again.",
      );
    const out = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: image } }));
    return (out.Blocks ?? [])
      .filter((b) => b.BlockType === "LINE" && typeof b.Text === "string")
      .map((b) => b.Text)
      .join("\n");
  };
}

/** Builds the real client. Called only by code that has checked the live flag. */
export const createLiveTextractClient = (region?: string): TextractLike =>
  new TextractClient(region ? { region } : {}) as unknown as TextractLike;

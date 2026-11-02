import type { Doc } from "core/src/contracts";
import { maskNumbers } from "../mcp/speak";
import { sha256Hex } from "./hash";
import { sanitizeFilename } from "./storage";

/**
 * The document and the text for one captured page or email, built the same way wherever it comes from. Numbers are masked
 * here, whatever the sender did, and the id comes from the text, so the same page or email saved twice is one document.
 * `prefix` is where the text is kept: `captures` for the extension, `imports` for the mailbox import.
 */
export async function prepareCapture(a: {
  householdId: string;
  title: string;
  host: string;
  text: string;
  now: () => number;
  prefix: "captures" | "imports";
}): Promise<{ doc: Doc; text: string; host: string }> {
  const host = a.host.toLowerCase();
  const title = maskNumbers(a.title.replace(/\s+/g, " ").trim());
  const text = `${title}\n${maskNumbers(a.text)}`;
  const docId = `doc-${(await sha256Hex(text)).slice(0, 24)}`;
  const doc: Doc = {
    id: docId,
    s3Key: `${a.prefix}/${a.householdId}/${docId}/page.txt`,
    // The site name is masked too: a host can hold an account number, and this name is quoted back by the voice tools.
    filename: sanitizeFilename(maskNumbers(`${host} ${title}`).replace(/[\/]/g, " "), "txt"),
    docType: "other",
    status: "uploaded",
    uploadedAt: new Date(a.now()).toISOString(),
    assetIds: [],
  };
  return { doc, text, host };
}

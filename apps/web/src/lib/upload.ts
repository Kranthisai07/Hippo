import { api } from "./api";
import type { Doc, DocDetail, UploadTicket } from "./types";

export type UploadPhase = "uploading" | "reading" | "ready" | "failed";

export interface UploadState {
  phase: UploadPhase;
  docId?: string;
  /** Plain words from the server when phase is failed. */
  reason?: string;
}

export interface PollOptions {
  intervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onStatus?: (doc: Doc) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WORKING = new Set(["uploaded", "extracting"]);

/** Polls GET /api/docs/<id> every 2 seconds while the document is uploaded or extracting. Always ends. */
export async function pollDoc(
  getDoc: (id: string) => Promise<DocDetail>,
  docId: string,
  opts: PollOptions = {},
): Promise<Doc> {
  const { intervalMs = 2000, maxPolls = 300, sleep = wait, signal, onStatus } = opts;
  for (let n = 0; n < maxPolls; n++) {
    if (signal?.aborted) throw new Error("Checking was stopped.");
    const { doc } = await getDoc(docId);
    onStatus?.(doc);
    if (!WORKING.has(doc.status)) return doc;
    if (signal?.aborted) throw new Error("Checking was stopped.");
    if (n < maxPolls - 1) await sleep(intervalMs);
  }
  throw new Error("This is taking longer than expected. Check back in a few minutes.");
}

export interface UploadDeps {
  announce: (f: { filename: string; contentType: string; size: number }) => Promise<UploadTicket>;
  putBytes: (upload: UploadTicket["upload"], file: Blob) => Promise<void>;
  getDoc: (id: string) => Promise<DocDetail>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export const realUploadDeps: UploadDeps = {
  announce: api.announceUpload,
  putBytes: api.putUpload,
  getDoc: api.getDoc,
};

const messageOf = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";

/** Announce, send the bytes with exactly the headers the server named, then watch the document until it settles. */
export async function uploadOne(
  file: File,
  deps: UploadDeps,
  onChange: (s: UploadState) => void,
): Promise<UploadState> {
  const set = (s: UploadState): UploadState => (onChange(s), s);
  let docId: string | undefined;
  try {
    set({ phase: "uploading" });
    const ticket = await deps.announce({ filename: file.name, contentType: file.type, size: file.size });
    docId = ticket.docId;
    await deps.putBytes(ticket.upload, file);
    set({ phase: "reading", docId });
    const doc = await pollDoc(deps.getDoc, docId, {
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      onStatus: (d) => {
        if (d.status === "extracting" || d.status === "uploaded") onChange({ phase: "reading", docId: d.id });
      },
    });
    if (doc.status === "failed") {
      return set({ phase: "failed", docId, reason: doc.failureReason ?? "We could not read this file." });
    }
    return set({ phase: "ready", docId });
  } catch (e) {
    return set({ phase: "failed", ...(docId ? { docId } : {}), reason: messageOf(e) });
  }
}

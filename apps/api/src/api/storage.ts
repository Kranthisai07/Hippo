// Where uploaded bytes live. Production is S3 behind a presigned URL (not built here), local mode is a Map behind a PUT
// route of this server. Nothing in this file talks to the network.

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Content type to the extension used in the object key. The key never contains the person's file name. */
export const UPLOAD_TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" } as const;
export type UploadType = keyof typeof UPLOAD_TYPES;
export const isUploadType = (t: string): t is UploadType => Object.hasOwn(UPLOAD_TYPES, t);

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a key that does not exist is fine. */
  delete(keys: readonly string[]): Promise<void>;
}

export function createMemoryObjectStore(): ObjectStore & { keys(): string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (keys) => void keys.forEach((k) => objects.delete(k)),
    keys: () => [...objects.keys()].sort(),
  };
}

export interface UploadDescriptor {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface Uploader {
  /** How the browser sends the bytes for one object. The key is already scoped to the household. */
  prepare(req: { key: string; contentType: string; size: number }): UploadDescriptor | Promise<UploadDescriptor>;
}

/** An uploader that points at this server's own PUT route and remembers what it promised for each key. */
export interface LocalUploader extends Uploader {
  expected(key: string): { contentType: string; size: number } | undefined;
  done(key: string): void;
}

export const LOCAL_UPLOAD_TTL_SECONDS = 900;

export function createLocalUploader(opts: { now?: () => number } = {}): LocalUploader {
  const now = opts.now ?? Date.now;
  const pending = new Map<string, { contentType: string; size: number; at: number }>();
  return {
    prepare({ key, contentType, size }) {
      // The key is uploads/<household>/<docId>/original.<ext>, so the doc id is the third segment.
      const docId = key.split("/")[2] ?? "";
      pending.set(key, { contentType, size, at: now() });
      return {
        method: "PUT",
        url: `/api/uploads/${encodeURIComponent(docId)}/content`,
        headers: { "Content-Type": contentType },
        expiresInSeconds: LOCAL_UPLOAD_TTL_SECONDS,
      };
    },
    // An announced upload is only open for the time the descriptor promised (expiresInSeconds).
    expected: (key) => {
      const p = pending.get(key);
      return p && now() - p.at <= LOCAL_UPLOAD_TTL_SECONDS * 1000
        ? { contentType: p.contentType, size: p.size }
        : undefined;
    },
    done: (key) => void pending.delete(key),
  };
}

const MAX_NAME = 100;

/**
 * A display name only. Path parts, control and invisible characters (NUL, bidi overrides, zero width) are removed, the
 * result is NFC, at most 100 characters with its extension kept, and never empty.
 */
export function sanitizeFilename(raw: string, fallbackExt: string): string {
  const base = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const name = cleaned === "" ? `document.${fallbackExt}` : cleaned;
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return name.slice(0, MAX_NAME - ext.length) + ext;
}

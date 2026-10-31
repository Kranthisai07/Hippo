import type { Context } from "hono";
import type { z } from "zod";

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500;

const CODES: Record<ApiStatus, string> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden_origin",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  415: "unsupported_type",
  422: "limit_reached",
  429: "rate_limited",
  500: "internal",
};

/** Thrown by route code, turned into the one error shape by the app's onError. The message is for a person. */
export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
  get code(): string {
    return CODES[this.status];
  }
}

export const errorBody = (status: ApiStatus, message: string) => ({ error: { code: CODES[status], message } });

/** A missing id and another household's id must look exactly the same. */
export const notFound = (): ApiError => new ApiError(404, "We could not find that.");

/** JSON bodies are small on purpose: the biggest legitimate one is a list of field names. */
export const MAX_JSON_BYTES = 64 * 1024;

/** Reads at most `max` bytes. Returns null as soon as the body is longer, without reading the rest. */
export async function readBytes(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Names the fields that failed and nothing else, so a value (which may be document text) is never echoed. */
export function describeIssues(error: z.ZodError): string {
  const names = [...new Set(error.issues.map((i) => i.path.map(String).join(".") || "body"))].slice(0, 5);
  return `Please check ${names.join(", ")} and try again.`;
}

/** JSON content type, a bounded body, strict zod. Any failure is a clear 4xx. */
export async function readJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  maxBytes = MAX_JSON_BYTES,
): Promise<z.infer<S>> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (type.split(";")[0]!.trim() !== "application/json")
    throw new ApiError(415, "Send the request as JSON (application/json).");
  const bytes = await readBytes(c.req.raw, maxBytes);
  if (bytes === null) throw new ApiError(413, "That request is too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, describeIssues(parsed.error));
  return parsed.data;
}

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { pollDoc, uploadOne, type UploadState } from "../src/lib/upload";
import type { Doc } from "../src/lib/types";

const doc = (status: Doc["status"], extra: Partial<Doc> = {}): Doc => ({
  id: "d1",
  filename: "lease.pdf",
  docType: "lease",
  status,
  uploadedAt: "2026-10-21T12:00:00.000Z",
  assetIds: [],
  ...extra,
});

const noWait = () => Promise.resolve();

describe("pollDoc", () => {
  it("polls while uploaded or extracting and stops at needs_review", async () => {
    const seq = [doc("uploaded"), doc("extracting"), doc("extracting"), doc("needs_review", { pages: 4 })];
    const getDoc = vi.fn(async () => ({ doc: seq.shift()!, agreement: null }));
    const seen: string[] = [];
    const final = await pollDoc(getDoc, "d1", { sleep: noWait, onStatus: (d) => seen.push(d.status) });
    expect(final.status).toBe("needs_review");
    expect(getDoc).toHaveBeenCalledTimes(4);
    expect(seen).toEqual(["uploaded", "extracting", "extracting", "needs_review"]);
  });

  it("stops at once on a failed document and keeps the reason", async () => {
    const getDoc = vi.fn(async () => ({
      doc: doc("failed", { failureReason: "Print the file to PDF and try again." }),
      agreement: null,
    }));
    const final = await pollDoc(getDoc, "d1", { sleep: noWait });
    expect(final.status).toBe("failed");
    expect(final.failureReason).toBe("Print the file to PDF and try again.");
    expect(getDoc).toHaveBeenCalledTimes(1);
  });

  it("waits the interval between polls (2 seconds by default)", async () => {
    const waits: number[] = [];
    const seq = [doc("extracting"), doc("active")];
    await pollDoc(async () => ({ doc: seq.shift()!, agreement: null }), "d1", {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([2000]);
  });

  it("gives up after the poll limit instead of polling forever", async () => {
    const getDoc = vi.fn(async () => ({ doc: doc("extracting"), agreement: null }));
    await expect(pollDoc(getDoc, "d1", { sleep: noWait, maxPolls: 5 })).rejects.toThrow(/taking longer/i);
    expect(getDoc).toHaveBeenCalledTimes(5);
  });

  it("stops when aborted", async () => {
    const ctl = new AbortController();
    const getDoc = vi.fn(async () => {
      ctl.abort();
      return { doc: doc("extracting"), agreement: null };
    });
    await expect(pollDoc(getDoc, "d1", { sleep: noWait, signal: ctl.signal })).rejects.toThrow(/stopped/i);
    expect(getDoc).toHaveBeenCalledTimes(1);
  });
});

describe("uploadOne", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "lease.pdf", { type: "application/pdf" });
  const upload = {
    method: "PUT" as const,
    url: "/api/uploads/d1/content",
    headers: { "Content-Type": "application/pdf" },
    expiresInSeconds: 900,
  };

  it("goes uploading, reading, ready", async () => {
    const states: UploadState[] = [];
    const seq = [doc("extracting"), doc("needs_review")];
    await uploadOne(
      file,
      {
        announce: vi.fn(async () => ({ docId: "d1", upload })),
        putBytes: vi.fn(async () => undefined),
        getDoc: async () => ({ doc: seq.shift()!, agreement: null }),
        sleep: noWait,
      },
      (s) => states.push(s),
    );
    expect(states.map((s) => s.phase)).toEqual(["uploading", "reading", "reading", "ready"]);
    expect(states.at(-1)?.docId).toBe("d1");
  });

  it("ends failed with the pipeline reason, as plain text", async () => {
    const states: UploadState[] = [];
    await uploadOne(
      file,
      {
        announce: async () => ({ docId: "d1", upload }),
        putBytes: async () => undefined,
        getDoc: async () => ({
          doc: doc("failed", { failureReason: "We could not read this file." }),
          agreement: null,
        }),
        sleep: noWait,
      },
      (s) => states.push(s),
    );
    expect(states.at(-1)).toMatchObject({ phase: "failed", reason: "We could not read this file." });
  });

  it("shows the server message when the announce is refused (415, 413, 429)", async () => {
    for (const status of [415, 413, 429]) {
      const states: UploadState[] = [];
      await uploadOne(
        file,
        {
          announce: async () => {
            throw new ApiError(status, "x", `Server says no ${status}.`);
          },
          putBytes: async () => undefined,
          getDoc: async () => ({ doc: doc("uploaded"), agreement: null }),
          sleep: noWait,
        },
        (s) => states.push(s),
      );
      expect(states.at(-1)).toMatchObject({ phase: "failed", reason: `Server says no ${status}.` });
    }
  });

  it("does not poll when the byte upload fails", async () => {
    const getDoc = vi.fn();
    const states: UploadState[] = [];
    await uploadOne(
      file,
      {
        announce: async () => ({ docId: "d1", upload }),
        putBytes: async () => {
          throw new ApiError(415, "unsupported_type", "That file does not look like a PDF.");
        },
        getDoc,
        sleep: noWait,
      },
      (s) => states.push(s),
    );
    expect(getDoc).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "failed", reason: "That file does not look like a PDF." });
  });
});

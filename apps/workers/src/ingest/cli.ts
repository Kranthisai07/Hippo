// pnpm ingest:fixture <file>: runs the ingest pipeline on one local file through in-memory stores and prints what
// happened. Fixture mode unless HIPPO_LIVE_AI=1 (which costs money and needs K's written permission). It prints
// field names and pages only: never document text, quotes or values.
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createMemoryRepository } from "core/src/repository";
import { createMemoryObjectStore } from "../../../api/src/api/storage";
import { createMemoryIndexSource } from "../../../api/src/mcp/indexCache";
import { createPipelineIngest } from "./index";

const pageOf = (ref: unknown): number[] => {
  if (Array.isArray(ref)) return ref.flatMap(pageOf);
  if (ref && typeof ref === "object") {
    const r = ref as Record<string, unknown>;
    return typeof r.page === "number" ? [r.page] : Object.values(r).flatMap(pageOf);
  }
  return [];
};

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: pnpm ingest:fixture <file>   (for example fixtures/docs/lease.pdf)");
    return 2;
  }
  // pnpm runs this from apps/workers; INIT_CWD is where the person typed the command.
  const bytes = new Uint8Array(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file)));
  const hh = "hh_cli";
  const docId = "doc_cli";
  const repo = createMemoryRepository();
  const objectStore = createMemoryObjectStore();
  const indexStore = createMemoryIndexSource();
  const s3Key = `uploads/${hh}/${docId}/original${extname(file).toLowerCase()}`;
  await objectStore.put(s3Key, bytes);
  await repo.putDoc(hh, {
    id: docId,
    s3Key,
    filename: basename(file),
    docType: "other",
    status: "uploaded",
    uploadedAt: new Date().toISOString(),
    assetIds: [],
  });
  // The pipeline logs error class names and field paths only, never document text, so it is safe to show here.
  const ingest = createPipelineIngest(
    { repo, objectStore, indexStore, now: Date.now, log: console.error },
    process.env,
  );
  await ingest({ householdId: hh, docId });

  const doc = await repo.getDoc(hh, docId);
  console.log(`status: ${doc?.status} (${doc?.docType}, ${doc?.pages ?? 0} page(s))`);
  if (doc?.failureReason) console.log(`reason: ${doc.failureReason}`);
  for (const a of await repo.listAgreements(hh, { docId })) {
    for (const [name, status] of Object.entries(a.fieldStatus)) {
      const pages = [...new Set(pageOf(a.sourceRefs[name]))].sort((x, y) => x - y);
      console.log(`  ${name}: ${status}, page ${pages.join(", ")}`);
    }
  }
  return doc?.status === "needs_review" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : "ingest failed");
    process.exit(1);
  },
);

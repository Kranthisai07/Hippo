// A web page saved from the browser extension: the same path as an uploaded file from page text onwards, read by the
// rules. Fields stay `extracted` until a person confirms them. Page text is untrusted and is never written to a log.
import type { Doc } from "core/src/contracts";
import { s3KeysForDoc } from "core/src/repository/shared";
import { extractSubscriptionRules, looksLikeSubscription } from "obligation-kit";
import type { CaptureResult, OnCaptured } from "../../../api/src/api/extension";
import { updateIndex } from "../../../api/src/api/fixtureIngest";
import { createPagesIngest, type PagesDeps } from "./pagesIngest";
import { reasonFor } from "./reasons";
import { createRuleExtractor } from "./ruleExtractor";

export function createCaptureIngest(base: Omit<PagesDeps, "extractor">): OnCaptured {
  const { repo, objectStore } = base;
  const log = base.log ?? (() => undefined);

  /** The steps of the delete route, in its order: a failure can stop at any point of the ingest. */
  async function removePartial(hh: string, doc: Doc): Promise<void> {
    const chunkMeta = await repo.getChunkMeta(hh, doc.id);
    await objectStore.delete(s3KeysForDoc(hh, doc, chunkMeta?.s3Key));
    // A broken index must not keep the agreement alive, or a retry would be called a duplicate.
    const indexError = await updateIndex(base.indexStore, hh, { removeDocId: doc.id }).then(
      () => null,
      (e: unknown) => e ?? new Error("index"),
    );
    const { s3Keys } = await repo.deleteDocumentCascade(hh, doc.id);
    await objectStore.delete(s3Keys);
    if (indexError) throw indexError;
  }

  return async ({ householdId: hh, doc, text, host }): Promise<CaptureResult> => {
    const found = extractSubscriptionRules(text, { host });
    // No subscription means nothing to confirm, so the page could never become an answer. It is not kept at all.
    if (!looksLikeSubscription(found)) return { status: "none" };
    const vendor = found.vendor?.value.toLowerCase();
    if (vendor) {
      const same = (await repo.listAgreements(hh)).find(
        (a) => a.kind === "subscription" && a.party?.toLowerCase() === vendor,
      );
      if (same) return { status: "duplicate", docId: same.docId ?? null };
    }
    await repo.putDoc(hh, { ...doc, status: "extracting" });
    const ingestPages = createPagesIngest({ ...base, extractor: createRuleExtractor({ host }) });
    try {
      await objectStore.put(doc.s3Key, new TextEncoder().encode(text));
      await ingestPages(hh, { ...doc, status: "extracting" }, [{ number: 1, text, ocrDone: false }]);
      return { status: "saved" };
    } catch (e) {
      log(`capture ${doc.id}: failed (${e instanceof Error ? e.name : "unknown"})`);
      await removePartial(hh, doc).catch(async () => {
        // The cleanup failed too. The document stays, marked failed, so a person can still delete it and a retry can run.
        await repo.putDoc(hh, { ...doc, status: "failed", failureReason: reasonFor(e) }).catch(() => undefined);
      });
      return { status: "failed" };
    }
  };
}

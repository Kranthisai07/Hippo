import { UiShowClauseInput } from "core/src/contracts";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { docNameOf, friendlyDocName, quote } from "../format";
import { fail, ok } from "../result";

export const description =
  "Card button: shows the quoted clauses on one page of one document. Called by the card, not by the model.";

export const uiShowClause: ToolHandler<z.infer<typeof UiShowClauseInput>> = async (ctx, args) => {
  const { householdId: hh, repo } = ctx;
  const doc = await repo.getDoc(hh, args.doc_id);
  const index = doc ? await ctx.indexes.get(repo, hh) : null;
  const chunks = index
    ? [...index.chunks.values()]
        .filter((c) => c.docId === args.doc_id && c.page === args.page)
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  if (!doc || chunks.length === 0) {
    return { ...fail("I could not find that page."), structuredContent: { kind: "not_found", what: "clause" } };
  }
  const name = docNameOf(doc);
  return ok(`Page ${args.page} of ${friendlyDocName(name)}.`, {
    kind: "clause_view",
    docId: doc.id,
    docName: name,
    page: args.page,
    clauses: chunks.slice(0, 20).map((c) => quote(c, name)),
  });
};

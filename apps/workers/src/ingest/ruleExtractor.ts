// The reader with no model, as an Extractor. Works on any text, costs nothing and cannot be steered by what it reads.
import { extractSubscriptionRules, looksLikeSubscription } from "obligation-kit";
import type { Extractor, ExtractorPage } from "./types";

const textOf = (pages: ExtractorPage[]): string => pages.map((p) => p.text).join("\n");

export function createRuleExtractor(hints: { host?: string } = {}): Extractor {
  return {
    classify: async (pages) =>
      looksLikeSubscription(extractSubscriptionRules(textOf(pages), hints)) ? "subscription" : "other",
    extract: async (_kind, pages) => extractSubscriptionRules(textOf(pages), hints),
  };
}

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunkPages, type Chunk } from "../src/retrieval";

const dir = fileURLToPath(new URL("../../../fixtures/expected/pages/", import.meta.url));

export const FIXTURE_DOCS = readdirSync(dir)
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

export function fixtureChunks(stems: string[] = FIXTURE_DOCS): Chunk[] {
  return stems.flatMap((stem) => {
    const j = JSON.parse(readFileSync(`${dir}${stem}.json`, "utf8")) as { pages: string[] };
    return chunkPages(
      stem,
      j.pages.map((text, i) => ({ page: i + 1, text })),
    );
  });
}

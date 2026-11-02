// Writes src/assets/google-g.svg from the official Google "G" kept in packages/auth/src/googleG.ts.
// The markup is copied as is (Google's branding rules ask for it unaltered). Run: node scripts/make-google-g.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../../packages/auth/src/googleG.ts", import.meta.url)), "utf8");
const m = /export const GOOGLE_G = ("(?:[^"\\]|\\.)*");/.exec(src);
if (!m) throw new Error("GOOGLE_G not found in googleG.ts");
const svg = JSON.parse(m[1]);
if (!svg.startsWith("<svg") || !svg.includes('viewBox="10 10 20 20"')) throw new Error("unexpected G markup");
writeFileSync(fileURLToPath(new URL("../src/assets/google-g.svg", import.meta.url)), svg + "\n");
console.log("wrote src/assets/google-g.svg", svg.length, "bytes");

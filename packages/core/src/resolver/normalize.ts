// Turns free text (a voice query, an asset name) into comparable tokens. Deterministic, no LLM.

const STOP = new Set([
  "my", "the", "a", "an", "our", "your", "of", "for", "to", "is", "in", "on", "at", "and", "please",
  "about", "with", "this", "that", "it", "i", "what", "whats", "does", "do", "are", "am", "have",
  // Question and problem words, so "my dishwasher is leaking" resolves to the dishwasher. "can" stays: trash can is an asset.
  "say", "says", "tell", "me", "you", "how", "when", "show", "know", "any", "there",
  "leak", "leaks", "leaking", "broken", "broke", "stopped", "working", "work", "fix", "repair", "covered", "cover",
]);

/** Multi-word and variant spellings folded to one canonical token. Applied before tokenizing. Order matters. */
const PHRASES: [RegExp, string][] = [
  [/\bdish washer\b/g, "dishwasher"],
  [/\bwashing machine\b/g, "washer"],
  [/\b(clothes|cloth) dryer\b/g, "dryer"],
  [/\b(refrigerator|fridge|icebox)\b/g, "fridge"],
  [/\b(television|tv|telly)\b/g, "tv"],
  [/\b(air conditioner|air conditioning|aircon|a c)\b/g, "ac"],
  [/\b(cell phone|cellphone|mobile phone|smartphone|iphone)\b/g, "phone"],
  [/\b(automobile|vehicle|auto)\b/g, "car"],
  [/\b(hot water tank|water heater)\b/g, "waterheater"], // before the heater synonym below
  [/\b(furnace|heater|heating|hvac)\b/g, "furnace"],
  [/\b(garbage disposal|disposal)\b/g, "disposal"],
  [/\b(smoke detector|smoke alarm)\b/g, "smokedetector"],
  [/\b(sofa|couch)\b/g, "couch"],
  [/\b(tyre|tyres)\b/g, "tire"],
  [/\b(laptop computer|notebook)\b/g, "laptop"],
  [/\b(service plan|maintenance plan)\b/g, "serviceplan"],
  [/\b(rental agreement|rental contract)\b/g, "lease"],
];

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokens(text: string): string[] {
  // A short piece beside a hyphen is a model name (CR-V, F-150), so join it. dish-washer and water-filter stay apart.
  let s = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\b([a-z]{1,2})-([a-z0-9]{1,4})\b/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

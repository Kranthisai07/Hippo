/** The id Chrome gives apps/extension, fixed by the public key in its manifest. Local servers trust it by default. */
export const DEV_EXTENSION_ID = "gcanedelajoahpaoeeonbdlieoepcobc";

/** What a production server must not run with. Returns every problem, so one start attempt shows them all. */
export function productionProblems(
  env: Record<string, string | undefined>,
  opts: { durable: boolean; mailer: boolean },
): string[] {
  const out: string[] = [];
  const key = env.HIPPO_SIGNING_KEY ?? "";
  if (key.length < 32)
    out.push("HIPPO_SIGNING_KEY must be set to at least 32 characters, or tokens die on every restart.");
  if (!env.HIPPO_ISSUER?.startsWith("https://")) out.push("HIPPO_ISSUER must be the public https address.");
  if (env.HIPPO_DEMO !== "0") out.push("HIPPO_DEMO must be 0: the demo login has no real secret behind it.");
  if (!env.HIPPO_EXTENSION_ID) out.push("HIPPO_EXTENSION_ID must be the Chrome Web Store id of the extension.");
  if (!env.HIPPO_CLIENT_IP_HEADER)
    out.push("HIPPO_CLIENT_IP_HEADER must name the header the proxy sets (cf-connecting-ip).");
  const origins = env.HIPPO_ALLOWED_ORIGINS;
  if (!origins) out.push("HIPPO_ALLOWED_ORIGINS must list the web app origin.");
  else if (/localhost|127\.0\.0\.1|\*/.test(origins))
    out.push("HIPPO_ALLOWED_ORIGINS must hold no localhost and no wildcard.");
  if (env.HIPPO_LIVE_AI === "1" && !env.HIPPO_SERVICE_CLIENT_SECRET)
    out.push("HIPPO_SERVICE_CLIENT_SECRET is required with HIPPO_LIVE_AI.");
  if (!opts.mailer) out.push("No mailer is set, so nobody can sign in by email. A demo login must not be the way in.");
  if (!opts.durable) out.push("The repository and auth store are in memory. Production needs durable ones.");
  return out;
}

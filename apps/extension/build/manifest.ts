// The manifest of a build, made from manifest.template.json. Pure: no file access, so every rule here has a unit test.
//
// Two builds. `dev` is what loading the unpacked folder has always been: the local API as the one host, and the development
// public key that fixes the extension id local servers trust. `store` is what goes to the Chrome Web Store: the production
// address as the only host, no development key, and a build that stops if an address is not a clean https origin, so a
// store package can never carry a localhost or a wildcard.

export type Mode = "dev" | "store";

export interface Manifest {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  key?: string;
  host_permissions: string[];
  permissions: string[];
  [other: string]: unknown;
}

export interface Target {
  mode: Mode;
  /** From package.json. The only place a version is written. */
  version: string;
  /** Store builds: where the API is (an origin, no path). */
  apiOrigin?: string;
  /** Store builds: where the web app is. The extension only opens pages there, so it gets no host permission. */
  webOrigin?: string;
  /**
   * Store builds, optional: the public key the Chrome Web Store dashboard gives, which keeps the extension id the same
   * across uploads. Left out, the id is the one the store assigns.
   */
  publicKey?: string;
}

/** Chrome's rule: one to four dot separated whole numbers, each at most 65535, none with a leading zero. */
export const isChromeVersion = (v: string): boolean =>
  /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(v) && v.split(".").every((n) => Number(n) <= 65535);

/** Why an address cannot go in a store build, or null. Names the setting, never echoes anything else. */
export function originProblem(setting: string, value: string | undefined): string | null {
  if (!value) return `${setting} must be set for a store build.`;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `${setting} is not an address.`;
  }
  if (u.protocol !== "https:") return `${setting} must be an https address.`;
  if (u.username || u.password) return `${setting} must not hold a user name or password.`;
  if (/[*]/.test(value)) return `${setting} must not hold a wildcard.`;
  if (u.pathname !== "/" || u.search || u.hash)
    return `${setting} must be an origin only, with no path, query or fragment.`;
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".localhost") || /^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) {
    return `${setting} must be a public host name, not localhost or an IP address.`;
  }
  return null;
}

export function buildManifest(template: Record<string, unknown>, t: Target): Manifest {
  if (!isChromeVersion(t.version))
    throw new Error(`version "${t.version}" is not a Chrome extension version (for example 0.1.0).`);
  const base = { ...template } as Manifest;
  base.version = t.version;
  if (t.mode === "dev") return base;

  const problems = [originProblem("VITE_HIPPO_API", t.apiOrigin), originProblem("VITE_HIPPO_WEB", t.webOrigin)].filter(
    (p): p is string => p !== null,
  );
  if (t.publicKey !== undefined && !/^[A-Za-z0-9+/]{100,}={0,2}$/.test(t.publicKey)) {
    problems.push("VITE_HIPPO_PUBLIC_KEY is not a base64 public key.");
  }
  if (problems.length > 0) throw new Error(`Store build refused:\n- ${problems.join("\n- ")}`);

  const { key: _devKey, ...rest } = base;
  return {
    ...rest,
    ...(t.publicKey ? { key: t.publicKey } : {}),
    host_permissions: [`${new URL(t.apiOrigin!).origin}/*`],
  };
}

/** Words that must not be anywhere in a store package. Checked on the built files, not just the manifest. */
export const DEV_ONLY = /localhost|127\.0\.0\.1|\[::1\]/;

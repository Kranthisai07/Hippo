// Keeps the Gmail access token unreadable while a scan is in progress. AES-GCM with a key derived from the server's signing
// key under its own label (so it is not the key tokens are signed with), a fresh random nonce each time, and a tag that makes
// any change to the stored text fail to open. The token lives in the database only until the scan ends, and never longer than
// its own hour. Workers clean: Web Crypto only.

const enc = new TextEncoder();
const b64 = (u8: Uint8Array): string => {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface TokenBox {
  /** The token as text that is safe to store. */
  seal(token: string): Promise<string>;
  /** The token, or null for text that was changed, made with another key, or is not ours. */
  open(sealed: string): Promise<string | null>;
}

export function createTokenBox(signingKey: string): TokenBox {
  const key = (async () => {
    const root = await crypto.subtle.importKey(
      "raw",
      enc.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const derived = await crypto.subtle.sign("HMAC", root, enc.encode("hippo gmail import token v1"));
    return crypto.subtle.importKey("raw", derived, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  return {
    async seal(token) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, enc.encode(token)));
      return `v1.${b64(iv)}.${b64(ct)}`;
    },
    async open(sealed) {
      const [v, iv, ct, extra] = sealed.split(".");
      if (v !== "v1" || !iv || !ct || extra !== undefined || sealed.length > 8192) return null;
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key, unb64(ct));
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
  };
}

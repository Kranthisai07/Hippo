// Web Crypto only. No other crypto library.
const enc = new TextEncoder();

export type RandomBytes = (n: number) => Uint8Array;

export const defaultRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export async function sha256b64url(input: string): Promise<string> {
  return b64url(await sha256(input));
}

// Hash both sides first so the comparison is constant time and length independent.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}

export function token(random: RandomBytes, bytes = 32): string {
  return b64url(random(bytes));
}

// Uniform 6 digit code without modulo bias.
export function sixDigits(random: RandomBytes): string {
  for (;;) {
    const b = random(4);
    const n = ((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0);
    const u = n >>> 0;
    if (u < 4_294_000_000) return String(u % 1_000_000).padStart(6, "0");
  }
}

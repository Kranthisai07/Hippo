import { API_ORIGIN } from "./config";
import { ask } from "./messages";
import type { PageRead } from "./page";

export interface Subscription {
  agreementId: string;
  docId: string | null;
  vendor: string;
  plan: string | null;
  amount: number | null;
  cycle: string | null;
  nextChargeDate: string | null;
  confirmed: boolean;
  source: { docName: string; page: number | null } | null;
}

export type SaveResult =
  | { kind: "saved"; reviewUrl: string }
  | { kind: "none" }
  | { kind: "duplicate"; message: string; reviewUrl: string | null };

export class SignedOut extends Error {}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = await ask({ type: "token" });
  if (!token) throw new SignedOut("Please sign in again.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_ORIGIN}${path}`, { ...init, headers });
  if (res.status === 401) throw new SignedOut("Please sign in again.");
  return res;
}

const messageOf = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "Hippo could not do that. Please try again.";
};

export async function listSubscriptions(): Promise<{ subscriptions: Subscription[]; monthlyTotal: number }> {
  const res = await call("/ext/subscriptions");
  if (!res.ok) throw new Error(await messageOf(res));
  return (await res.json()) as { subscriptions: Subscription[]; monthlyTotal: number };
}

export async function savePage(page: PageRead): Promise<SaveResult> {
  const res = await call("/ext/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(page),
  });
  if (res.status === 409) {
    const docId = res.headers.get("x-hippo-doc");
    return { kind: "duplicate", message: await messageOf(res), reviewUrl: docId ? `/review/${docId}` : null };
  }
  if (!res.ok) throw new Error(await messageOf(res));
  const body = (await res.json()) as { saved: boolean; reviewUrl?: string };
  return body.saved && body.reviewUrl ? { kind: "saved", reviewUrl: body.reviewUrl } : { kind: "none" };
}

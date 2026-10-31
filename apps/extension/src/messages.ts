/** What the popup asks the service worker. The popup never holds a refresh token. */
export type Request = { type: "signIn" } | { type: "signOut" } | { type: "status" } | { type: "token" };

export type Reply = { ok: true; signedIn: boolean; token?: string | null } | { ok: false; error: string };

export async function ask(request: Request): Promise<Extract<Reply, { ok: true }>> {
  const reply = (await chrome.runtime.sendMessage(request)) as Reply;
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

import { accessToken, isSignedIn, signIn, signOut } from "./auth";
import type { Reply, Request } from "./messages";

async function handle(request: Request): Promise<Reply> {
  switch (request.type) {
    case "signIn":
      await signIn();
      return { ok: true, signedIn: true };
    case "signOut":
      await signOut();
      return { ok: true, signedIn: false };
    case "status":
      return { ok: true, signedIn: await isSignedIn() };
    case "token": {
      const token = await accessToken();
      return { ok: true, signedIn: token !== null, token };
    }
  }
}

chrome.runtime.onMessage.addListener((request: Request, sender, reply: (r: Reply) => void) => {
  // Only this extension's own pages. No web page and no other extension can ask for a token.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  handle(request)
    .then(reply)
    .catch((e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." }));
  return true;
});

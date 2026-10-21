// Where the demo page signs in and which MCP server it calls. Dev defaults match `pnpm dev` and `pnpm dev:web`; a hosted
// build sets VITE_HIPPO_RESOURCE (and, if the page is not served from the registered origin, VITE_HIPPO_REDIRECT_URI).
// The server must register the same redirect (HIPPO_REDIRECT_URIS) and its issuer must make the same resource.
export interface AskEnv {
  DEV?: boolean;
  VITE_HIPPO_CLIENT_ID?: string;
  VITE_HIPPO_REDIRECT_URI?: string;
  VITE_HIPPO_RESOURCE?: string;
}

export function askConfig(env: AskEnv, origin: string) {
  return {
    clientId: env.VITE_HIPPO_CLIENT_ID || "hippo-demo",
    redirectUri: env.VITE_HIPPO_REDIRECT_URI || `${origin}/callback`,
    // In dev the API is on 8787 while the page is on 5173, and the server's resource is its own issuer. Hosted, both share an origin.
    resource: env.VITE_HIPPO_RESOURCE || (env.DEV ? "http://localhost:8787/mcp" : `${origin}/mcp`),
  };
}

// Where this build talks to. A different server also needs its origin in host_permissions: the store build (build:store) sets it from VITE_HIPPO_API, see apps/extension/build/manifest.ts.
export const API_ORIGIN: string = import.meta.env.VITE_HIPPO_API ?? "http://localhost:8787";
export const WEB_ORIGIN: string = import.meta.env.VITE_HIPPO_WEB ?? "http://localhost:5173";
export const CLIENT_ID: string = import.meta.env.VITE_HIPPO_CLIENT_ID ?? "hippo-demo";
export const RESOURCE = `${API_ORIGIN}/mcp`;
export const SCOPE = "mcp:tools";

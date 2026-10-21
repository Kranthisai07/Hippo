import { describe, expect, it } from "vitest";
import { askConfig } from "../config";

describe("askConfig", () => {
  it("dev: redirect on the page origin, MCP on the API port", () => {
    expect(askConfig({ DEV: true }, "http://localhost:5173")).toEqual({
      clientId: "hippo-demo",
      redirectUri: "http://localhost:5173/callback",
      resource: "http://localhost:8787/mcp",
    });
  });
  it("hosted: everything on the page origin", () => {
    const c = askConfig({ DEV: false }, "https://hippo.example");
    expect(c.redirectUri).toBe("https://hippo.example/callback");
    expect(c.resource).toBe("https://hippo.example/mcp");
  });
  it("env values win, and empty strings fall back", () => {
    const c = askConfig(
      {
        DEV: false,
        VITE_HIPPO_CLIENT_ID: "c",
        VITE_HIPPO_REDIRECT_URI: "https://a.example/cb",
        VITE_HIPPO_RESOURCE: "https://api.example/mcp",
      },
      "https://hippo.example",
    );
    expect(c).toEqual({ clientId: "c", redirectUri: "https://a.example/cb", resource: "https://api.example/mcp" });
    expect(askConfig({ VITE_HIPPO_RESOURCE: "" }, "https://h.example").resource).toBe("https://h.example/mcp");
  });
});

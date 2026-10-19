import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { getTokens } from "../src/oauthFlow";
import { startServer } from "../src/server";
import { A, B, RESOURCE, callBody, check, connect, makeEnv, rpc, text } from "./helpers";

const sc = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as any;

describe("through the real SDK client: initialize and tools/list", () => {
  it("connects, negotiates a protocol version and lists the twelve tools", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    expect(c.client.getServerVersion()).toMatchObject({ name: "hippo" });
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "whats_coming_up",
      "check_coverage",
      "ask_documents",
      "get_agreement",
      "add_record",
      "log_service",
      "get_history",
      "resolve_alert",
      "undo_last",
      "ui_resolve_alert",
      "ui_show_clause",
      "ui_show_claim_steps",
    ]);
    await c.close();
  });

  it("marks the three card tools app only and leaves the nine model tools visible to the model", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const { tools } = await c.client.listTools();
    const meta = (n: string) => (tools.find((t) => t.name === n)!._meta as any)?.ui?.visibility;
    for (const n of ["ui_resolve_alert", "ui_show_clause", "ui_show_claim_steps"]) expect(meta(n)).toEqual(["app"]);
    for (const t of tools.filter((x) => !x.name.startsWith("ui_"))) expect((t._meta as any)?.ui).toBeUndefined();
    await c.close();
  });

  it("publishes an object schema for every tool, with no householdId anywhere", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const { tools } = await c.client.listTools();
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(JSON.stringify(t.inputSchema).toLowerCase(), t.name).not.toContain("household");
    }
    const check = tools.find((t) => t.name === "check_coverage")!;
    expect(check.inputSchema.required).toEqual(expect.arrayContaining(["asset", "issue"]));
    expect(check.inputSchema.additionalProperties).toBe(false);
    await c.close();
  });

  it("accepts an initialize that asks for protocol version 2025-03-26 and answers with it", async () => {
    const env = await makeEnv();
    const res = await rpc(env, await env.tokenA(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "Alexa+ MCP Client", version: "1" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("hippo");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers an unknown newer protocol version with one it supports", async () => {
    const env = await makeEnv();
    const res = await rpc(env, await env.tokenA(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    });
    const body = (await res.json()) as any;
    expect(["2025-11-25", "2025-06-18", "2025-03-26"]).toContain(body.result.protocolVersion);
  });

  it("works with no session: a tools/call without initialize first", async () => {
    const env = await makeEnv();
    const res = await rpc(env, await env.tokenA(), callBody("whats_coming_up", { window_days: 7 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.structuredContent.kind).toBe("coming_up");
  });
});

describe("through the real SDK client: every tool", () => {
  it("whats_coming_up", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const r = check("whats_coming_up", await c.call("whats_coming_up", { window_days: 30 }));
    const items = sc(r).items as any[];
    expect(items.find((i) => i.type === "cancel_by")).toMatchObject({ dueDate: "2026-10-26" });
    expect(items.find((i) => i.type === "renews")).toMatchObject({ dueDate: "2026-10-30" });
    expect(items.find((i) => i.type === "notice_by")).toMatchObject({ dueDate: "2026-11-01" });
    await c.close();
  });

  it("check_coverage (the hero)", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const r = check("check_coverage", await c.call("check_coverage", { asset: "dishwasher", issue: "leaking" }));
    expect(sc(r).badge).toBe("covered");
    expect(sc(r).exclusionClause).toMatchObject({
      page: 3,
      docName: "warranty_dishwasher.pdf",
      quotedFromDocument: true,
    });
    expect(sc(r).exclusionClause.text).toMatch(/water damage/);
    expect(sc(r).claimSteps).toHaveLength(4);
    expect(sc(r).claimByDate).toBe("2026-11-20");
    expect(text(r).toLowerCase()).toContain("not a claim decision");
    await c.close();
  });

  it("ask_documents", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const r = check(
      "ask_documents",
      await c.call("ask_documents", { question: "how many days notice to leave", about: "lease" }),
    );
    expect(sc(r).found).toBe(true);
    expect(sc(r).clauses[0].docName).toBe("lease.pdf");
    await c.close();
  });

  it("get_agreement", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const r = check("get_agreement", await c.call("get_agreement", { about: "car insurance" }));
    expect(text(r)).toContain("policy ending 4821");
    await c.close();
  });

  it("add_record, log_service, get_history, undo_last", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const added = check(
      "add_record",
      await c.call("add_record", {
        kind: "subscription",
        vendor: "Gym",
        amount: 40,
        cycle: "monthly",
        day_of_month: 5,
      }),
    );
    expect(sc(added).created).toBe(true);
    const logged = check("log_service", await c.call("log_service", { asset: "car", action: "oil change" }));
    expect(sc(logged).assetId).toBe("A-car");
    const history = check("get_history", await c.call("get_history", { asset: "car" }));
    expect(sc(history).events).toHaveLength(1);
    const undone = check("undo_last", await c.call("undo_last", {}));
    expect(sc(undone).undone).toBe(true);
    expect((await env.repo.listEvents(A, "A-car", 5)).length).toBe(0);
    expect(await env.repo.getAgreement(A, sc(added).id)).not.toBeNull();
    await c.close();
  });

  it("resolve_alert", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const r = check(
      "resolve_alert",
      await c.call("resolve_alert", { alert_id: "alert-recall-26530", action: "not_mine" }),
    );
    expect(sc(r)).toMatchObject({ status: "dismissed", suppressed: true });
    await c.close();
  });

  it("the three card tools", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const clause = check(
      "ui_show_clause",
      await c.call("ui_show_clause", { doc_id: "doc-warranty_dishwasher", page: 3 }),
    );
    expect(sc(clause).kind).toBe("clause_view");
    const steps = check(
      "ui_show_claim_steps",
      await c.call("ui_show_claim_steps", { agreement_id: "agr-warranty_dishwasher" }),
    );
    expect(sc(steps).steps).toHaveLength(4);
    const resolved = check(
      "ui_resolve_alert",
      await c.call("ui_resolve_alert", { alert_id: "alert-agr-lease:notice_by:2026-11-01", action: "snooze_7d" }),
    );
    expect(sc(resolved).status).toBe("snoozed");
    await c.close();
  });
});

describe("the demo script through the real SDK client", () => {
  it("the first answer carries the one proactive sentence and the second does not", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const first = check("check_coverage", await c.call("check_coverage", { asset: "dishwasher", issue: "leaking" }));
    expect(text(first).startsWith("Before that, your car insurance renews in 9 days. ")).toBe(true);
    expect(sc(first).proactive.alertId).toBe("alert-agr-insurance_auto:renews:2026-10-30");
    const second = check("whats_coming_up", await c.call("whats_coming_up", {}));
    expect(text(second)).not.toContain("Before that");
    expect(sc(second).proactive).toBeUndefined();
    const third = check("get_agreement", await c.call("get_agreement", { about: "lease" }));
    expect(text(third)).not.toContain("Before that");
    await c.close();
  });

  it("a second client of the same household does not hear it again", async () => {
    const env = await makeEnv();
    const token = await env.tokenA();
    const one = await connect(env, token);
    await one.call("get_history", { asset: "car" });
    const two = await connect(env, token);
    const r = await two.call("get_history", { asset: "car" });
    expect(text(r)).not.toContain("Before that");
    await one.close();
    await two.close();
  });

  it("never speaks on resolve_alert or undo_last, and leaves the alert for the next real answer", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const resolved = await c.call("resolve_alert", { alert_id: "alert-recall-26530", action: "dismiss" });
    expect(text(resolved)).not.toContain("Before that");
    expect(sc(resolved).proactive).toBeUndefined();
    const undone = await c.call("undo_last", {});
    expect(text(undone)).not.toContain("Before that");
    const ui = await c.call("ui_resolve_alert", { alert_id: "alert-recall-26V332000", action: "dismiss" });
    expect(text(ui)).not.toContain("Before that");
    expect((await env.repo.getAlert(A, "alert-agr-insurance_auto:renews:2026-10-30"))!.status).toBe("pending");
    const next = await c.call("check_coverage", { asset: "dishwasher", issue: "leaking" });
    expect(text(next).startsWith("Before that, your car insurance renews in 9 days.")).toBe(true);
    await c.close();
  });

  it("speaks again on the next day", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    await c.call("get_history", { asset: "car" });
    env.clock.t += 24 * 3600 * 1000;
    await c.close();
    const c2 = await connect(env, await env.tokenA());
    const r = await c2.call("get_history", { asset: "car" });
    expect(text(r)).toContain("Before that, your lease notice deadline is in 10 days.");
    await c2.close();
  });
});

describe("household scope through HTTP", () => {
  it("household B sees only its own data", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenB());
    const up = check("whats_coming_up", await c.call("whats_coming_up", {}));
    expect((sc(up).items as any[]).map((i) => i.label)).toEqual([
      "Orbit Streaming cancel-by date",
      "Orbit Streaming next charge",
    ]);
    const dish = check("check_coverage", await c.call("check_coverage", { asset: "dishwasher", issue: "leaking" }));
    expect(sc(dish).kind).toBe("not_found");
    const lease = check("get_agreement", await c.call("get_agreement", { about: "lease" }));
    expect(sc(lease).kind).toBe("not_found");
    const docs = check(
      "ask_documents",
      await c.call("ask_documents", { question: "water damage improper installation" }),
    );
    expect(sc(docs).found).toBe(false);
    const alert = await c.call("resolve_alert", {
      alert_id: "alert-agr-insurance_auto:renews:2026-10-30",
      action: "dismiss",
    });
    expect(alert.isError).toBe(true);
    const clause = await c.call("ui_show_clause", { doc_id: "doc-warranty_dishwasher", page: 3 });
    expect(clause.isError).toBe(true);
    await c.close();
    expect((await env.repo.getAlert(A, "alert-agr-insurance_auto:renews:2026-10-30"))!.status).toBe("pending");
  });

  it("household A cannot see household B's data", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const telescope = check(
      "check_coverage",
      await c.call("check_coverage", { asset: "telescope", issue: "cracked lens" }),
    );
    expect(sc(telescope).kind).toBe("not_found");
    const orbit = check("get_agreement", await c.call("get_agreement", { about: "orbit" }));
    expect(sc(orbit).kind).toBe("not_found");
    expect(JSON.stringify(await c.call("whats_coming_up", { window_days: 90 }))).not.toContain("Orbit");
    await c.close();
  });

  it("a write by one household is invisible to the other", async () => {
    const env = await makeEnv();
    const a = await connect(env, await env.tokenA());
    const b = await connect(env, await env.tokenB());
    await a.call("add_record", { kind: "asset", name: "Secret boat" });
    const found = await b.call("get_history", { asset: "boat" });
    expect(sc(found).kind).toBe("not_found");
    expect((await env.repo.listAssets(B)).some((x) => x.name === "Secret boat")).toBe(false);
    await a.close();
    await b.close();
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("over a real socket", () => {
  it("the local server starts, signs in the demo user and answers the hero question", async () => {
    const port = await freePort();
    const lines: string[] = [];
    const server = await startServer({
      port,
      env: { HIPPO_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789" },
      log: (l) => lines.push(l),
    });
    try {
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
      const tokens = await getTokens({
        base: server.url,
        clientId: server.clientId,
        redirectUri: server.redirectUri,
        resource: server.mcpUrl,
      });
      expect(tokens.refreshToken).toBeTruthy();
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "socket-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
        }),
      );
      const r = (await client.callTool({
        name: "check_coverage",
        arguments: { asset: "dishwasher", issue: "leaking" },
      })) as any;
      expect(r.structuredContent.badge).toBe("covered");
      expect(r.content[0].text).toContain("Before that, your car insurance renews in 9 days.");
      await client.close();
      const noToken = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: "{}",
      });
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get("www-authenticate")).toBeNull();
      expect(lines.join("\n")).not.toContain("test-signing-key");
    } finally {
      await server.close();
    }
  });

  it("generates a signing key when none is set and says so without printing it", async () => {
    const port = await freePort();
    const lines: string[] = [];
    const server = await startServer({ port, env: {}, log: (l) => lines.push(l) });
    try {
      const joined = lines.join("\n");
      expect(joined).toContain("random signing key was generated");
      expect(joined).toContain("demo date 2026-10-21");
      const tokens = await getTokens({
        base: server.url,
        clientId: server.clientId,
        redirectUri: server.redirectUri,
        resource: server.mcpUrl,
      });
      expect(tokens.accessToken.split(".")).toHaveLength(3);
      for (const l of lines) expect(l).not.toContain(tokens.accessToken);
    } finally {
      await server.close();
    }
  });

  it("serves the app from @hono/node-server on a random port too", async () => {
    const env = await makeEnv();
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: env.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
    expect(RESOURCE).toContain("/mcp");
  });
});

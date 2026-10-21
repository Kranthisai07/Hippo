import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSesSender, resolveSesSender } from "../src/daily/ses";
import { UsageError } from "../src/daily/options";
import { A, makeWorld } from "./helpers";

const T0 = Date.parse("2026-10-20T08:00:00Z");
const mail = { to: "demo@example.com", subject: "Hippo: 2 things coming up", text: "plain é", html: "<p>html é</p>" };

class Err extends Error {
  $metadata: { httpStatusCode?: number };
  constructor(name: string, message: string, status?: number) {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode: status };
  }
}

function rig(over: { fail?: (n: number) => unknown; maxPerDay?: number } = {}) {
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const commands: { input: Record<string, any> }[] = [];
  const times: number[] = [];
  const client = {
    send: async (c: { input: Record<string, any> }) => {
      commands.push(c);
      times.push(clock.t);
      const e = over.fail?.(commands.length);
      if (e) throw e;
      return {};
    },
  };
  const sender = createSesSender({
    client,
    from: "digest@hippo.example",
    sleep: async (ms) => {
      sleeps.push(ms);
      // Advance after a tick so a concurrent caller reserving in the same tick sees the clock unchanged, like real time.
      const wake = clock.t + ms;
      await Promise.resolve();
      clock.t = Math.max(clock.t, wake);
    },
    now: () => clock.t,
    maxPerDay: over.maxPerDay,
  });
  return { sender, commands, sleeps, clock, times };
}

describe("command", () => {
  it("builds a UTF-8 plain and HTML message", async () => {
    const r = rig();
    await r.sender.send(mail);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]!.input).toEqual({
      FromEmailAddress: "digest@hippo.example",
      Destination: { ToAddresses: ["demo@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: "UTF-8" },
          Body: { Text: { Data: mail.text, Charset: "UTF-8" }, Html: { Data: mail.html, Charset: "UTF-8" } },
        },
      },
    });
  });
});

describe("header injection", () => {
  const bad = [
    "a@b.com\r\nBcc: x@y.com",
    "a@b.com\nBcc: x@y.com",
    "a@b.com,x@y.com",
    "a@b.com;x@y.com",
    "a@b.com x@y.com",
    "x@y.com a@b.com",
    "Name <a@b.com>",
    "<a@b.com>",
    '"Mallory" <a@b.com>',
    " a@b.com",
    "a@b.com ",
    "a@b.com\t",
    "a@b.com\u2028",
    "a b@c.com",
    "a@@b.com",
    "a@b",
    "",
    "a@b.com@c.com",
  ];
  it.each(bad)("rejects %j as a recipient before any client call", async (to) => {
    const r = rig();
    await expect(r.sender.send({ ...mail, to })).rejects.toThrow();
    expect(r.commands).toHaveLength(0);
  });

  it.each(bad)("rejects %j as the sender at construction", (from) => {
    expect(() =>
      createSesSender({ client: { send: async () => ({}) }, from, sleep: async () => {}, now: () => 0 }),
    ).toThrow();
  });

  it.each(["hi\r\nBcc: x@y.com", "hi\nthere", "hi\rthere", "", "x".repeat(201)])(
    "rejects subject %j",
    async (subject) => {
      const r = rig();
      await expect(r.sender.send({ ...mail, subject })).rejects.toThrow();
      expect(r.commands).toHaveLength(0);
    },
  );

  it("accepts a 200 character subject and refuses an empty body", async () => {
    const r = rig();
    await r.sender.send({ ...mail, subject: "x".repeat(200) });
    await expect(r.sender.send({ ...mail, text: "" })).rejects.toThrow();
    await expect(r.sender.send({ ...mail, html: "   " })).rejects.toThrow();
    expect(r.commands).toHaveLength(1);
  });

  it("validation errors never contain the input", async () => {
    const r = rig();
    const e = await r.sender.send({ ...mail, to: "secret@evil.com,b@c.com" }).catch((x) => x);
    expect(String(e.message)).not.toContain("secret");
    expect(String(e.message)).not.toContain("evil");
  });
});

describe("pacing", () => {
  it("spaces sequential sends one second apart", async () => {
    const r = rig();
    await r.sender.send(mail);
    await r.sender.send(mail);
    expect(r.sleeps).toEqual([1000]);
  });

  it("queues concurrent calls one second apart", async () => {
    const r = rig();
    await Promise.all([r.sender.send(mail), r.sender.send(mail), r.sender.send(mail)]);
    expect(r.sleeps.slice().sort((a, b) => a - b)).toEqual([1000, 2000]);
    expect(r.commands).toHaveLength(3);
  });
});

describe("daily cap", () => {
  it("throws on the 201st message and does not call the client", async () => {
    const r = rig();
    for (let i = 0; i < 200; i++) await r.sender.send(mail);
    const e = await r.sender.send(mail).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SesDailyCapExceeded");
    expect(r.commands).toHaveLength(200);
  });

  it("frees a slot once 24 hours have passed", async () => {
    const r = rig({ maxPerDay: 2 });
    await r.sender.send(mail);
    await r.sender.send(mail);
    await expect(r.sender.send(mail)).rejects.toThrow();
    r.clock.t += 86_400_000;
    await r.sender.send(mail);
    expect(r.commands).toHaveLength(3);
  });
});

describe("errors", () => {
  const leak = new Err("MessageRejected", "Email address is not verified: demo@example.com Hippo: 2 things", 400);

  it("a permanent rejection is thrown once, with only the class name", async () => {
    const r = rig({ fail: () => leak });
    const e = await r.sender.send(mail).catch((x) => x);
    expect(e.name).toBe("MessageRejected");
    expect(e.message).not.toContain("demo@example.com");
    expect(e.message).not.toContain("Hippo");
    expect(e.message).not.toContain("verified");
    expect(r.commands).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it.each([
    "BadRequestException",
    "NotFoundException",
    "SendingPausedException",
    "AccountSuspendedException",
    "LimitExceededException",
    "MailFromDomainNotVerifiedException",
  ])("does not retry %s", async (name) => {
    const r = rig({ fail: () => new Err(name, "demo@example.com", 400) });
    await expect(r.sender.send(mail)).rejects.toMatchObject({ name });
    expect(r.commands).toHaveLength(1);
  });

  it("retries throttling at most twice with backoff, then fails with the class name", async () => {
    const r = rig({ fail: () => new Err("TooManyRequestsException", "demo@example.com", 429) });
    const e = await r.sender.send(mail).catch((x) => x);
    expect(e.name).toBe("TooManyRequestsException");
    expect(e.message).not.toContain("demo");
    expect(r.commands).toHaveLength(3);
    expect(r.sleeps).toContain(500);
    expect(r.sleeps).toContain(1000);
  });

  it("recovers when a retry succeeds, and a 5xx counts as retryable", async () => {
    const r = rig({ fail: (n) => (n < 3 ? new Err("InternalServiceErrorException", "x", 500) : undefined) });
    await r.sender.send(mail);
    expect(r.commands).toHaveLength(3);
  });

  it("a non-error throw and an odd error name map to fixed phrases", async () => {
    const a = rig({ fail: () => "demo@example.com" });
    const e1 = await a.sender.send(mail).catch((x) => x);
    expect(e1.message).toBe("SesError");
    const b = rig({ fail: () => new Err("demo@example.com", "m", 400) });
    const e2 = await b.sender.send(mail).catch((x) => x);
    expect(e2.message).toBe("SesError");
  });
});

describe("runDigest through the SES sender", () => {
  it("a failed send marks nothing emailed; a successful send marks exactly alertIds", async () => {
    const fake = rig({ fail: (n) => (n === 1 ? new Err("MessageRejected", "demo@example.com", 400) : undefined) });
    const w = await makeWorld();
    const r1 = await w.run(undefined, { sender: fake.sender });
    expect(r1.households[0]!.email).toMatchObject({ status: "failed", reason: "send failed (MessageRejected)" });
    expect((await w.repo.listAlerts(A)).filter((a) => a.emailedAt)).toHaveLength(0);

    const r2 = await w.run(undefined, { sender: fake.sender });
    const email = r2.households[0]!.email as { status: string; alertIds: string[] };
    expect(email.status).toBe("sent");
    const marked = (await w.repo.listAlerts(A)).filter((a) => a.emailedAt).map((a) => a.id);
    expect(marked.sort()).toEqual([...email.alertIds].sort());
    expect(fake.commands[1]!.input.Destination.ToAddresses).toEqual(["demo@example.com"]);
  });
});

describe("resolveSesSender (CLI guard)", () => {
  const env: Record<string, string> = { HIPPO_SES_FROM: "digest@hippo.example", AWS_REGION: "us-east-1" };
  const base = { sendSes: true, yesReally: true, send: false, env, now: () => 0, sleep: async () => {} };
  function guard(over: Partial<typeof base> = {}) {
    const built: string[] = [];
    const warnings: string[] = [];
    const make = (region: string) => {
      built.push(region);
      return { send: async () => ({}) };
    };
    let result: unknown;
    let error: unknown;
    try {
      result = resolveSesSender({ ...base, ...over, makeClient: make, warn: (s) => warnings.push(s) });
    } catch (e) {
      error = e;
    }
    return { built, warnings, result, error };
  }

  it("builds a client only with both flags and the environment, and warns first", () => {
    const g = guard();
    expect(g.built).toEqual(["us-east-1"]);
    expect(g.warnings.join(" ")).toContain("sends real email through SES");
    expect(g.result).toBeDefined();
  });

  it("HIPPO_SES_REGION wins over AWS_REGION", () => {
    expect(guard({ env: { ...env, HIPPO_SES_REGION: "eu-west-1" } }).built).toEqual(["eu-west-1"]);
  });

  it.each([
    ["no flags", { sendSes: false, yesReally: false }],
    ["only --yes-really", { sendSes: false, yesReally: true }],
  ])("%s builds nothing and returns no sender", (_n, over) => {
    const g = guard(over);
    expect(g.built).toEqual([]);
    expect(g.result).toBeUndefined();
    expect(g.error).toBeUndefined();
    expect(g.warnings).toEqual([]);
  });

  it.each([
    ["no --yes-really", { yesReally: false }],
    ["no from", { env: { AWS_REGION: "us-east-1" } }],
    ["no region", { env: { HIPPO_SES_FROM: "digest@hippo.example" } }],
    ["with --send", { send: true }],
    ["a bad from", { env: { ...env, HIPPO_SES_FROM: "a@b.com,c@d.com" } }],
    ["a bad region", { env: { ...env, AWS_REGION: "x;y" } }],
  ])("refuses (%s) and builds nothing", (_n, over) => {
    const g = guard(over as Partial<typeof base>);
    expect(g.error).toBeInstanceOf(UsageError);
    expect(g.built).toEqual([]);
  });
});

describe("the real CLI", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/daily/cli.ts", "--today", "2026-10-21", ...args], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, HIPPO_SES_FROM: "digest@hippo.example", AWS_REGION: "us-east-1" },
    });

  it("--send-ses without --yes-really refuses and sends nothing", () => {
    const r = run(["--send-ses"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--yes-really");
    expect(r.stdout).not.toContain("LIVE SES");
  });

  it("--yes-really alone stays a dry run", () => {
    const r = run(["--yes-really"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("email: dry run");
  });
});

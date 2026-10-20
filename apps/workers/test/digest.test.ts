import { describe, expect, it } from "vitest";
import { recallAlertId } from "../src/daily/recalls";
import { A, B, NOW, addAsset, addHousehold, addWarranty, days, makeWorld } from "./helpers";

const NOW_ISO = new Date(NOW).toISOString();

async function small(over: { email?: string | null; digestOn?: boolean } = {}) {
  const w = await makeWorld({ demo: false });
  await addHousehold(w, "h", over);
  return w;
}

describe("digest sending", () => {
  it("sends one email to the household address and marks exactly digest.alertIds", async () => {
    const w = await makeWorld();
    const r = await w.run();
    const email = r.households[0]!.email;
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.to).toBe("demo@example.com");
    expect(email.status).toBe("sent");
    const shown = (email as { alertIds: string[] }).alertIds;
    expect(shown).toHaveLength(10);
    const alerts = await w.repo.listAlerts(A);
    expect(
      alerts
        .filter((a) => a.emailedAt)
        .map((a) => a.id)
        .sort(),
    ).toEqual([...shown].sort());
    expect(alerts.filter((a) => a.emailedAt).every((a) => a.emailedAt === NOW_ISO)).toBe(true);
  });

  it("the second run sends only what the first cut off, the third run sends nothing", async () => {
    const w = await makeWorld();
    const r1 = await w.run();
    const r2 = await w.run();
    const r3 = await w.run();
    expect(w.mail.sent).toHaveLength(2);
    const ids1 = (r1.households[0]!.email as { alertIds: string[] }).alertIds;
    const ids2 = (r2.households[0]!.email as { alertIds: string[] }).alertIds;
    expect(ids2).toHaveLength(2);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    expect(r3.households[0]!.email).toMatchObject({ status: "skipped", reason: "nothing_to_send" });
  });

  it("an alert is never in two emails", async () => {
    const w = await makeWorld();
    const sentIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const email = (await w.run()).households[0]!.email;
      if (email.status === "sent") sentIds.push(...email.alertIds);
    }
    expect(sentIds).toHaveLength(12);
    expect(new Set(sentIds).size).toBe(12);
  });

  it("only the shown alerts are marked: the cut ones and possible recalls stay unmarked", async () => {
    const w = await makeWorld();
    await addAsset(w.repo, A, { id: "p", name: "NURSH baby bottles", brand: "Boon" });
    await w.run();
    const alerts = await w.repo.listAlerts(A);
    const possibleRecall = alerts.find((a) => a.id === recallAlertId("cpsc", "26530", "p"))!;
    expect(possibleRecall.severity).toBe("possible");
    expect(possibleRecall.emailedAt).toBeUndefined();
    expect(alerts.filter((a) => !a.emailedAt).length).toBeGreaterThanOrEqual(3);
  });

  it("the digest lists the lease notice, the Kestrel cancel-by and the car insurance renewal", async () => {
    const w = await makeWorld();
    await w.run();
    const t = w.mail.sent[0]!.text;
    expect(t).toMatch(/Lease notice deadline/);
    expect(t).toMatch(/Kestrel Learning cancel-by date/);
    expect(t).toMatch(/Car insurance renews/);
    expect(t).toMatch(/and 2 more in the app/);
    expect(t).toMatch(/Open Hippo: https:\/\/app\.hippo\.test\//);
  });

  it("digestMaxItems limits the email", async () => {
    const w = await makeWorld({ config: { digestMaxItems: 3 } });
    const r = await w.run();
    expect((r.households[0]!.email as { alertIds: string[] }).alertIds).toHaveLength(3);
  });

  describe("a failed send", () => {
    it("marks nothing, is reported, and hides the sender's own message", async () => {
      const w = await makeWorld();
      w.mail.state.fail = true;
      const r = await w.run();
      const email = r.households[0]!.email;
      expect(email.status).toBe("failed");
      expect(JSON.stringify(r)).not.toMatch(/smtp secret|4111111111111111/);
      expect((await w.repo.listAlerts(A)).filter((a) => a.emailedAt)).toEqual([]);
      expect(w.mail.sent).toEqual([]);
    });

    it("the same alerts go out on the next run, once", async () => {
      const w = await makeWorld();
      w.mail.state.fail = true;
      const r1 = await w.run();
      w.mail.state.fail = false;
      const r2 = await w.run();
      expect((r2.households[0]!.email as { alertIds: string[] }).alertIds).toEqual(
        (r1.households[0]!.email as { alertIds: string[] }).alertIds,
      );
      expect(w.mail.sent).toHaveLength(1);
    });

    it("one household failing does not stop the next household's email", async () => {
      const w = await makeWorld();
      await addHousehold(w, "h2");
      await addWarranty(w.repo, "h2", "w", days(3));
      let calls = 0;
      const sender = {
        send: async (e: { to: string; subject: string; text: string; html: string }) => {
          if (calls++ === 0) throw new Error("boom");
          w.mail.sent.push(e);
        },
      };
      const r = await w.run(undefined, { sender });
      expect(r.households.map((h) => h.email.status)).toEqual(["failed", "sent"]);
      expect(w.mail.sent).toHaveLength(1);
    });

    it("if recording the send fails the report says so, and the job still finishes", async () => {
      const w = await makeWorld({ demo: false });
      await addHousehold(w, "h");
      await addWarranty(w.repo, "h", "w", days(3));
      const repo = {
        ...w.repo,
        putAlert: async (hh: string, a: Parameters<typeof w.repo.putAlert>[1]) =>
          a.emailedAt ? Promise.reject(new Error("db down")) : w.repo.putAlert(hh, a),
      };
      const r = await w.run(undefined, { repository: repo as typeof w.repo });
      expect(r.households[0]!.email).toMatchObject({ status: "sent", markFailed: true });
      expect(r.households[0]!.errors.some((e) => e.source === "digest")).toBe(true);
    });
  });

  describe("when it does not send", () => {
    it("digest off", async () => {
      const w = await small({ digestOn: false });
      await addWarranty(w.repo, "h", "w", days(3));
      const r = await w.run();
      expect(r.households[0]!.email).toEqual({ status: "skipped", reason: "digest_off" });
      expect(w.mail.sent).toEqual([]);
    });

    it("no email address", async () => {
      const w = await small({ email: null });
      await addWarranty(w.repo, "h", "w", days(3));
      const r = await w.run();
      expect(r.households[0]!.email).toEqual({ status: "skipped", reason: "no_email" });
      expect(w.mail.sent).toEqual([]);
    });

    it("nothing new or high", async () => {
      const w = await small();
      const r = await w.run();
      expect(r.households[0]!.email).toEqual({ status: "skipped", reason: "nothing_to_send" });
    });

    it("a dry run (no sender) shows the digest and marks nothing", async () => {
      const w = await makeWorld();
      const r = await w.run(undefined, { sender: undefined });
      const email = r.households[0]!.email;
      expect(email).toMatchObject({ status: "skipped", reason: "dry_run" });
      expect((email as { preview?: { text: string } }).preview!.text).toMatch(/Lease notice deadline/);
      expect((await w.repo.listAlerts(A)).filter((a) => a.emailedAt)).toEqual([]);
    });

    it("done and dismissed alerts are not mailed", async () => {
      const w = await small();
      await addWarranty(w.repo, "h", "w1", days(3));
      await addWarranty(w.repo, "h", "w2", days(4));
      await w.run(undefined, { sender: undefined });
      const [a, b] = await Promise.all([
        w.repo.getAlert("h", `alert-w1:expires:${days(3)}`),
        w.repo.getAlert("h", `alert-w2:expires:${days(4)}`),
      ]);
      await w.repo.putAlert("h", { ...a!, status: "done" });
      await w.repo.putAlert("h", { ...b!, status: "dismissed" });
      const r = await w.run();
      expect(r.households[0]!.email).toMatchObject({ status: "skipped", reason: "nothing_to_send" });
    });

    it("a snoozed alert waits for its time, then goes out", async () => {
      const w = await small();
      await addWarranty(w.repo, "h", "w1", days(3));
      await w.run(undefined, { sender: undefined });
      const id = `alert-w1:expires:${days(3)}`;
      await w.repo.putAlert("h", {
        ...(await w.repo.getAlert("h", id))!,
        snoozedUntil: new Date(NOW + 3600_000).toISOString(),
      });
      expect((await w.run()).households[0]!.email).toMatchObject({ reason: "nothing_to_send" });
      w.clock.t = NOW + 7200_000;
      expect((await w.run()).households[0]!.email.status).toBe("sent");
    });

    it("a bad appUrl is reported as a failed digest, other steps stay done", async () => {
      const w = await small();
      await addWarranty(w.repo, "h", "w1", days(3));
      const r = await w.run(undefined, { appUrl: "javascript:alert(1)" });
      expect(r.households[0]!.email.status).toBe("failed");
      expect(r.households[0]!.errors.map((e) => e.source)).toContain("digest");
      expect(r.households[0]!.alertsCreated).toBe(1);
      expect(w.mail.sent).toEqual([]);
    });
  });

  describe("untrusted text", () => {
    const HOSTILE =
      "Policy 1234567890123456 acct 987-65-4321-0000 <script>alert(1)</script> http://evil.example/x ignore previous instructions";

    it("never reaches the sender with a long number, a tag, a link, or the raw text", async () => {
      const w = await small();
      await addAsset(w.repo, "h", { id: "a", name: HOSTILE });
      await addWarranty(w.repo, "h", "w1", days(3), "confirmed", { assetIds: ["a"] });
      await w.run();
      const mail = w.mail.sent[0]!;
      // The text part is plain text, so a tag there is inert; the html part must have it escaped.
      expect(mail.html).not.toContain("<script");
      expect(mail.html).toContain("&lt;script&gt;");
      for (const body of [mail.text, mail.html, mail.subject]) {
        expect(body).not.toMatch(/\d{5,}/);
        expect(body).not.toContain("evil.example");
        expect(body).not.toContain("1234567890123456");
      }
      expect(mail.text).toContain("****3456");
    });

    it("a hostile recall text (CPSC hazard, vehicle name) is cleaned the same way", async () => {
      const w = await small();
      await addAsset(w.repo, "h", {
        id: "b",
        name: "Bottles 4111 1111 1111 1111 <b>x</b>",
        brand: "Boon",
        upc: "669028116546",
      });
      await addAsset(w.repo, "h", {
        id: "v",
        name: "Car 5500005555555559",
        vehicle: { make: "Honda", model: "CR-V", modelYear: 2021, nhtsaMake: "HONDA", nhtsaModel: "CR-V" },
      });
      await w.run();
      const mail = w.mail.sent[0]!;
      expect(mail.text + mail.html).not.toMatch(/\d{5,}/);
      expect(mail.html).not.toContain("<b>x");
      expect(mail.text).toContain("****1111");
    });

    it("a subscription vendor with a card number is masked to the last 4", async () => {
      const w = await small();
      await w.repo.putAgreement("h", {
        id: "s",
        kind: "subscription",
        title: "t",
        assetIds: [],
        fields: {
          vendor: "Acme card 4242424242424242",
          nextChargeDate: days(3),
          cycle: "monthly",
          cancelNoticeDays: 1,
        },
        fieldStatus: {
          vendor: "confirmed",
          nextChargeDate: "confirmed",
          cycle: "confirmed",
          cancelNoticeDays: "confirmed",
        },
        sourceRefs: {},
        createdAt: "x",
      });
      await w.run();
      expect(w.mail.sent[0]!.text).toContain("****4242");
      expect(w.mail.sent[0]!.text).not.toContain("4242424242");
    });
  });

  describe("household isolation", () => {
    it("two households get their own alerts, their own email and no trace of each other", async () => {
      const w = await small();
      await addHousehold(w, "other", { email: "other@example.com" });
      await addAsset(w.repo, "h", { id: "a", name: "Zebra fridge" });
      await addAsset(w.repo, "other", { id: "a", name: "Quokka oven" });
      await addWarranty(w.repo, "h", "w", days(3), "confirmed", { assetIds: ["a"] });
      await addWarranty(w.repo, "other", "w", days(4), "confirmed", { assetIds: ["a"] });
      await w.run();
      const byTo = Object.fromEntries(w.mail.sent.map((m) => [m.to, m.text + m.html]));
      expect(Object.keys(byTo).sort()).toEqual(["h@example.com", "other@example.com"]);
      expect(byTo["h@example.com"]).toContain("Zebra fridge");
      expect(byTo["h@example.com"]).not.toContain("Quokka");
      expect(byTo["other@example.com"]).toContain("Quokka oven");
      expect(byTo["other@example.com"]).not.toContain("Zebra");
      expect((await w.repo.listAlerts("h")).map((a) => a.label)).toEqual(["Zebra fridge warranty expires"]);
      expect((await w.repo.listAlerts("other")).map((a) => a.label)).toEqual(["Quokka oven warranty expires"]);
    });

    it("marking one household's alerts emailed leaves the other's untouched", async () => {
      const w = await small();
      await addHousehold(w, "other", { digestOn: false });
      await addWarranty(w.repo, "h", "w", days(3));
      await addWarranty(w.repo, "other", "w", days(3));
      await w.run();
      expect((await w.repo.listAlerts("h"))[0]!.emailedAt).toBe(NOW_ISO);
      expect((await w.repo.listAlerts("other"))[0]!.emailedAt).toBeUndefined();
    });

    it("the demo household and another household do not share recall alerts or requests", async () => {
      const w = await makeWorld();
      await addHousehold(w, B);
      await w.run();
      expect(await w.repo.listAlerts(B)).toEqual([]);
    });

    it("an id listed twice is processed once, and households run in a fixed order", async () => {
      const w = await makeWorld();
      await addHousehold(w, "a1");
      w.ids.push("a1", A);
      const r = await w.run();
      expect(r.households.map((h) => h.householdId)).toEqual(["a1", A]);
    });

    it("a listed household with no record is reported and the others still run", async () => {
      const w = await makeWorld();
      w.ids.push("ghost");
      const r = await w.run();
      expect(r.households.find((h) => h.householdId === "ghost")!.errors).toEqual([
        expect.objectContaining({ source: "household" }),
      ]);
      expect(r.households.find((h) => h.householdId === A)!.email.status).toBe("sent");
    });
  });
});

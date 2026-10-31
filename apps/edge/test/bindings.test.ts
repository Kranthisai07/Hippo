import { describe, expect, it } from "vitest";
import { createCloudflareMailer, type EmailBindingLike } from "../src/cloudflareMailer";
import { createR2IndexStore, createR2ObjectStore } from "../src/r2";
import { fakeBucket } from "./fakes";

describe("the R2 object store", () => {
  it("keeps bytes exactly, gives null for a missing key, and a put replaces", async () => {
    const { bucket } = fakeBucket();
    const store = createR2ObjectStore(bucket);
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 37, 80, 68, 70]);
    await store.put("uploads/hh_a/doc-1/original.pdf", bytes);
    expect(await store.get("uploads/hh_a/doc-1/original.pdf")).toEqual(bytes);
    expect(await store.get("uploads/hh_a/doc-1/missing")).toBeNull();
    await store.put("k", new Uint8Array([1]));
    await store.put("k", new Uint8Array([2, 3]));
    expect(await store.get("k")).toEqual(new Uint8Array([2, 3]));
  });
  it("deletes any number of keys in calls of at most 1000, and a missing key is fine", async () => {
    const { bucket, objects, deleteCalls } = fakeBucket();
    const store = createR2ObjectStore(bucket);
    const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
    for (const k of keys.slice(0, 5)) await store.put(k, new Uint8Array([1]));
    await store.delete(keys);
    expect(deleteCalls).toEqual([1000, 1000, 500]);
    expect(objects.size).toBe(0);
    await store.delete([]);
    expect(deleteCalls).toEqual([1000, 1000, 500]);
  });
});

describe("the R2 index store", () => {
  it("stores one object per household and loads null for a household with none", async () => {
    const { bucket, objects } = fakeBucket();
    const store = createR2IndexStore(bucket);
    expect(await store.load("hh_a")).toBeNull();
    await store.put("hh_a", '{"v":1}');
    await store.put("hh_b", '{"v":2}');
    expect(await store.load("hh_a")).toBe('{"v":1}');
    expect(await store.load("hh_b")).toBe('{"v":2}');
    expect([...objects.keys()].sort()).toEqual(["index/hh_a.json", "index/hh_b.json"]);
  });
  it.each(["../x", "hh_a/../../b", "", "a b", "hh\u0000a"])(
    "refuses %j as a household id, so no key can be steered",
    async (id) => {
      const { bucket, objects } = fakeBucket();
      const store = createR2IndexStore(bucket);
      await expect(store.put(id, "x")).rejects.toThrow(/not usable/);
      await expect(store.load(id)).rejects.toThrow(/not usable/);
      expect(objects.size).toBe(0);
    },
  );
});

describe("the Cloudflare mailer", () => {
  const make = () => {
    const sent: unknown[] = [];
    const binding: EmailBindingLike = {
      async send(message) {
        sent.push(message);
        return { messageId: "m1" };
      },
    };
    return { sent, mailer: createCloudflareMailer(binding, "Hippo <login@hippo.example>") };
  };

  it("sends one plain text message with the code, to that address, from the configured sender", async () => {
    const { sent, mailer } = make();
    await mailer.send("alice@example.com", "123456");
    expect(sent).toHaveLength(1);
    const m = sent[0] as { from: string; to: string; subject: string; text: string; html?: string };
    expect(m.from).toBe("Hippo <login@hippo.example>");
    expect(m.to).toBe("alice@example.com");
    expect(m.subject).toBe("Your Hippo sign in code");
    expect(m.text).toContain("123456");
    expect(m.text).toContain("10 minutes");
    expect(m.html).toBeUndefined();
    expect(Object.keys(m).sort()).toEqual(["from", "subject", "text", "to"]);
  });
  it("lets a provider error out, so the caller can log its name and still answer the same", async () => {
    const mailer = createCloudflareMailer(
      {
        async send() {
          throw Object.assign(new Error("not verified for alice@example.com"), { code: "E_SENDER_NOT_VERIFIED" });
        },
      },
      "login@hippo.example",
    );
    await expect(mailer.send("alice@example.com", "123456")).rejects.toMatchObject({ code: "E_SENDER_NOT_VERIFIED" });
  });
});

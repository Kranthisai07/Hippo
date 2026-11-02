// @vitest-environment node
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildManifest, isChromeVersion, originProblem } from "../build/manifest";
import { zip } from "../build/zip";

const template = {
  manifest_version: 3,
  name: "Hippo",
  description: "d",
  key: "DEVKEY",
  permissions: ["activeTab", "scripting", "identity", "storage"],
  host_permissions: ["http://localhost:8787/*"],
  icons: { "128": "icons/icon-128.png" },
};
const store = {
  mode: "store" as const,
  version: "0.1.0",
  apiOrigin: "https://api.hippo-app.workers.dev",
  webOrigin: "https://api.hippo-app.workers.dev",
  clientId: "hippo-store",
};

describe("the dev manifest", () => {
  it("is the template with the version from package.json, key and local host kept", () => {
    const m = buildManifest(template, { mode: "dev", version: "0.1.0" });
    expect(m).toMatchObject({ version: "0.1.0", key: "DEVKEY", host_permissions: ["http://localhost:8787/*"] });
  });
});

describe("the store manifest", () => {
  it("has the production address as its only host, no development key, and the same permissions", () => {
    const m = buildManifest(template, store);
    expect(m.host_permissions).toEqual(["https://api.hippo-app.workers.dev/*"]);
    expect(m).not.toHaveProperty("key");
    expect(m.permissions).toEqual(template.permissions);
    expect(JSON.stringify(m)).not.toMatch(/localhost|DEVKEY/);
  });

  it("does not change the template it was given", () => {
    buildManifest(template, store);
    expect(template.key).toBe("DEVKEY");
    expect(template.host_permissions).toEqual(["http://localhost:8787/*"]);
  });

  it("keeps the store's own public key when one is given, so the id stays the same across uploads", () => {
    const key = "A".repeat(120);
    expect(buildManifest(template, { ...store, publicKey: key }).key).toBe(key);
  });

  it.each([
    ["http", "http://api.hippo-app.workers.dev"],
    ["localhost", "https://localhost"],
    ["a subdomain of localhost", "https://api.localhost"],
    ["an IP address", "https://203.0.113.5"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["a name with no dot", "https://hippo"],
    ["a wildcard", "https://*.hippo-app.workers.dev"],
    ["a trailing slash, which the built code would turn into //oauth/token", "https://api.hippo-app.workers.dev/"],
    [
      "capital letters, which the manifest would lower case but the code would not",
      "https://API.hippo-app.workers.dev",
    ],
    ["a path", "https://api.hippo-app.workers.dev/app"],
    ["a query", "https://api.hippo-app.workers.dev/?x=1"],
    ["credentials", "https://user:pass@api.hippo-app.workers.dev"],
    ["not an address", "api.hippo-app.workers.dev"],
    ["empty", ""],
  ])("refuses %s as the API address", (_name, bad) => {
    expect(() => buildManifest(template, { ...store, apiOrigin: bad })).toThrow(/VITE_HIPPO_API/);
  });

  it("refuses a bad web address, and says every problem at once", () => {
    expect(() => buildManifest(template, { ...store, webOrigin: "http://localhost:5173" })).toThrow(/VITE_HIPPO_WEB/);
    try {
      buildManifest(template, { mode: "store", version: "0.1.0" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("VITE_HIPPO_API");
      expect((e as Error).message).toContain("VITE_HIPPO_WEB");
    }
  });

  it("refuses a store build with no client id, so it never signs in as the demo client", () => {
    expect(() => buildManifest(template, { ...store, clientId: undefined })).toThrow(/VITE_HIPPO_CLIENT_ID/);
    expect(() => buildManifest(template, { ...store, clientId: "has space" })).toThrow(/VITE_HIPPO_CLIENT_ID/);
  });

  it("refuses a public key that is not base64", () => {
    expect(() => buildManifest(template, { ...store, publicKey: "not a key" })).toThrow(/VITE_HIPPO_PUBLIC_KEY/);
  });

  it("never echoes a value it refuses", () => {
    expect(originProblem("VITE_HIPPO_API", "https://user:secret@x.example")).not.toContain("secret");
  });
});

describe("the version", () => {
  it.each(["0.1.0", "1", "1.2", "65535.0.0.1"])("accepts %s", (v) => expect(isChromeVersion(v)).toBe(true));
  it.each(["", "0.1.0.0.0", "01.2", "65536", "1.-1", "1.0.0-beta", "v1"])("refuses %s", (v) =>
    expect(isChromeVersion(v)).toBe(false),
  );
  it("a build with a version Chrome would reject stops", () => {
    expect(() => buildManifest(template, { mode: "dev", version: "1.0.0-beta" })).toThrow(/version/);
  });
});

/** Reads a zip written by build/zip.ts: names, and the bytes after checking the size and the crc. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const data = inflateRawSync(buf.subarray(local + 30 + lnlen, local + 30 + lnlen + csize));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

describe("the zip writer", () => {
  const files = [
    { name: "popup.js", data: Buffer.from("console.log(1);".repeat(50)) },
    { name: "icons/icon-128.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
    { name: "manifest.json", data: Buffer.from('{"a":"é"}') },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];

  it("round trips every file byte for byte, including an empty one and a non ASCII one", () => {
    const back = unzip(zip(files));
    expect([...back.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) expect(back.get(f.name)!.equals(f.data)).toBe(true);
  });

  it("makes the same bytes whatever the order the files are given in", () => {
    expect(zip(files).equals(zip([...files].reverse()))).toBe(true);
  });

  it("refuses a name that could escape the folder it is unpacked into", () => {
    for (const name of ["../x", "/abs", "a\\b"])
      expect(() => zip([{ name, data: Buffer.from("x") }])).toThrow(/bad name/);
  });
});

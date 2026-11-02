import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv, type Plugin } from "vite";
import { buildManifest, DEV_ONLY, type Mode } from "./manifest";
import { zip } from "./zip";

// Writes the manifest of the build and, for a store build, checks the files and packs the zip to upload.
//   vite build                  the unpacked folder for local use: dist/
//   vite build --mode store     the Chrome Web Store package: dist-store/ and release/hippo-<version>.zip
// A store build reads VITE_HIPPO_API, VITE_HIPPO_WEB and VITE_HIPPO_CLIENT_ID (and optionally VITE_HIPPO_PUBLIC_KEY) from
// the environment or a .env.store file, and stops before building anything if an address is not a clean https origin.

const TEXT = /\.(js|css|html|json|svg|txt)$/;

function filesOf(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesOf(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

export function extensionPackage(root: string): Plugin {
  const template = JSON.parse(readFileSync(path.join(root, "manifest.template.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  let mode: Mode = "dev";
  let outDir = "dist";
  let env: Record<string, string> = {};

  const manifest = () =>
    buildManifest(template, {
      mode,
      version,
      ...(env.VITE_HIPPO_API ? { apiOrigin: env.VITE_HIPPO_API } : {}),
      ...(env.VITE_HIPPO_WEB ? { webOrigin: env.VITE_HIPPO_WEB } : {}),
      ...(env.VITE_HIPPO_CLIENT_ID ? { clientId: env.VITE_HIPPO_CLIENT_ID } : {}),
      ...(env.VITE_HIPPO_PUBLIC_KEY ? { publicKey: env.VITE_HIPPO_PUBLIC_KEY } : {}),
    });

  return {
    name: "hippo-extension-package",
    apply: "build",
    config(_config, { mode: viteMode }) {
      mode = viteMode === "store" ? "store" : "dev";
      env = loadEnv(viteMode, root, "VITE_HIPPO_");
      manifest(); // a store build with a bad address stops here, before anything is built
      outDir = mode === "store" ? "dist-store" : "dist";
      return { build: { outDir } };
    },
    closeBundle() {
      const out = path.resolve(root, outDir);
      writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest(), null, 2) + "\n");
      if (mode !== "store") return;

      const files = filesOf(out);
      // The manifest is not the only place an address can hide: look at everything that is text.
      const bad = files.filter((f) => TEXT.test(f) && DEV_ONLY.test(readFileSync(path.join(out, f), "utf8")));
      if (bad.length > 0) throw new Error(`Store build refused: a development address is in ${bad.join(", ")}.`);

      const release = path.resolve(root, "release");
      mkdirSync(release, { recursive: true });
      const target = path.join(release, `hippo-${version}.zip`);
      writeFileSync(target, zip(files.map((name) => ({ name, data: readFileSync(path.join(out, name)) }))));
      console.log(`store package: ${path.relative(root, target)} (${files.length} files)`);
    },
  };
}

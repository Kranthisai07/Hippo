// TODO(T4.3 follow-up): replace this placeholder with the real bundles.
// Build each entry with esbuild (platform node, target node22, format esm, bundle, outfile
// <dir>/index.mjs) from apps/api and apps/workers, then point the Code.fromAsset paths in
// infra/src/hippo-stack.ts at those output directories. NodejsFunction is deliberately not used.
export const handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "not built yet" }),
});

// The static site (built with VITE_HOSTED=1) has no API behind it. The landing page works; the demo buttons open the live demo server.
export const HOSTED = import.meta.env.VITE_HOSTED === "1";
export const REPO_URL = "https://github.com/Kranthisai07/Hippo";
// The live demo server (docs/DEPLOY.md): the API and the web app on one address, with the synthetic household.
export const DEMO_URL = "https://hippo-production-f9ae.up.railway.app";

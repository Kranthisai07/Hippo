// The static site (built with VITE_HOSTED=1) has no API behind it. The landing page works, the app and the demo do not.
export const HOSTED = import.meta.env.VITE_HOSTED === "1";
export const REPO_URL = "https://github.com/Kranthisai07/Hippo";

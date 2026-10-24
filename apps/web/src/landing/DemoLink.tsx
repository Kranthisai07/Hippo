import type { ReactNode } from "react";
import { Link } from "react-router";

import { DEMO_URL, HOSTED, REPO_URL } from "../lib/hosted";

export { HOSTED, REPO_URL };

// In the hosted build the demo buttons open the live demo server, which signs in as the synthetic demo household.
const RUN_URL = `${DEMO_URL}/signin`;

export function DemoLink({ className, label, icon }: { className: string; label: string; icon?: ReactNode }) {
  const text = HOSTED ? "Run the demo" : label;
  return HOSTED ? (
    <a className={className} href={RUN_URL}>
      {text}
      {icon}
    </a>
  ) : (
    <Link to="/signin" className={className}>
      {text}
      {icon}
    </Link>
  );
}

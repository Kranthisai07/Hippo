import type { ReactNode } from "react";
import { Link } from "react-router";

import { HOSTED, REPO_URL } from "../lib/hosted";

export { HOSTED, REPO_URL };

// In the hosted build the demo buttons go to the run steps in the README and say so.
const RUN_URL = `${REPO_URL}#run-the-demo`;

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

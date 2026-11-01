import { Link } from "react-router";
import { BrandMark } from "../components/BrandMark";
import { DemoLink } from "./DemoLink";

export function Header() {
  return (
    <>
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <div className="lp-progress" aria-hidden="true" />
      <header className="lp-nav">
        <div className="lp-nav-in">
          <Link to="/welcome" className="lp-brand">
            <BrandMark />
            Hippo
          </Link>
          <nav aria-label="Main" className="lp-nav-links">
            <a href="#story">How it works</a>
            <a href="#planned">Chrome extension</a>
            <DemoLink className="lp-btn" label="Try the demo" />
          </nav>
        </div>
      </header>
    </>
  );
}

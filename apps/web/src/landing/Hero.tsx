import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

export function Hero() {
  return (
    <section className="lp-hero" aria-labelledby="hero-h">
      <div className="lp-hero-copy">
        <h1 id="hero-h">The paperwork you never read twice, watched for you.</h1>
        <p className="lp-lead">
          Hippo turns warranties, leases and renewals into dated obligations, and keeps watching when nobody is asking.
        </p>
        <div className="lp-actions">
          <Link to="/signin" className="lp-btn lp-btn-lg">
            Try the demo
            <ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" />
          </Link>
          <a className="lp-textlink" href="#story">
            See how it works
          </a>
        </div>
      </div>
      <div className="lp-hero-shot">
        <div className="lp-frame">
          <img
            src="/landing/coming-up.png"
            width={1280}
            height={720}
            alt="The Coming up screen in the Hippo web app: a dated timeline of deadlines with the document and page each one came from."
            fetchPriority="high"
          />
        </div>
      </div>
    </section>
  );
}

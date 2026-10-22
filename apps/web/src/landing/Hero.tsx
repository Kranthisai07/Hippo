import { ArrowRight, BadgeCheck, CalendarClock, FileText } from "lucide-react";
import { DemoLink } from "./DemoLink";

export function Hero() {
  return (
    <div className="lp-hero-wrap">
      <section className="lp-hero" aria-labelledby="hero-h">
        <div className="lp-hero-copy">
          <h1 id="hero-h">
            The paperwork you never read twice, <span className="lp-em">watched for you.</span>
          </h1>
          <p className="lp-lead">
            Hippo turns warranties, leases and renewals into dated obligations, and keeps watching when nobody is
            asking.
          </p>
          <div className="lp-actions">
            <DemoLink
              className="lp-btn lp-btn-lg"
              label="Try the demo"
              icon={<ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" />}
            />
            <a className="lp-textlink" href="#story">
              See how it works
            </a>
          </div>
        </div>
        <div className="lp-hero-shot">
          <div className="lp-stage">
            <span className="lp-chip lp-chip-a">
              <CalendarClock size={16} strokeWidth={1.75} aria-hidden="true" />
              Give notice by Nov 1
            </span>
            <span className="lp-chip lp-chip-b">
              <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
              Cited: page 3
            </span>
            <span className="lp-chip lp-chip-c">
              <BadgeCheck size={16} strokeWidth={1.75} aria-hidden="true" />
              Confirm before alert
            </span>
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
        </div>
      </section>
    </div>
  );
}

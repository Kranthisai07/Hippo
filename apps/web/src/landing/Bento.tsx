import { Bell, CalendarClock, PackageCheck, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";

type Cell = { cls: string; icon: LucideIcon; h: string; p: string; src?: string; alt?: string };

const cells: Cell[] = [
  {
    cls: "b-warranty",
    icon: ShieldCheck,
    h: "Warranties",
    p: "What is covered, until when, and what is excluded.",
    src: "/landing/things.png",
    alt: "A list of tracked household items in the Hippo web app.",
  },
  {
    cls: "b-renew",
    icon: RefreshCw,
    h: "Renewals",
    p: "Insurance and policies, flagged before they roll over.",
    src: "/landing/card-renews.png",
    alt: "A Coming up card: car insurance renews on October 30, with its source document.",
  },
  {
    cls: "b-lease",
    icon: CalendarClock,
    h: "Lease notice windows",
    p: "The last day to give notice, with the clause quoted.",
    src: "/landing/review.png",
    alt: "A lease clause quoted next to its extracted notice date.",
  },
  {
    cls: "b-trial",
    icon: Bell,
    h: "Trials and subscriptions",
    p: "Know the charge date before it happens.",
    src: "/landing/card-trial.png",
    alt: "A Coming up card: a trial ends on October 28, with Done, Remind me and Dismiss buttons.",
  },
  {
    cls: "b-recall",
    icon: PackageCheck,
    h: "Recalls",
    p: "Recall radar checks what you own against new notices.",
    src: "/landing/card-recall.png",
    alt: "A recall card: a baby bottle recall that may affect something the household owns.",
  },
];

export function Bento() {
  return (
    <section className="lp-wrap lp-bento-sec" aria-labelledby="bento-h">
      <h2 id="bento-h">What Hippo watches</h2>
      <div className="lp-bento">
        {cells.map(({ cls, icon: Icon, h, p, src, alt }) => (
          <article key={h} className={`lp-cell ${cls}`}>
            <div className="lp-cell-text">
              <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
            {src && (
              <div className="lp-shot">
                <img src={src} width={1280} height={720} alt={alt} loading="lazy" />
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

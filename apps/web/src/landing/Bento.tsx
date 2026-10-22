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
  { cls: "b-renew", icon: RefreshCw, h: "Renewals", p: "Insurance and policies, flagged before they roll over." },
  {
    cls: "b-lease",
    icon: CalendarClock,
    h: "Lease notice windows",
    p: "The last day to give notice, with the clause quoted.",
    src: "/landing/review.png",
    alt: "A lease clause quoted next to its extracted notice date.",
  },
  { cls: "b-trial", icon: Bell, h: "Trials and subscriptions", p: "Know the charge date before it happens." },
  { cls: "b-recall", icon: PackageCheck, h: "Recalls", p: "Recall radar checks what you own against new notices." },
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
            {src && <img src={src} width={1280} height={720} alt={alt} loading="lazy" />}
          </article>
        ))}
      </div>
    </section>
  );
}

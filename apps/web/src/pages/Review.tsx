import { CalendarCheck, CheckCheck, FileSearch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { FieldRow, StatusChip, type Selection } from "../components/FieldRow";
import { SourcePanel } from "../components/SourcePanel";
import { EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";
import { api } from "../lib/api";
import { confirmPlan } from "../lib/confirm";
import { SOURCE_FIELDS, chipParts, collectRefs, daysAwayText, humanize, plainAction, valueLines } from "../lib/format";
import { inferToday } from "../lib/today";
import { useAuth } from "../lib/auth";
import { pollDoc } from "../lib/upload";
import { useLoad } from "../lib/useLoad";
import type { AgreementView, Doc, ObligationRecord } from "../lib/types";

/** Reports that a date was put on screen. "Confirm all dates" may only send names that were reported. */
function ShownDate({
  name,
  onShown,
  children,
}: {
  name: string;
  onShown: (n: string, on: boolean) => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    onShown(name, true);
    return () => onShown(name, false);
  }, [name, onShown]);
  return <li>{children}</li>;
}

function Deadlines({
  agreement,
  obligations,
  today,
}: {
  agreement: AgreementView;
  obligations: ObligationRecord[];
  today: string;
}) {
  const done = obligations
    .filter((o) => o.confirmed)
    .sort(
      (a, b) => Number(b.severity === "high") - Number(a.severity === "high") || a.dueDate.localeCompare(b.dueDate),
    );
  if (!done.length) return null;
  return (
    <section className="stack" aria-label="Deadlines">
      {done.map((o) => {
        const field = SOURCE_FIELDS[o.type]
          .map((n) => agreement.fields.find((f) => f.name === n))
          .find((f) => f && f.sourceRef);
        const ref = collectRefs(field?.sourceRef ?? null)[0];
        const p = chipParts(o.dueDate);
        return (
          <div key={o.id} className="success" data-testid="deadline-card">
            <div className="row">
              <CalendarCheck size={24} aria-hidden="true" />
              <span className="chip chip-ok">Confirmed</span>
              {o.severity === "high" && <span className="chip chip-urgent">High</span>}
            </div>
            <p className="big">
              {plainAction(o.type, o.dueDate, o.label).replace(o.dueDate, `${p.month} ${p.day}`)} (
              {daysAwayText(today, o.dueDate)})
            </p>
            <p className="muted num">{o.dueDate}</p>
            {ref && (
              <blockquote className="quote">
                {ref.quote} <strong>(page {ref.page})</strong>
              </blockquote>
            )}
          </div>
        );
      })}
      <div className="row">
        <Link to="/" className="btn btn-primary">
          See it on Coming up
        </Link>
      </div>
    </section>
  );
}

export function Review() {
  const { docId = "" } = useParams();
  const toast = useToast();
  const { me } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.getDoc(docId), [docId]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [agreement, setAgreement] = useState<AgreementView | null>(null);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<ObligationRecord[] | null>(null);
  const [sel, setSel] = useState<(Selection & { field?: string }) | null>(null);
  const [pages, setPages] = useState<Record<number, string | Error | "loading">>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDoc(data.doc);
    setAgreement(data.agreement);
  }, [data]);

  // Still being read: keep watching until it settles.
  useEffect(() => {
    if (!doc || (doc.status !== "uploaded" && doc.status !== "extracting")) return;
    const c = new AbortController();
    pollDoc(api.getDoc, doc.id, { signal: c.signal })
      .then(() => reload())
      .catch(() => undefined);
    return () => c.abort();
  }, [doc, reload]);

  // Start with the first date on the page so the source panel is never empty.
  useEffect(() => {
    if (!agreement || sel) return;
    const f =
      agreement.fields.find((x) => x.isDate && collectRefs(x.sourceRef).length) ??
      agreement.fields.find((x) => collectRefs(x.sourceRef).length);
    const r = f && collectRefs(f.sourceRef)[0];
    if (f && r) setSel({ page: r.page, quote: r.quote, field: f.name });
  }, [agreement, sel]);

  useEffect(() => {
    if (!sel || pages[sel.page] !== undefined) return;
    const page = sel.page;
    setPages((p) => ({ ...p, [page]: "loading" }));
    api
      .getPage(docId, page)
      .then((r) => setPages((p) => ({ ...p, [page]: r.text })))
      .catch((e: unknown) =>
        setPages((p) => ({ ...p, [page]: e instanceof Error ? e : new Error("Could not load that page.") })),
      );
  }, [sel, pages, docId]);

  const onShown = useCallback((n: string, on: boolean) => {
    setShown((s) => {
      const next = new Set(s);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });
  }, []);

  async function confirm(names: string[]) {
    if (!agreement) return;
    const r = await api.confirmFields(agreement.id, names);
    setAgreement(r.agreement);
    setResult(r.obligations);
    api
      .getDoc(docId)
      .then((d) => setDoc(d.doc))
      .catch(() => undefined);
    return r;
  }

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) {
    return (
      <>
        <h1>Review</h1>
        <Skeleton lines={5} label="Loading your document" />
      </>
    );
  }
  if (!doc) return null;

  const today = inferToday(me, [doc]);
  const working = doc.status === "uploaded" || doc.status === "extracting";
  const plan = agreement ? confirmPlan(agreement.fields, shown) : null;
  const waitingDates = agreement ? agreement.fields.filter((f) => f.isDate && f.status === "extracted") : [];
  const page = sel ? pages[sel.page] : undefined;

  return (
    <>
      <div className="stack">
        <Link to="/upload" className="small">
          Back to upload
        </Link>
        <div className="row">
          <h1 className="grow">{doc.filename}</h1>
          <span className="chip">
            {doc.status === "failed"
              ? "Failed"
              : doc.status === "active" || (agreement && !agreement.fields.some((f) => f.status === "extracted"))
                ? "Reviewed"
                : working
                  ? "Reading"
                  : "Ready to review"}
          </span>
        </div>
        <p className="muted">
          Check each value against the quote from your document. Confirmed dates are the only ones Hippo will remind you
          about.
        </p>
      </div>

      {working && <Skeleton lines={4} label="Reading your document" />}
      {doc.status === "failed" && <ErrorState message={doc.failureReason ?? "We could not read this file."} />}
      {!working && doc.status !== "failed" && !agreement && (
        <EmptyState icon={FileSearch} title="No details were found in this document">
          Try uploading a clearer copy.
        </EmptyState>
      )}

      {result && agreement && <Deadlines agreement={agreement} obligations={result} today={today} />}

      {agreement && (
        <div className="review">
          <div className="stack" role="list" aria-label="Extracted fields">
            {agreement.fields.map((f) => (
              <div role="listitem" key={f.name}>
                <FieldRow
                  field={f}
                  active={sel?.field === f.name}
                  onSelect={(s) => setSel({ ...s, field: f.name })}
                  onConfirm={async (name) => {
                    await confirm([name]);
                    toast(`${humanize(name)} confirmed.`);
                  }}
                  onEdit={async (name, value) => {
                    const r = await api.patchField(agreement.id, name, value);
                    setAgreement({
                      ...agreement,
                      fields: agreement.fields.map((x) => (x.name === name ? r.field : x)),
                    });
                    api
                      .getDoc(docId)
                      .then((d) => setDoc(d.doc))
                      .catch(() => undefined);
                    toast(`${humanize(name)} saved as edited.`);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="source">
            {sel && page && page !== "loading" && !(page instanceof Error) ? (
              <SourcePanel page={sel.page} text={page} quote={sel.quote} title={doc.filename} />
            ) : sel && page instanceof Error ? (
              <ErrorState message={page.message} />
            ) : sel ? (
              <Skeleton lines={6} label="Loading the page" />
            ) : (
              <EmptyState icon={FileSearch} title="Pick a page">
                Choose a page chip on a field to see where it came from.
              </EmptyState>
            )}
          </div>
        </div>
      )}

      {agreement && plan && !plan.nothingLeft && (
        <div className="sticky-bar" aria-label="Confirm dates">
          <div className="stack">
            <strong>
              {waitingDates.length} {waitingDates.length === 1 ? "date" : "dates"} to confirm
            </strong>
            <ul className="row" aria-label="Dates this will confirm">
              {waitingDates.map((f) => (
                <ShownDate key={f.name} name={f.name} onShown={onShown}>
                  <span className="chip chip-warn num">
                    {humanize(f.name)}: {valueLines(f.value).join(", ")}
                  </span>
                </ShownDate>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!plan.ready || confirming}
            onClick={async () => {
              setConfirming(true);
              try {
                await confirm(plan.names);
                toast("Dates confirmed.");
              } catch (e) {
                toast(e instanceof Error ? e.message : "That did not work.", "error");
              } finally {
                setConfirming(false);
              }
            }}
          >
            <CheckCheck size={18} aria-hidden="true" />
            Confirm all dates
          </button>
        </div>
      )}
      {agreement && plan?.nothingLeft && !result && (
        <p className="banner banner-ok">
          <StatusChip status="confirmed" /> Every date here is confirmed.
        </p>
      )}
    </>
  );
}

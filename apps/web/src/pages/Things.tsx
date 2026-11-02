import { FileSignature, FileText, Package, Upload, Wrench } from "lucide-react";
import { Link, useParams } from "react-router";
import { StatusChip } from "../components/FieldRow";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { humanize, readableDate, valueLines } from "../lib/format";
import { useLoad } from "../lib/useLoad";

export function Things() {
  const { data, error, loading, reload } = useLoad(() => api.listAssets(), []);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) {
    return (
      <>
        <h1>Things</h1>
        <Skeleton variant="tiles" lines={4} label="Loading your things" />
      </>
    );
  }
  return (
    <>
      <h1>Things</h1>
      <p className="muted">The appliances, vehicles and products Hippo knows about, with their paperwork.</p>
      {data.assets.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No things yet"
          action={
            <Link to="/upload" className="btn btn-primary">
              <Upload size={18} aria-hidden="true" /> Upload a document
            </Link>
          }
        >
          Upload a warranty or an insurance policy and the item it covers shows up here.
        </EmptyState>
      ) : (
        <ul className="tiles">
          {data.assets.map((a) => (
            <li key={a.id} className="card tile">
              <span className="tile-icon" aria-hidden="true">
                <Package size={22} strokeWidth={1.75} />
              </span>
              <div className="grow">
                <h2>
                  <Link to={`/things/${encodeURIComponent(a.id)}`}>{a.name}</Link>
                </h2>
                <p className="muted small">
                  {[a.brand, a.category && humanize(a.category), a.location].filter(Boolean).join(", ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ThingDetail() {
  const { assetId = "" } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.getAsset(assetId), [assetId]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton lines={5} label="Loading this item" />;
  const { asset, docs, agreements, history } = data;
  return (
    <>
      <Link to="/things" className="small">
        Back to things
      </Link>
      <h1>{asset.name}</h1>
      <p className="muted">
        {[
          asset.brand,
          asset.modelNumber && `Model ${asset.modelNumber}`,
          asset.serialLast4 && `Serial ending ${asset.serialLast4}`,
        ]
          .filter(Boolean)
          .join(", ")}
      </p>

      <section className="card stack" aria-labelledby="docs-h">
        <h2 id="docs-h" className="card-h">
          <FileText size={20} aria-hidden="true" /> Documents
        </h2>
        {docs.length === 0 ? (
          <EmptyState
            as="h3"
            icon={FileText}
            title="Nothing linked yet"
            action={
              <Link to="/upload" className="btn btn-sm">
                <Upload size={16} aria-hidden="true" /> Upload a document
              </Link>
            }
          >
            Upload a manual, receipt or warranty and it can be kept with this item.
          </EmptyState>
        ) : (
          <ul className="list">
            {docs.map((d) => (
              <li key={d.id} className="card-row">
                <Link to={`/review/${encodeURIComponent(d.id)}`}>{d.filename}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="agr-h">
        <h2 id="agr-h" className="card-h">
          <FileSignature size={20} aria-hidden="true" /> Agreements
        </h2>
        {agreements.length === 0 ? (
          <EmptyState as="h3" icon={FileSignature} title="No agreements yet">
            Warranties, plans and policies for this item show up here once you have reviewed their document.
          </EmptyState>
        ) : (
          agreements.map((g) => (
            <div key={g.id} className="card-row stack">
              <h3>{humanize(g.kind)}</h3>
              <dl className="stack">
                {g.fields.map((f) => (
                  <div key={f.name} className="row">
                    <dt className="muted small">{humanize(f.name)}</dt>
                    <dd className="num">{valueLines(f.value).join(", ")}</dd>
                    <StatusChip status={f.status} />
                  </div>
                ))}
              </dl>
            </div>
          ))
        )}
      </section>

      <section className="card stack" aria-labelledby="hist-h">
        <h2 id="hist-h" className="card-h">
          <Wrench size={20} aria-hidden="true" /> Service history
        </h2>
        {history.length === 0 ? (
          <EmptyState as="h3" icon={Wrench} title="Nothing recorded yet.">
            Service visits will appear here when there are some. You can upload a service receipt any time.
          </EmptyState>
        ) : (
          <ul className="list">
            {history.map((h) => (
              <li key={h.id} className="card-row">
                <strong>{h.action}</strong> <span className="muted num">{readableDate(h.ts.slice(0, 10))}</span>
                {h.note && <p className="muted">{h.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

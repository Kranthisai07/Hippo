import { AlertCircle, Check, CheckCircle2, FileText, Pencil } from "lucide-react";
import { useState } from "react";
import { collectRefs, humanize, isEditable, valueLines } from "../lib/format";
import type { FieldView } from "../lib/types";

export interface Selection {
  page: number;
  quote: string;
}

interface Props {
  field: FieldView;
  active?: boolean;
  onSelect: (s: Selection) => void;
  onConfirm: (name: string) => Promise<void>;
  /** Throws an Error whose message is the server's plain explanation when the value is refused. */
  onEdit: (name: string, value: string | number) => Promise<void>;
}

export function StatusChip({ status }: { status: FieldView["status"] }) {
  if (status === "confirmed") {
    return (
      <span className="chip chip-ok">
        <CheckCircle2 size={14} aria-hidden="true" />
        Confirmed
      </span>
    );
  }
  if (status === "edited") {
    return (
      <span className="chip chip-info">
        <Pencil size={14} aria-hidden="true" />
        Edited
      </span>
    );
  }
  return (
    <span className="chip chip-warn">
      <AlertCircle size={14} aria-hidden="true" />
      Needs you
    </span>
  );
}

export function FieldRow({ field, active, onSelect, onConfirm, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = humanize(field.name);
  const refs = collectRefs(field.sourceRef);
  const first = refs[0];

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const raw = draft.trim();
    let value: string | number = raw;
    if (typeof field.value === "number") {
      value = Number(raw);
      if (raw === "" || !Number.isFinite(value)) return setError("Enter a number.");
    }
    if (await run(() => onEdit(field.name, value))) setEditing(false);
  }

  return (
    <div className="frow" data-status={field.status} data-active={active ? "true" : "false"} data-field={field.name}>
      <div className="row">
        <span className="fname">{label}</span>
        <StatusChip status={field.status} />
        {field.isDate && <span className="chip">Date</span>}
      </div>

      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field-label" htmlFor={`edit-${field.name}`}>
            New value for {label}
          </label>
          <input
            id={`edit-${field.name}`}
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => (setEditing(false), setError(null))}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="fvalue">
          {valueLines(field.value).map((line, i) => (
            <div key={i} className="num">
              {line}
            </div>
          ))}
        </div>
      )}

      {refs.map((r, i) => (
        <div key={i} className="stack">
          <blockquote className="quote">
            {r.part && <strong>{r.part}: </strong>}
            {r.quote}
          </blockquote>
        </div>
      ))}

      <div className="row">
        {refs.map((r, i) => (
          <button
            key={i}
            type="button"
            className="chip"
            onClick={() => onSelect({ page: r.page, quote: r.quote })}
            aria-label={`Page ${r.page}, show clause${refs.length > 1 ? ` ${i + 1}` : ""}`}
          >
            <FileText size={14} aria-hidden="true" />
            Page {r.page}
          </button>
        ))}
        {first && <span className="sr-only">Source quote shown above</span>}
        <span className="grow" />
        {isEditable(field.value) && !editing && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setDraft(String(field.value));
              setEditing(true);
            }}
          >
            <Pencil size={16} aria-hidden="true" />
            Edit<span className="sr-only"> {label}</span>
          </button>
        )}
        {field.status === "extracted" && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void run(() => onConfirm(field.name))}
          >
            <Check size={16} aria-hidden="true" />
            Confirm<span className="sr-only"> {label}</span>
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="banner banner-error">
          {error}
        </p>
      )}
    </div>
  );
}

import { AlertCircle, Check, CircleDashed, FileUp, Loader } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { realUploadDeps, uploadOne, type UploadState } from "../lib/upload";

interface Row {
  id: number;
  name: string;
  state: UploadState;
}

type StepState = "done" | "now" | "todo" | "failed";

function stepsOf(s: UploadState): [StepState, StepState, StepState] {
  switch (s.phase) {
    case "uploading":
      return ["now", "todo", "todo"];
    case "reading":
      return ["done", "now", "todo"];
    case "ready":
      return ["done", "done", "done"];
    case "failed":
      return s.docId ? ["done", "failed", "todo"] : ["failed", "todo", "todo"];
  }
}

const STEP_LABEL = ["Uploaded", "Reading", "Ready to review"];

function Steps({ state }: { state: UploadState }) {
  const steps = stepsOf(state);
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={i} className="step" data-state={s}>
          {s === "done" ? (
            <Check size={14} aria-hidden="true" />
          ) : s === "failed" ? (
            <AlertCircle size={14} aria-hidden="true" />
          ) : s === "now" ? (
            <Loader size={14} aria-hidden="true" />
          ) : (
            <CircleDashed size={14} aria-hidden="true" />
          )}
          {STEP_LABEL[i]}
          <span className="sr-only">
            {s === "done" ? ", done" : s === "now" ? ", in progress" : s === "failed" ? ", failed" : ", waiting"}
          </span>
        </li>
      ))}
    </ol>
  );
}

const statusText = (s: UploadState) =>
  s.phase === "uploading"
    ? "Uploading"
    : s.phase === "reading"
      ? "Reading"
      : s.phase === "ready"
        ? "Ready to review"
        : "Failed";

export function UploadPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const next = useRef(1);
  const ctl = useRef(new AbortController());
  // A fresh controller per mount, so React StrictMode's mount, unmount, mount does not leave an aborted one behind.
  useEffect(() => {
    const c = new AbortController();
    ctl.current = c;
    return () => c.abort();
  }, []);

  function add(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const id = next.current++;
      setRows((r) => [...r, { id, name: file.name, state: { phase: "uploading" } }]);
      void uploadOne(file, { ...realUploadDeps, signal: ctl.current.signal }, (state) =>
        setRows((r) => r.map((x) => (x.id === id ? { ...x, state } : x))),
      );
    }
  }

  return (
    <>
      <h1>Upload</h1>
      <p className="muted">
        Add a lease, warranty, insurance policy or subscription. Hippo reads it and finds the dates for you to check.
      </p>
      <div
        className="drop"
        data-over={over}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        <FileUp size={40} aria-hidden="true" color="var(--accent)" />
        <h2>Drop files here</h2>
        <p className="muted">PDF, JPEG or PNG, up to 15 MB each. You can add several at once.</p>
        <label htmlFor="files" className="sr-only">
          Choose files to upload
        </label>
        <input
          id="files"
          ref={input}
          className="sr-only"
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn btn-primary" onClick={() => input.current?.click()}>
          Choose files
        </button>
      </div>

      {rows.length > 0 && (
        <ul className="list" aria-label="Your uploads">
          {rows.map((r) => (
            <li key={r.id} className="card stack" data-testid="upload-row">
              <div className="row">
                <strong className="grow">{r.name}</strong>
                <span className="chip" aria-live="polite">
                  {statusText(r.state)}
                </span>
              </div>
              <Steps state={r.state} />
              {r.state.phase === "failed" && (
                <p className="banner banner-error" role="alert">
                  <span>{r.state.reason} Check the file and add it again, or try a PDF, JPEG or PNG.</span>
                </p>
              )}
              {r.state.phase === "ready" && r.state.docId && (
                <div>
                  <Link className="btn btn-primary" to={`/review/${encodeURIComponent(r.state.docId)}`}>
                    Review
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

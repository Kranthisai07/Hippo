import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";

// Small shared pieces. Everything takes text children; nothing here renders HTML from a string.

// The variant only changes the shape of each placeholder so it matches what replaces it.
export function Skeleton({
  lines = 3,
  label = "Loading",
  variant = "lines",
}: {
  lines?: number;
  label?: string;
  variant?: "lines" | "tickets" | "tiles" | "rows" | "fields";
}) {
  return (
    <div className={`stack skel-${variant}`} role="status" aria-live="polite" aria-label={label}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel" aria-hidden="true" />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <AlertTriangle size={20} strokeWidth={1.75} aria-hidden="true" />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  as: Heading = "h2",
}: {
  icon: LucideIcon;
  title: string;
  as?: "h2" | "h3";
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card stack empty" data-testid="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon size={28} strokeWidth={1.75} />
      </span>
      <Heading>{title}</Heading>
      {children && <p className="muted">{children}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}

// Toasts

type Kind = "ok" | "error";
interface ToastItem {
  id: number;
  kind: Kind;
  text: string;
}
const ToastCtx = createContext<(text: string, kind?: Kind) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: Kind = "ok") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className="toast" data-kind={t.kind}>
            {t.kind === "ok" ? <CheckCircle2 size={20} aria-hidden="true" /> : <Info size={20} aria-hidden="true" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

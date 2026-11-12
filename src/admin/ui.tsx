import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";

export const formatDate = (value: string | null | undefined, withTime = true) => (value ? new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(new Date(value)) : "—");
export function timeAgo(value: string | null | undefined): string {
  if (!value) return "never";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86400 * 14) return `${Math.round(seconds / 86400)} d ago`;
  return formatDate(value, false);
}
export const number = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString());

type Toast = { message: string; tone: "good" | "bad" | "info" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null), timer = useRef<number>();
  const show = useCallback((message: string, tone: Toast["tone"] = "good") => { window.clearTimeout(timer.current); setToast({ message, tone }); timer.current = window.setTimeout(() => setToast(null), tone === "bad" ? 6000 : 3200); }, []);
  return <ToastContext.Provider value={show}>{children}{toast && <div className="va-toast vg-glass" role={toast.tone === "bad" ? "alert" : "status"} style={{ color: `var(--vg-${toast.tone})` }}>{toast.message}</div>}</ToastContext.Provider>;
}

/** Report a failed action in the toast and keep the screen usable. */
export function useAction() {
  const toast = useToast();
  return useCallback(async <T,>(work: () => Promise<T>, done?: string): Promise<T | undefined> => {
    try { const result = await work(); if (done) toast(done); return result; }
    catch (error) { toast(error instanceof Error ? error.message : "That didn't work. Try again.", "bad"); return undefined; }
  }, [toast]);
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input,select,textarea,button:not([data-close])")?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close.current(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="va-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="va-modal vg-glass" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: "min(100%, 720px)" } : undefined}>
      <header className="va-row" style={{ justifyContent: "space-between" }}><h2 style={{ fontSize: "1.25rem" }}>{title}</h2><button type="button" data-close className="vg-btn is-quiet is-icon" aria-label="Close" onClick={onClose}><Cross2Icon /></button></header>
      {children}
      {footer && <footer>{footer}</footer>}
    </div>
  </div>;
}
export function Confirm({ title, body, action, danger, onConfirm, onClose }: { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose} footer={<><button type="button" className="vg-btn" onClick={onClose}>Cancel</button><button type="button" className={`vg-btn ${danger ? "is-danger" : "is-primary"}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>{busy ? "Working…" : action}</button></>}><div className="vg-muted">{body}</div></Modal>;
}
export function StatusChip({ status }: { status: string }) { const label: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", live: "Live", draft: "Draft", closed: "Closed" }; return <span className="vg-chip" data-tone={status}>{label[status] ?? status}</span>; }
export function Loading({ label = "Loading" }: { label?: string }) { return <div className="vg-center" role="status" style={{ minHeight: "30vh" }}><div className="vg-spinner" aria-label={label} /></div>; }
export function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="vg-glass va-empty" role="alert"><h3>This couldn't be loaded</h3><p>{message}</p>{onRetry && <button type="button" className="vg-btn" onClick={onRetry}>Try again</button>}</div>; }

/** Load data for a screen, with reload and error state. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [tick, setTick] = useState(0);
  useEffect(() => { let active = true; setLoading(true); loader().then(next => { if (active) { setData(next); setError(""); } }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Something went wrong."); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, setData, error, loading, reload: useCallback(() => setTick(value => value + 1), []) };
}

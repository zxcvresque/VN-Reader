import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon, ClockIcon, Cross2Icon, ExternalLinkIcon, LockClosedIcon, ReloadIcon } from "@radix-ui/react-icons";
import FormRunner from "./FormRunner";
import { RequestError, call, receipts, themeStyle, type FormTheme, type FormView, type Outcome } from "./api";
import "./glass.css";

export function useResolvedMode(mode: FormTheme["mode"]): "light" | "dark" {
  const [dark, setDark] = useState(() => { try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; } });
  useEffect(() => { let query: MediaQueryList; try { query = window.matchMedia("(prefers-color-scheme: dark)"); } catch { return; } const listen = () => setDark(query.matches); query.addEventListener("change", listen); return () => query.removeEventListener("change", listen); }, []);
  return mode === "auto" ? (dark ? "dark" : "light") : mode;
}

/** Applies a form's theme. Also used by the builder's live preview. */
export function FormShell({ theme, fontUrl, children }: { theme: FormTheme; fontUrl?: string; children: ReactNode }) {
  const mode = useResolvedMode(theme.mode);
  return <div className="vg" data-mode={mode} data-surface={theme.surface} data-backdrop={theme.backdrop} style={themeStyle(theme) as CSSProperties}>
    {theme.font === "custom" && fontUrl && <style>{`@font-face{font-family:"VN Form Custom";src:url("${fontUrl}");font-display:swap}`}</style>}
    <div className="vg-backdrop" aria-hidden="true"><i /><i /><i /></div>
    {children}
  </div>;
}

export interface UpdateOptions { slug: string; receipt: string; telegram: string; email: boolean; suggestedEmail?: string; onOutcome: (outcome: Outcome) => void }

/** Ways to hear back: the bot (bound to one Telegram account), an email, or the private link. */
function StatusUpdates({ outcome, statusLink, options }: { outcome: Outcome; statusLink?: string; options?: UpdateOptions }) {
  const [copied, setCopied] = useState(false), [email, setEmail] = useState(options?.suggestedEmail ?? ""), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const copy = async () => { if (!statusLink) return; try { await navigator.clipboard.writeText(statusLink); setCopied(true); window.setTimeout(() => setCopied(false), 2500); } catch { window.prompt("Copy your private status link", statusLink); } };
  const ask = async (channel: "telegram" | "email") => {
    if (!options) return;
    setBusy(channel); setError("");
    try {
      const result = await call<{ url?: string; outcome?: Outcome }>(`/forms/${options.slug}/notify`, { body: { channel, email }, headers: { "X-VN-Receipt": options.receipt } });
      if (result.url) window.open(result.url, "_blank", "noopener");
      if (result.outcome) options.onOutcome(result.outcome);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "That didn't work. Try again."); }
    finally { setBusy(""); }
  };
  const linked = outcome.notify?.telegram, mailed = outcome.notify?.email;
  if (!statusLink && !options) return null;
  return <div className="vf-updates">
    <strong>How do you want to hear back?</strong>
    {options?.telegram && <div className="vf-update"><div><b>Telegram</b><small>{linked ? "Linked. The bot will message you, and /status works only for your account." : `Opens @${options.telegram}. Tap Start to link this response to your Telegram account.`}</small></div>{linked ? <span className="vg-chip" data-tone="good"><CheckIcon aria-hidden="true" />Linked</span> : <button type="button" className="vg-btn is-small" disabled={!!busy} onClick={() => void ask("telegram")}>{busy === "telegram" ? "Opening…" : "Get updates"}</button>}</div>}
    {options?.email && <form className="vf-update" onSubmit={event => { event.preventDefault(); void ask("email"); }}><div><b>Email</b><small>{mailed ? `We'll email ${mailed} when your response is reviewed.` : "One email when your response is reviewed. Nothing else."}</small>{!mailed && <input className="vg-input is-small" type="email" required placeholder="you@example.com" aria-label="Email for the update" value={email} onChange={event => setEmail(event.target.value)} />}</div>{mailed ? <span className="vg-chip" data-tone="good"><CheckIcon aria-hidden="true" />On</span> : <button type="submit" className="vg-btn is-small" disabled={!!busy}>{busy === "email" ? "Saving…" : "Email me"}</button>}</form>}
    {statusLink && <div className="vf-update"><div><b>Private link</b><small>Check back from any device. Anyone with this link can see your status, so keep it to yourself.</small></div><button type="button" className="vg-btn is-small" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button></div>}
    {error && <p className="vg-alert" data-tone="bad" role="alert">{error}</p>}
  </div>;
}

export function OutcomePanel({ outcome, requireApproval, onRefresh, refreshing, onAgain, statusLink, updates }: { outcome: Outcome; requireApproval: boolean; onRefresh?: () => void; refreshing?: boolean; onAgain?: () => void; statusLink?: string; updates?: UpdateOptions }) {
  const { status, reward } = outcome;
  const heading = status === "approved" ? (requireApproval ? "You're approved." : outcome.title) : status === "rejected" ? "This response wasn't approved." : outcome.title;
  return <section className="vf-outcome vg-glass" aria-live="polite">
    <div className="vf-seal" data-status={status} aria-hidden="true">{status === "approved" ? <CheckIcon /> : status === "rejected" ? <Cross2Icon /> : <ClockIcon />}</div>
    <h1>{heading}</h1>
    {outcome.message && <p>{outcome.message}</p>}
    {requireApproval && status !== "rejected" && <ol className="vf-steps" aria-label="Review progress"><li className="is-done">Submitted</li><li className={status === "approved" ? "is-done" : "is-now"}>Admin review</li><li className={status === "approved" ? "is-done" : ""}>{reward ? "Link unlocked" : "Approved"}</li></ol>}
    {reward && status !== "rejected" && (reward.url
      ? <div className="vf-reward is-open"><small>Your link is ready</small><a className="vg-btn is-primary" href={reward.url} target="_blank" rel="noopener noreferrer">{reward.label}<ExternalLinkIcon aria-hidden="true" /></a></div>
      : <div className="vf-reward"><LockClosedIcon aria-hidden="true" /><strong>{reward.label}</strong><small>Unlocks here once an admin approves your response.</small></div>)}
    {status === "pending" && <StatusUpdates outcome={outcome} statusLink={statusLink} options={updates} />}
    <div className="va-row" style={{ justifyContent: "center" }}>
      {status === "pending" && onRefresh && <button type="button" className="vg-btn" onClick={onRefresh} disabled={refreshing}><ReloadIcon aria-hidden="true" />{refreshing ? "Checking…" : "Check status"}</button>}
      {onAgain && <button type="button" className="vg-btn is-quiet" onClick={onAgain}>Submit another response</button>}
      <a className="vg-btn is-quiet" href="/">Back to Vidurneeti</a>
    </div>
    <p className="vg-muted vg-num" style={{ fontSize: "0.8rem" }}>Submitted {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(outcome.submittedAt))}</p>
  </section>;
}

const FALLBACK_THEME: FormTheme = { accent: "#f2a23a", font: "aspekta", surface: "glass", mode: "auto", backdrop: "aurora", radius: 22, layout: "classic", submitLabel: "Submit" };

export default function FormPage({ slug, linkCode }: { slug?: string; linkCode?: string }) {
  const [resolved, setResolved] = useState(slug ?? "");
  const [via, setVia] = useState(() => new URLSearchParams(window.location.search).get("via") ?? "");
  const [view, setView] = useState<FormView | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [again, setAgain] = useState(false);
  const [receipt, setReceipt] = useState("");

  useEffect(() => {
    if (!linkCode) return;
    let active = true;
    call<{ slug: string; via: string }>(`/forms/go/${encodeURIComponent(linkCode)}`).then(link => { if (!active) return; window.history.replaceState(null, "", `/f/${link.slug}?via=${encodeURIComponent(link.via)}`); setVia(link.via); setResolved(link.slug); })
      .catch(failure => { if (active) setError({ message: failure instanceof Error ? failure.message : "This link is no longer active.", missing: true }); });
    return () => { active = false; };
  }, [linkCode]);

  const load = useCallback(async (quiet = false) => {
    if (!resolved) return;
    if (quiet) setRefreshing(true);
    try {
      // A status link carries the receipt after "#r=". Keep it on this device and tidy the address bar.
      const carried = /^#r=([A-Za-z0-9_-]{20,80})$/.exec(window.location.hash)?.[1];
      if (carried) { receipts.set(resolved, carried); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
      const receipt = receipts.get(resolved);
      setReceipt(receipt ?? "");
      const next = await call<FormView>(`/forms/${encodeURIComponent(resolved)}${via ? `?via=${encodeURIComponent(via)}` : ""}`, { headers: receipt ? { "X-VN-Receipt": receipt } : {} });
      setView(next); setError(null); document.title = `${next.form.title} · Vidurneeti`;
    } catch (failure) { if (!quiet) setError({ message: failure instanceof Error ? failure.message : "This form couldn't be opened.", missing: failure instanceof RequestError && failure.status === 404 }); }
    finally { setRefreshing(false); }
  }, [resolved, via]);
  useEffect(() => { void load(); }, [load]);
  // While a response is waiting for review, look again quietly so the link appears without a reload.
  const pending = view?.outcome?.status === "pending";
  useEffect(() => { if (!pending) return; const focus = () => void load(true); window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus); }, [pending, load]);
  useEffect(() => { if (!pending) return; const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 45000); return () => window.clearInterval(timer); }, [pending, load]);

  const form = view?.form, theme = form?.theme ?? FALLBACK_THEME;
  const showOutcome = view?.outcome && !again;
  let body: ReactNode;
  if (error) body = <section className="vf-outcome vg-glass" role="alert"><h1>{error.missing ? "This form isn't available." : "This form couldn't be opened."}</h1><p>{error.message}</p><div className="va-row" style={{ justifyContent: "center" }}>{!error.missing && <button type="button" className="vg-btn is-primary" onClick={() => void load()}>Try again</button>}<a className="vg-btn" href="/">Back to Vidurneeti</a></div></section>;
  else if (!view || !form) body = <div className="vg-center" role="status"><div className="vg-spinner" aria-label="Opening the form" /></div>;
  else if (showOutcome && view.outcome) body = <OutcomePanel outcome={view.outcome} requireApproval={form.settings.requireApproval} statusLink={receipt ? `${window.location.origin}/f/${form.slug}#r=${receipt}` : undefined} updates={receipt && view.updates ? { slug: form.slug, receipt, telegram: view.updates.telegram, email: view.updates.email, onOutcome: outcome => setView(current => (current ? { ...current, outcome } : current)) } : undefined} onRefresh={() => void load(true)} refreshing={refreshing} onAgain={form.settings.oneResponse === "none" && form.availability === "open" ? () => setAgain(true) : undefined} />;
  else if (form.availability !== "open") body = <section className="vf-outcome vg-glass"><div className="vf-seal" data-status="pending" aria-hidden="true"><LockClosedIcon /></div><h1>{form.availability === "soon" ? "This form opens soon." : form.availability === "full" ? "This form has all the responses it needs." : "This form is closed."}</h1><p>{form.settings.closedMessage || (form.availability === "soon" && form.settings.opensAt ? `It opens on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(form.settings.opensAt))}.` : "It isn't accepting responses right now.")}</p><a className="vg-btn" href="/">Back to Vidurneeti</a></section>;
  else if (form.settings.access === "account" && !view.signedIn) body = <section className="vf-outcome vg-glass"><div className="vf-seal" data-status="pending" aria-hidden="true"><LockClosedIcon /></div><h1>Sign in to fill this form.</h1><p>{form.title} is open to people with a Vidurneeti reader account. Sign in on the home page, then come back to this link.</p><a className="vg-btn is-primary" href="/">Go to sign in</a></section>;
  else body = <>
    <header className="vf-hero vg-glass"><h1>{form.title}</h1>{form.description && <p>{form.description}</p>}
      {(form.settings.hasReward || form.settings.requireApproval) && <div className="vf-meta">{form.settings.requireApproval && <span className="vg-chip is-plain">Reviewed by an admin</span>}{form.settings.hasReward && <span className="vg-chip is-plain"><LockClosedIcon aria-hidden="true" width={12} height={12} />{form.settings.rewardLabel} after {form.settings.requireApproval ? "approval" : "you submit"}</span>}</div>}
    </header>
    <FormRunner form={form} prefill={view.prefill} via={via} onDone={(outcome, receipt) => { receipts.set(form.slug, receipt); setReceipt(receipt); setAgain(false); setView({ ...view, outcome }); window.scrollTo({ top: 0 }); }} />
  </>;

  return <FormShell theme={theme} fontUrl={form?.theme.hasCustomFont ? `/api/forms/${form.slug}/font` : undefined}>
    <div className="vf-wrap">
      <div className="vf-top"><a className="vf-home" href="/" aria-label="Vidurneeti home"><img src="/VN%20Dark%20Mode%20(Circle).png" alt="" width={36} height={36} /><span>Vidurneeti</span></a></div>
      <main>{body}</main>
    </div>
  </FormShell>;
}

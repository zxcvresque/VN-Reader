import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { ActivityLogIcon, ExitIcon, ExternalLinkIcon, FileTextIcon, GearIcon, HomeIcon, MoonIcon, PersonIcon, PlusIcon, SunIcon } from "@radix-ui/react-icons";
import { BACKDROPS, RequestError, call, type AdminForm, type AdminMe, type FormSummary } from "../forms/api";
import { useResolvedMode } from "../forms/FormPage";
import { Loading, Modal, StatusChip, ToastProvider, number, timeAgo, useAction } from "./ui";
import FormWorkspace from "./FormWorkspace";
import TeamPane from "./TeamPane";
import SettingsPane from "./SettingsPane";
import ActivityPane from "./ActivityPane";
import "../forms/glass.css";

export interface AdminContext { me: AdminMe; can: (permission: string) => boolean; go: (path: string) => void; forms: FormSummary[]; reloadForms: () => void }

const TEMPLATES: Array<{ id: string; name: string; note: string; form: Record<string, unknown> }> = [
  { id: "blank", name: "Blank form", note: "Start with one question and build from there.", form: { title: "Untitled form" } },
  { id: "registration", name: "Event registration", note: "Name, contact, city and attendance.", form: { title: "Event registration", schema: { pages: [{ title: "Your details", fields: [{ type: "short", label: "Full name", required: true, role: "name" }, { type: "phone", label: "WhatsApp number", required: true }, { type: "state", label: "State or union territory", required: true, role: "state" }, { type: "yesno", label: "Will you attend in person?", required: true }, { type: "long", label: "Anything we should know?" }] }] } } },
  { id: "feedback", name: "Feedback", note: "A rating, what worked, what to improve.", form: { title: "Feedback", settings: { requireApproval: false }, schema: { pages: [{ title: "", fields: [{ type: "rating", label: "How would you rate your experience?", required: true, scale: { max: 5 } }, { type: "long", label: "What worked well?" }, { type: "long", label: "What should we improve?" }, { type: "scale", label: "How likely are you to recommend us to a friend?", scale: { min: 0, max: 10, minLabel: "Not likely", maxLabel: "Very likely" } }] }] } } },
  { id: "volunteer", name: "Volunteer sign-up", note: "Skills, availability and an approval-gated group link.", form: { title: "Volunteer sign-up", schema: { pages: [{ title: "About you", fields: [{ type: "short", label: "Full name", required: true, role: "name" }, { type: "state", label: "State or union territory", required: true, role: "state" }, { type: "short", label: "Telegram username", required: true, role: "telegram" }] }, { title: "How you can help", fields: [{ type: "multi", label: "What can you help with?", required: true, allowOther: true, options: ["On-ground events", "Design and video", "Writing and research", "Technology", "Legal", "Fundraising"] }, { type: "single", label: "How much time can you give each week?", options: ["1–2 hours", "3–5 hours", "More than 5 hours"] }] }] } } }
];

function SignIn({ onDone, message }: { onDone: () => void; message?: string }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await call("/auth/sign-in/email", { body: { email, password } }); onDone(); }
    catch (failure) { setError(failure instanceof RequestError && failure.status === 403 ? "Verify this email on the main site first, then sign in here." : failure instanceof Error ? failure.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };
  return <div className="vg-center"><form className="vg-glass va-stack" style={{ padding: 30, width: "min(100%, 400px)", textAlign: "left" }} onSubmit={submit}>
    <div className="va-brand" style={{ padding: 0 }}><img src="/VN%20Dark%20Mode%20(Circle).png" alt="" /><div><strong>Vidurneeti admin</strong><small>Forms, responses and site settings</small></div></div>
    <h1 style={{ fontSize: "1.5rem" }}>Sign in to continue</h1>
    {message && <p className="vg-alert" data-tone="warn">{message}</p>}
    <label className="vg-label">Email<input className="vg-input" type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label>
    <label className="vg-label">Password<input className="vg-input" type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    {error && <p className="vg-alert" data-tone="bad" role="alert">{error}</p>}
    <button className="vg-btn is-primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <p className="va-note">Use your Vidurneeti reader account. Only the owner and admins they've added can open this console. <a href="/">Back to the site</a></p>
  </form></div>;
}

function Home({ context }: { context: AdminContext }) {
  const { forms, can, go, reloadForms } = context, run = useAction();
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState("");
  const totals = forms.reduce((sum, form) => ({ total: sum.total + form.counts.total, pending: sum.pending + form.counts.pending, approved: sum.approved + form.counts.approved }), { total: 0, pending: 0, approved: 0 });
  const create = async (template: typeof TEMPLATES[number]) => { setBusy(template.id); const made = await run(() => call<{ form: AdminForm }>("/admin/forms", { body: template.form })); setBusy(""); if (made) { setCreating(false); reloadForms(); go(`/admin/forms/${made.form.id}/build`); } };
  return <>
    <header className="va-head"><div><h1>Forms</h1><p>Every form on vidurneeti.xyz, with what needs your attention first.</p></div>{can("forms.write") && !context.me.formIds && <div className="va-actions"><button type="button" className="vg-btn is-primary" onClick={() => setCreating(true)}><PlusIcon aria-hidden="true" />New form</button></div>}</header>
    <div className="va-tiles">
      <div className="va-tile vg-glass"><span>Waiting for review</span><strong>{number(totals.pending)}</strong><small>{totals.pending ? "People are waiting for their link" : "Nothing waiting"}</small></div>
      <div className="va-tile vg-glass"><span>Responses, all forms</span><strong>{number(totals.total)}</strong><small>{number(totals.approved)} approved</small></div>
      <div className="va-tile vg-glass"><span>Live forms</span><strong>{forms.filter(form => form.status === "live").length}</strong><small>{forms.length} in total</small></div>
    </div>
    {forms.length ? <div className="va-formcards">{forms.map(form => <a key={form.id} className="va-formcard vg-glass" href={`/admin/forms/${form.id}/responses`} style={{ ["--card-accent" as string]: form.accent }} onClick={event => { event.preventDefault(); go(`/admin/forms/${form.id}/responses`); }}>
      <div className="va-row" style={{ justifyContent: "space-between" }}><StatusChip status={form.status} />{form.counts.pending > 0 && <span className="vg-chip" data-tone="pending">{form.counts.pending} to review</span>}</div>
      <div><h3>{form.title}</h3><p>{form.description || `${form.questions} questions`}</p></div>
      <dl><div><dt>Responses</dt><dd>{number(form.counts.total)}</dd></div><div><dt>Approved</dt><dd>{number(form.counts.approved)}</dd></div><div><dt>Last response</dt><dd style={{ fontSize: "0.9rem", fontWeight: 600, paddingTop: 5 }}>{timeAgo(form.counts.latest)}</dd></div></dl>
    </a>)}</div> : <div className="vg-glass va-empty"><h3>No forms yet</h3><p>Create a form to start collecting responses.</p></div>}
    {creating && <Modal title="Start a new form" onClose={() => setCreating(false)} wide><div className="va-grid cols-2">{TEMPLATES.map(template => <button key={template.id} type="button" className="vg-glass va-card" style={{ textAlign: "left", cursor: "pointer" }} disabled={!!busy} onClick={() => void create(template)}><strong>{busy === template.id ? "Creating…" : template.name}</strong><p className="va-note" style={{ marginTop: 4 }}>{template.note}</p></button>)}</div></Modal>}
  </>;
}

const remembered = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* optional */ } };

/** Personal look of the console. Defaults: follow the device's light or dark, on the monochrome background. */
export interface Look { mode: "dark" | "light"; choice: "auto" | "dark" | "light"; backdrop: string; setChoice: (choice: "auto" | "dark" | "light") => void; setBackdrop: (backdrop: string) => void }

export default function AdminApp() {
  const [choice, setChoiceState] = useState<"auto" | "dark" | "light">(() => { const saved = remembered("vn-admin-mode"); return saved === "light" || saved === "dark" ? saved : "auto"; });
  const [backdrop, setBackdropState] = useState(() => { const saved = remembered("vn-admin-backdrop"); return BACKDROPS.some(item => item.id === saved) ? saved! : "mono"; });
  const mode = useResolvedMode(choice);
  const look: Look = { mode, choice, backdrop, setChoice: next => { setChoiceState(next); remember("vn-admin-mode", next === "auto" ? null : next); }, setBackdrop: next => { setBackdropState(next); remember("vn-admin-backdrop", next === "mono" ? null : next); } };
  return <div className="vg" data-mode={mode} data-surface="glass" data-backdrop={backdrop}><div className="vg-backdrop" aria-hidden="true"><i /><i /><i /></div><ToastProvider><Console look={look} /></ToastProvider></div>;
}

function AppearanceMenu({ look }: { look: Look }) {
  const current = BACKDROPS.find(item => item.id === look.backdrop)?.name ?? "";
  return <details className="va-look">
    <summary>{look.mode === "dark" ? <MoonIcon aria-hidden="true" /> : <SunIcon aria-hidden="true" />}<span>Appearance</span><small>{current}</small></summary>
    <div className="va-look-panel">
      <div className="va-tabs" role="group" aria-label="Light or dark">{(["auto", "light", "dark"] as const).map(item => <button type="button" key={item} aria-pressed={look.choice === item} onClick={() => look.setChoice(item)}>{item === "auto" ? "Device" : item === "light" ? "Light" : "Dark"}</button>)}</div>
      <div className="va-look-swatches" role="group" aria-label="Background">{BACKDROPS.map(item => <button type="button" key={item.id} className="va-swatch" data-backdrop={item.id} aria-pressed={look.backdrop === item.id} aria-label={item.name} title={item.name} onClick={() => look.setBackdrop(item.id)}><i aria-hidden="true" /></button>)}</div>
    </div>
  </details>;
}

function Console({ look }: { look: Look }) {
  const [me, setMe] = useState<AdminMe | null>(null), [state, setState] = useState<"loading" | "signin" | "denied" | "ready" | "error">("loading"), [problem, setProblem] = useState("");
  const [forms, setForms] = useState<FormSummary[]>([]), [path, setPath] = useState(() => window.location.pathname.replace(/\/+$/, "") || "/admin");
  const run = useAction();

  const reloadForms = useCallback(() => { void call<{ forms: FormSummary[] }>("/admin/forms").then(result => setForms(result.forms)).catch(() => {}); }, []);
  const boot = useCallback(async () => {
    setState("loading");
    try { const next = await call<AdminMe>("/admin/me"); setMe(next); setState("ready"); if (next.permissions.includes("forms.read")) reloadForms(); }
    catch (failure) { const status = failure instanceof RequestError ? failure.status : 0; setProblem(failure instanceof Error ? failure.message : ""); setState(status === 401 ? "signin" : status === 403 ? "denied" : "error"); }
  }, [reloadForms]);
  useEffect(() => { void boot(); document.title = "Admin · Vidurneeti"; }, [boot]);
  useEffect(() => { const pop = () => setPath(window.location.pathname.replace(/\/+$/, "") || "/admin"); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  const go = useCallback((next: string) => {
    if (next !== window.location.pathname + window.location.search) window.history.pushState(null, "", next);
    setPath(window.location.pathname);
    window.scrollTo({ top: 0 });
  }, []);
  const context = useMemo<AdminContext | null>(() => (me ? { me, can: permission => me.permissions.includes(permission), go, forms, reloadForms } : null), [me, go, forms, reloadForms]);

  let body: ReactNode;
  if (state === "loading") body = <Loading label="Opening the admin console" />;
  else if (state === "signin") body = <SignIn onDone={() => void boot()} />;
  else if (state === "denied") body = <div className="vg-center"><div className="vg-glass va-empty" style={{ maxWidth: 440 }}><h3>This account isn't an admin</h3><p>{problem} Ask the site owner to add your email under Team.</p><div className="va-row"><a className="vg-btn" href="/">Back to the site</a><button type="button" className="vg-btn is-quiet" onClick={() => void run(async () => { await call("/auth/sign-out", { body: {} }); await boot(); })}>Use another account</button></div></div></div>;
  else if (state === "error" || !context || !me) body = <div className="vg-center"><div className="vg-glass va-empty"><h3>The admin console couldn't be reached</h3><p>{problem}</p><button type="button" className="vg-btn is-primary" onClick={() => void boot()}>Try again</button></div></div>;
  else {
    const formRoute = /^\/admin\/forms\/([^/]+)(?:\/(responses|insights|build|share))?$/.exec(path);
    const link = (href: string, label: string, icon: ReactNode, extra?: ReactNode) => <a className="va-nav" href={href} aria-current={path === href || (href !== "/admin" && path.startsWith(href)) ? "page" : undefined} onClick={(event: MouseEvent) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); go(href); }}>{icon}<span className="va-truncate">{label}</span>{extra}</a>;
    const page = formRoute ? <FormWorkspace key={formRoute[1]} context={context} formId={formRoute[1]} tab={(formRoute[2] ?? "responses") as "responses"} />
      : path === "/admin/team" && context.can("team.manage") ? <TeamPane context={context} />
      : path === "/admin/settings" && context.can("settings.manage") ? <SettingsPane />
      : path === "/admin/activity" && context.can("site.read") ? <ActivityPane canControl={context.can("settings.manage")} />
      : context.can("forms.read") ? <Home context={context} /> : <div className="vg-glass va-empty"><h3>Nothing to show yet</h3><p>Your admin role doesn't include forms. Use the menu to open what you can access.</p></div>;
    body = <div className="va-shell">
      <nav className="va-side vg-glass" aria-label="Admin">
        <a className="va-brand" href="/admin" onClick={event => { event.preventDefault(); go("/admin"); }}><img src="/VN%20Dark%20Mode%20(Circle).png" alt="" /><div><strong>Vidurneeti</strong><small>Admin console</small></div></a>
        {context.can("forms.read") && <>{link("/admin", "All forms", <HomeIcon aria-hidden="true" />)}
          {forms.length > 0 && <div className="va-navlabel">Your forms</div>}
          {forms.slice(0, 12).map(form => <span key={form.id} style={{ display: "contents" }}>{link(`/admin/forms/${form.id}`, form.title, <FileTextIcon aria-hidden="true" />, form.counts.pending ? <span className="va-count" aria-label={`${form.counts.pending} waiting for review`}>{form.counts.pending}</span> : undefined)}</span>)}</>}
        {(context.can("site.read") || context.can("team.manage") || context.can("settings.manage")) && <div className="va-navlabel">Site</div>}
        {context.can("site.read") && link("/admin/activity", "Reader activity", <ActivityLogIcon aria-hidden="true" />)}
        {context.can("team.manage") && link("/admin/team", "Team and access", <PersonIcon aria-hidden="true" />)}
        {context.can("settings.manage") && link("/admin/settings", "Backups and Telegram", <GearIcon aria-hidden="true" />)}
        <div className="va-side-foot">
          <AppearanceMenu look={look} />
          <div className="va-who"><strong>{me.owner ? "Owner" : "Admin"}</strong>{me.email}</div>
          <div className="va-row" style={{ gap: 4, flexWrap: "nowrap" }}>
            
            <a className="vg-btn is-quiet is-icon" href="/" aria-label="Open the reader site" title="Open the reader site"><ExternalLinkIcon /></a>
            <button type="button" className="vg-btn is-quiet is-icon" aria-label="Sign out" title="Sign out" onClick={() => void run(async () => { await call("/auth/sign-out", { body: {} }); setMe(null); setState("signin"); })}><ExitIcon /></button>
          </div>
        </div>
      </nav>
      <main className="va-main">{page}</main>
    </div>;
  }
  return <>{body}</>;
}

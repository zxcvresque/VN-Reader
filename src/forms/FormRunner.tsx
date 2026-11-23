import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ExclamationTriangleIcon, StarFilledIcon } from "@radix-ui/react-icons";
import { INDIA_STATES, MAX_SOCIAL_ACCOUNTS, OTHER_PREFIX, SOCIAL_PLATFORMS, allFields, districtsFor, isEmpty, pagePath, pipeText, validateAnswers, visibleFields } from "../../server/formLogic.mjs";
import { RequestError, call, deviceKind, drafts, telegramInitData, type AnswerValue, type Answers, type FormField, type Outcome, type PublicForm, type SocialAccount, type TelegramContact } from "./api";

interface Step { key: string; title: string; description?: string; fields: FormField[] }
function SocialFields({ id, value, onChange, invalid, describedBy }: { id: string; value: AnswerValue | undefined; onChange: (value: AnswerValue) => void; invalid: boolean; describedBy?: string }) {
  const rows: SocialAccount[] = Array.isArray(value) ? value.filter((row): row is SocialAccount => !!row && typeof row === "object") : typeof value === "string" && value ? [{ platform: "", handle: value, custom: true }] : [];
  const update = (index: number, patch: Partial<SocialAccount>) => onChange(rows.map((row, position) => position === index ? { ...row, ...patch } : row));
  return <div className="va-stack" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
    {rows.map((row, index) => {
      const custom = row.custom || (!!row.platform && !SOCIAL_PLATFORMS.includes(row.platform));
      return <div className="vf-social-row" key={index}>
        <label className="vg-label">Platform<select className="vg-select" value={custom ? "other" : row.platform} onChange={event => update(index, { platform: event.target.value === "other" ? "" : event.target.value, custom: event.target.value === "other" })}><option value="">Choose a platform…</option>{SOCIAL_PLATFORMS.map(platform => <option key={platform}>{platform}</option>)}<option value="other">Custom platform</option></select></label>
        {custom && <label className="vg-label">Platform name<input className="vg-input" value={row.platform} maxLength={60} onChange={event => update(index, { platform: event.target.value })} /></label>}
        <label className="vg-label">Username or user ID<input className="vg-input" value={row.handle} maxLength={160} autoCapitalize="none" spellCheck={false} onChange={event => update(index, { handle: event.target.value })} /></label>
        <button type="button" className="vg-btn is-quiet" aria-label={`Remove account ${index + 1}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}>Remove</button>
      </div>;
    })}
    {rows.length < MAX_SOCIAL_ACCOUNTS && <div><button id={id} type="button" className="vg-btn is-small" onClick={() => onChange([...rows, { platform: "", handle: "" }])}>Add account</button></div>}
  </div>;
}

interface Props { form: PublicForm; prefill?: Record<string, string>; via?: string; preview?: boolean; onDone?: (outcome: Outcome, receipt: string) => void }

function FieldInput({ field, value, state, onChange, invalid, describedBy }: { field: FormField; state?: AnswerValue; value: AnswerValue | undefined; onChange: (value: AnswerValue | undefined) => void; invalid: boolean; describedBy?: string }) {
  const id = `q-${field.id}`, common = { id, "aria-invalid": invalid || undefined, "aria-describedby": describedBy };
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const other = (candidate: unknown) => typeof candidate === "string" && candidate.startsWith(OTHER_PREFIX);
  switch (field.type) {
    case "district": {
      if (state === "Outside India") return <input {...common} className="vg-input" value={text} maxLength={120} onChange={event => onChange(event.target.value)} />;
      const districts = districtsFor(state);
      return <select {...common} className="vg-select" disabled={!districts.length} value={districts.includes(text) ? text : ""} onChange={event => onChange(event.target.value || undefined)}>
        <option value="">{districts.length ? "Choose your district…" : "Choose your state or UT first"}</option>
        {districts.map(district => <option key={district}>{district}</option>)}
      </select>;
    }
    case "social": return <SocialFields {...{ id, value, onChange, invalid, describedBy }} />;
    case "long": return <textarea {...common} className="vg-textarea" value={text} placeholder={field.placeholder} maxLength={5000} onChange={event => onChange(event.target.value)} />;
    case "short": case "email": case "phone": case "url": case "number": case "date": case "time": {
      const type = { short: "text", email: "email", phone: "tel", url: "url", number: "number", date: "date", time: "time" }[field.type];
      const autoComplete = field.role === "name" ? "name" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : undefined;
      return <input {...common} className="vg-input" type={type} inputMode={field.type === "number" ? "decimal" : undefined} autoComplete={autoComplete} value={text} placeholder={field.placeholder} maxLength={field.type === "short" ? 500 : field.type === "phone" ? 40 : field.type === "email" ? 254 : undefined} min={field.validation?.min} max={field.validation?.max} onChange={event => onChange(event.target.value)} />;
    }
    case "dropdown": return <select {...common} className="vg-select" value={text} onChange={event => onChange(event.target.value || undefined)}><option value="">Choose…</option>{field.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
    case "state": return <select {...common} className="vg-select" value={text} autoComplete="address-level1" onChange={event => onChange(event.target.value || undefined)}><option value="">Choose your state or UT…</option>{INDIA_STATES.map(state => <option key={state} value={state}>{state}</option>)}</select>;
    case "yesno": return <div className="vf-options is-row" role="radiogroup" aria-labelledby={`${id}-label`}>{[["yes", "Yes"], ["no", "No"]].map(([key, label]) => <label key={key} className="vf-option" data-kind="single"><input type="radio" name={id} checked={value === key} onChange={() => onChange(key)} /><span className="vf-mark" /><span>{label}</span></label>)}</div>;
    case "single": {
      const otherValue = other(value) ? String(value).slice(1) : null;
      return <div className="vf-options" role="radiogroup" aria-labelledby={`${id}-label`}>
        {field.options?.map(option => <label key={option.id} className="vf-option" data-kind="single"><input type="radio" name={id} checked={value === option.id} onChange={() => onChange(option.id)} /><span className="vf-mark" /><span>{option.label}</span></label>)}
        {field.allowOther && <label className="vf-option" data-kind="single"><input type="radio" name={id} checked={otherValue !== null} onChange={() => onChange(OTHER_PREFIX)} /><span className="vf-mark" /><span>Other</span></label>}
        {otherValue !== null && <input className="vg-input" autoFocus aria-label="Your answer" placeholder="Type your answer" value={otherValue} maxLength={300} onChange={event => onChange(OTHER_PREFIX + event.target.value)} />}
      </div>;
    }
    case "multi": {
      const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [], otherValue = list.find(other)?.slice(1) ?? null;
      const toggle = (key: string) => { const next = list.includes(key) ? list.filter(item => item !== key) : [...list, key]; onChange(next.length ? next : undefined); };
      return <div className="vf-options" role="group" aria-labelledby={`${id}-label`}>
        {field.options?.map(option => <label key={option.id} className="vf-option" data-kind="multi"><input type="checkbox" checked={list.includes(option.id)} onChange={() => toggle(option.id)} /><span className="vf-mark" /><span>{option.label}</span></label>)}
        {field.allowOther && <label className="vf-option" data-kind="multi"><input type="checkbox" checked={otherValue !== null} onChange={() => onChange(otherValue !== null ? (list.filter(item => !other(item)).length ? list.filter(item => !other(item)) : undefined) : [...list, OTHER_PREFIX])} /><span className="vf-mark" /><span>Other</span></label>}
        {otherValue !== null && <input className="vg-input" autoFocus aria-label="Your answer" placeholder="Type your answer" value={otherValue} maxLength={300} onChange={event => onChange([...list.filter(item => !other(item)), OTHER_PREFIX + event.target.value])} />}
      </div>;
    }
    case "scale": {
      const min = field.scale?.min ?? 1, max = field.scale?.max ?? 5;
      return <div><div className="vf-scale" role="radiogroup" aria-labelledby={`${id}-label`}>{Array.from({ length: max - min + 1 }, (_, index) => min + index).map(number => <label key={number}><input type="radio" name={id} checked={Number(value) === number && !isEmpty(value)} onChange={() => onChange(number)} />{number}</label>)}</div>
        {(field.scale?.minLabel || field.scale?.maxLabel) && <div className="vf-scale-ends"><span>{field.scale?.minLabel}</span><span>{field.scale?.maxLabel}</span></div>}</div>;
    }
    case "rating": { const max = field.scale?.max ?? 5, current = Number(value) || 0; return <div className="vf-stars" role="group" aria-labelledby={`${id}-label`}>{Array.from({ length: max }, (_, index) => index + 1).map(number => <button type="button" key={number} aria-pressed={number <= current} aria-label={`${number} of ${max}`} onClick={() => onChange(number === current ? undefined : number)}><StarFilledIcon /></button>)}</div>; }
    case "consent": return <label className="vf-option vf-consent" data-kind="multi"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked || undefined)} /><span className="vf-mark" /><span>{field.placeholder || "I agree"}</span></label>;
    default: return null;
  }
}

export default function FormRunner({ form, prefill = {}, via = "", preview = false, onDone }: Props) {
  const { schema, theme } = form;
  const saved = useMemo(() => (preview ? null : drafts.get(form.slug)), [form.slug, preview]);
  const fields = useMemo(() => allFields(schema), [schema]);
  const [answers, setAnswers] = useState<Answers>(() => ({ ...prefill, ...(saved?.answers ?? {}) }));
  const telegramStorageKey = `vn-form-telegram:${form.slug}`;
  const [telegramKey, setTelegramKey] = useState(() => {
    try { return preview ? "" : sessionStorage.getItem(telegramStorageKey) ?? ""; } catch { return ""; }
  });
  const [telegram, setTelegram] = useState<TelegramContact | null>(null);
  const [telegramUrl, setTelegramUrl] = useState("");
  const [telegramProblem, setTelegramProblem] = useState("");
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramPending, setTelegramPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [trap, setTrap] = useState("");
  const startedAt = useRef<number>(saved?.startedAt ?? 0);
  const top = useRef<HTMLDivElement>(null);
  const [restored, setRestored] = useState(!!saved);

  const pages = useMemo(() => pagePath(schema, answers), [schema, answers]);
  const steps: Step[] = useMemo(() => {
    const shown = new Set(visibleFields(schema, answers, pages).map(field => field.id));
    if (theme.layout === "focus") return pages.flatMap(page => page.fields.filter(field => shown.has(field.id)).map(field => ({ key: field.id, title: page.title, fields: [field] })));
    return pages.map(page => ({ key: page.id, title: page.title, description: page.description, fields: page.fields.filter(field => shown.has(field.id)) }));
  }, [schema, answers, pages, theme.layout]);
  const path = JSON.stringify(steps.map(item => item.key));
  const firstIncomplete = () => {
    const invalid = validateAnswers(schema, answers).errors;
    return steps.findIndex(item => item.fields.some(field => invalid[field.id]));
  };
  const [cursor, setCursor] = useState<{ key?: string; path: string }>(() => {
    let index = 0;
    if (saved) {
      const previous = steps.findIndex(item => item.key === saved.stepKey);
      const incomplete = firstIncomplete();
      const pathChanged = previous < 0 || saved.stepPath !== path;
      if (incomplete >= 0 && (pathChanged || incomplete < previous)) index = incomplete;
      else index = previous >= 0 ? previous : Math.max(0, steps.length - 1);
    }
    return { key: steps[index]?.key, path };
  });
  const located = steps.findIndex(item => item.key === cursor.key);
  const index = !cursor.key ? 0 : located >= 0 ? located : Math.max(0, firstIncomplete());
  const step = steps[index], last = index >= steps.length - 1;
  const setStepIndex = (target: number) => setCursor({ key: steps[target]?.key, path });

  useEffect(() => { if (preview) return; const key = `vn-form-viewed:${form.slug}`; try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { /* count anyway */ } void call(`/forms/${form.slug}/events`, { body: { kind: "view", via } }).catch(() => {}); }, [form.slug, preview, via]);
  useEffect(() => {
    if (preview || !startedAt.current) return;
    drafts.set(form.slug, { answers, startedAt: startedAt.current, stepKey: cursor.key ?? step?.key, stepPath: cursor.key ? cursor.path : path });
  }, [answers, cursor, form.slug, path, preview, step?.key]);

  const rememberTelegramKey = (key: string) => {
    setTelegramKey(key);
    try { if (key) sessionStorage.setItem(telegramStorageKey, key); else sessionStorage.removeItem(telegramStorageKey); } catch { /* Storage is optional. */ }
  };

  useEffect(() => {
    if (preview || !telegramKey) return;
    let active = true, timer: number | undefined;
    const check = async () => {
      try {
        const { telegram: contact } = await call<{ telegram: TelegramContact | null }>(`/forms/${form.slug}/telegram-link`, { headers: { "X-VN-Telegram-Link": telegramKey } });
        if (!active) return;
        if (contact) {
          setTelegram(contact); setTelegramProblem(""); setTelegramPending(false);
        } else {
          setTelegramPending(true);
          timer = window.setTimeout(check, 5000);
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof RequestError && error.status === 404) {
          try { sessionStorage.removeItem(telegramStorageKey); } catch { /* Storage is optional. */ }
          setTelegramKey(""); setTelegramPending(false); setTelegramUrl(""); setTelegramProblem(error.message);
        } else {
          timer = window.setTimeout(check, 10000);
        }
      }
    };
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [form.slug, preview, telegramKey, telegramStorageKey]);

  async function connectTelegram() {
    setTelegramBusy(true); setTelegramProblem("");
    // Create the tab during the click so browsers allow it.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const link = await call<{ url: string; key: string }>(`/forms/${form.slug}/telegram-link`, { body: {} });
      setTelegram(null);
      rememberTelegramKey(link.key);
      setTelegramUrl(link.url); setTelegramPending(true);
      if (tab) tab.location.replace(link.url);
    } catch (error) {
      tab?.close();
      setTelegramProblem(error instanceof Error ? error.message : "Telegram could not be opened.");
    } finally { setTelegramBusy(false); }
  }

  const start = () => {
    if (startedAt.current) return;
    startedAt.current = Date.now();
    if (!preview) void call(`/forms/${form.slug}/events`, { body: { kind: "start", via } }).catch(() => {});
  };
  const change = (field: FormField, value: AnswerValue | undefined) => {
    start();
    setRestored(false);
    const dependentFields = fields.filter(candidate => candidate.type === "district" && candidate.stateField === field.id);
    setAnswers(current => {
      const next = { ...current };
      if (value === undefined || value === "") delete next[field.id]; else next[field.id] = value;
      if (current[field.id] !== value) for (const dependent of dependentFields) delete next[dependent.id];
      return next;
    });
    setErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== field.id && !dependentFields.some(dependent => dependent.id === id))));
  };
  const scrollTop = () => window.requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  const focusFirstError = (found: Record<string, string>) => window.requestAnimationFrame(() => { const first = Object.keys(found)[0]; const node = first ? document.getElementById(`field-${first}`) : null; node?.scrollIntoView({ behavior: "smooth", block: "center" }); node?.querySelector<HTMLElement>("input,textarea,select,button")?.focus({ preventScroll: true }); });
  const checkStep = () => {
    const all = validateAnswers(schema, answers).errors;
    if (!preview) for (const field of step?.fields ?? []) {
      if (field.type !== "telegram" || all[field.id] || !answers[field.id]) continue;
      if (!telegram) all[field.id] = "Open Telegram from this form and tap Start to verify your user ID.";
      else if (String(answers[field.id]).trim() !== telegram.id) all[field.id] = "Paste the same Telegram user ID the bot sent you.";
    }
    const here = Object.fromEntries(Object.entries(all).filter(([id]) => step?.fields.some(field => field.id === id)));
    setErrors(here); if (Object.keys(here).length) focusFirstError(here);
    return Object.keys(here).length === 0;
  };
  const goTo = (target: number) => { start(); setRestored(false); setStepIndex(target); setProblem(""); scrollTop(); };
  async function submit() {
    const result = validateAnswers(schema, answers);
    if (!result.ok) { const firstBad = steps.findIndex(candidate => candidate.fields.some(field => result.errors[field.id])); setErrors(result.errors); if (firstBad >= 0 && firstBad !== index) setStepIndex(firstBad); focusFirstError(result.errors); return; }
    if (preview) { setProblem("Preview only. Responses are collected from the live form link."); return; }
    setBusy(true); setProblem("");
    try {
      const done = await call<{ receipt: string; outcome: Outcome }>(`/forms/${form.slug}/responses`, { body: { answers: result.clean, via, startedAt: startedAt.current || undefined, device: deviceKind(), initData: telegramInitData(), telegramLink: telegram && telegramKey ? telegramKey : undefined, website: trap } });
      startedAt.current = 0;
      drafts.set(form.slug, null);
      rememberTelegramKey("");
      onDone?.(done.outcome, done.receipt);
    } catch (error) {
      if (error instanceof RequestError && error.errors) {
        setErrors(error.errors);
        const firstBad = steps.findIndex(candidate => candidate.fields.some(field => error.errors?.[field.id]));
        if (firstBad >= 0) setStepIndex(firstBad);
        focusFirstError(error.errors);
      }
      setProblem(error instanceof Error ? error.message : "Your response couldn't be sent. Try again.");
    } finally { setBusy(false); }
  }
  const next = () => { if (!checkStep()) return; if (last) void submit(); else goTo(index + 1); };

  function startOver() {
    drafts.set(form.slug, null);
    startedAt.current = 0;
    setRestored(false);
    setCursor({ path: "" });
    setAnswers({ ...prefill });
    setErrors({});
    setProblem("");
    scrollTop();
  }

  const required = visibleFields(schema, answers, pages).filter(field => field.required);
  const percent = theme.layout === "focus" ? Math.round((index / Math.max(1, steps.length)) * 100) : required.length ? Math.round((required.filter(field => !isEmpty(answers[field.id])).length / required.length) * 100) : 0;
  let number = steps.slice(0, index).reduce((total, candidate) => total + candidate.fields.filter(field => field.type !== "statement").length, 0);
  const renderField = (field: FormField): ReactNode => {
    const error = errors[field.id], label = pipeText(field.label, schema, answers), helpId = field.help ? `q-${field.id}-help` : undefined, errorId = error ? `q-${field.id}-error` : undefined;
    if (field.type === "statement") return <div key={field.id} className="vf-field vg-glass"><p className="vf-q">{label}</p>{field.help && <p className="vf-statement">{pipeText(field.help, schema, answers)}</p>}</div>;
    number += 1;
    const grouped = ["single", "multi", "yesno", "scale", "rating", "social"].includes(field.type);
    const heading = <>{theme.layout === "classic" && <span className="vg-muted vg-num">{number}. </span>}{label}{field.required && <span className="vf-req" aria-hidden="true">*</span>}{field.required && <span className="vg-sr"> (required)</span>}</>;
    const body = <>{field.help && <p className="vf-help" id={helpId}>{pipeText(field.help, schema, answers)}</p>}{field.type === "telegram" ? <div className="va-stack">
      <p className="vf-help" id={`q-${field.id}-telegram-help`}>Open the bot, tap Start, then copy the numeric user ID it gives you and paste it here.</p>
      <div className="va-row">
        {telegramUrl && !telegram && <a className="vg-btn is-small" href={telegramUrl} target="_blank" rel="noopener noreferrer">Open Telegram</a>}
        <button type="button" className="vg-btn is-small" disabled={preview || telegramBusy} onClick={() => void connectTelegram()}>{telegramBusy ? "Opening…" : telegram ? "Change account" : telegramPending ? "Get a new link" : "Get my Telegram ID"}</button>
      </div>
      <input id={`q-${field.id}`} className="vg-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={16}
        value={String(answers[field.id] ?? "")} aria-invalid={!!error || undefined}
        aria-describedby={[helpId, `q-${field.id}-telegram-help`, errorId].filter(Boolean).join(" ")}
        onChange={event => change(field, event.target.value)} />
      {telegramPending && <p className="vf-help" role="status">Waiting for you to tap Start in Telegram.</p>}
      {telegram && String(answers[field.id] ?? "").trim() === telegram.id && <p className="vf-help" role="status">Telegram ID verified{telegram.username ? ` · @${telegram.username}` : ""}.</p>}
      {telegramProblem && <p className="vf-error" role="alert">{telegramProblem}</p>}
    </div> : <FieldInput field={field} value={answers[field.id]} state={field.stateField ? answers[field.stateField] : undefined} onChange={value => change(field, value)} invalid={!!error} describedBy={[helpId, errorId].filter(Boolean).join(" ") || undefined} /> }{error && <p className="vf-error" id={errorId} role="alert"><ExclamationTriangleIcon aria-hidden="true" />{error}</p>}</>;
    return <div key={field.id} id={`field-${field.id}`} className={`vf-field vg-glass ${error ? "has-error" : ""}`}>{grouped ? <fieldset><legend id={`q-${field.id}-label`}>{heading}</legend>{body}</fieldset> : <><label className="vf-q" htmlFor={`q-${field.id}`}>{heading}</label>{body}</>}</div>;
  };

  if (!step) return <div className="vg-glass va-empty"><h3>This form has no questions yet.</h3></div>;
  return <form noValidate onSubmit={event => { event.preventDefault(); next(); }} onKeyDown={event => { if (event.key === "Enter" && theme.layout === "focus" && event.target instanceof HTMLInputElement) { event.preventDefault(); next(); } }}>
    <div ref={top} style={{ scrollMarginTop: 12 }} />
    {form.settings.showProgress && <div className="vf-progress vg-glass" role="status"><div className="vf-progress-track" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div><span className="vg-num">{theme.layout === "focus" ? `${index + 1} of ${steps.length}` : steps.length > 1 ? `Page ${index + 1} of ${steps.length}` : `${percent}% done`}</span></div>}
    {restored && <p className="vg-alert" data-tone="info" style={{ marginBottom: 12 }}>Your draft was restored on this device. <button type="button" className="vg-btn is-quiet is-small" onClick={startOver}>Start over</button></p>}
    <div key={step.key} className={`vf-step-enter ${theme.layout === "focus" ? "vf-focus-step" : ""}`}>
      {(step.title || step.description) && <div className="vf-page-head">{step.title && <h2>{step.title}</h2>}{step.description && <p>{step.description}</p>}</div>}
      <div className="vf-fields">{step.fields.map(renderField)}</div>
    </div>
    <input className="vf-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={trap} onChange={event => setTrap(event.target.value)} />
    {problem && <p className="vg-alert" data-tone={preview ? "info" : "bad"} role="alert" style={{ marginTop: 14 }}>{problem}</p>}
    <div className="vf-nav">
      {index > 0 ? <button type="button" className="vg-btn" onClick={() => goTo(index - 1)} disabled={busy}><ArrowLeftIcon aria-hidden="true" />Back</button> : <span />}
      <button type="submit" className="vg-btn is-primary" disabled={busy}>{busy ? "Sending…" : last ? <><CheckIcon aria-hidden="true" />{theme.submitLabel}</> : <>Continue<ArrowRightIcon aria-hidden="true" /></>}</button>
    </div>
    {!preview && <p className="vf-saved">Your answers are saved on this device as you type, until you submit.</p>}
  </form>;
}

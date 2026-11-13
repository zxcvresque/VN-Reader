import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, Cross2Icon, PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { CHOICE_TYPES, INDIA_STATES, newId } from "../../server/formLogic.mjs";
import { FONT_STACKS, call, type AdminForm, type Condition, type FieldType, type FormField, type FormSettings, type FormTheme, type Operator, type PublicForm, type Rule, type SchemaPage, BACKDROPS } from "../forms/api";
import { FormShell } from "../forms/FormPage";
import FormRunner from "../forms/FormRunner";
import type { AdminContext } from "./AdminApp";
import { Confirm, useAction, useToast } from "./ui";

const TYPES: Array<{ type: FieldType; label: string; mark: string }> = [
  { type: "short", label: "Short answer", mark: "Aa" }, { type: "long", label: "Paragraph", mark: "¶" }, { type: "single", label: "Single choice", mark: "◉" }, { type: "multi", label: "Checkboxes", mark: "☑" },
  { type: "dropdown", label: "Dropdown", mark: "▾" }, { type: "yesno", label: "Yes / No", mark: "Y/N" }, { type: "state", label: "Indian state", mark: "IN" }, { type: "number", label: "Number", mark: "#" },
  { type: "social", label: "Social and messaging accounts", mark: "@" }, { type: "telegram", label: "Verified Telegram account", mark: "TG" },
  { type: "email", label: "Email", mark: "@" }, { type: "phone", label: "Phone", mark: "☎" }, { type: "url", label: "Link", mark: "🔗" }, { type: "date", label: "Date", mark: "D" }, { type: "time", label: "Time", mark: "T" },
  { type: "scale", label: "Linear scale", mark: "1–5" }, { type: "rating", label: "Star rating", mark: "★" }, { type: "consent", label: "Consent box", mark: "✓" }, { type: "statement", label: "Text block", mark: "“" }
];
const typeInfo = (type: FieldType) => type === "district" ? { label: "Indian district", mark: "IN" } : TYPES.find(item => item.type === type) ?? TYPES[0];
const OPERATORS: Array<{ op: Operator; label: string; needsValue: boolean }> = [{ op: "eq", label: "is", needsValue: true }, { op: "neq", label: "is not", needsValue: true }, { op: "contains", label: "contains", needsValue: true }, { op: "not_contains", label: "doesn't contain", needsValue: true }, { op: "gt", label: "is more than", needsValue: true }, { op: "lt", label: "is less than", needsValue: true }, { op: "answered", label: "is answered", needsValue: false }, { op: "empty", label: "is empty", needsValue: false }];
const ROLES = [["", "Nothing special"], ["name", "Respondent's name"], ["state", "State (powers the map)"], ["district", "District or city"], ["phone", "Phone number"], ["email", "Email"], ["telegram", "Telegram account"], ["profession", "Profession"]];
const ACCENTS = ["#f2a23a", "#ef6f4d", "#e2557f", "#8b7bff", "#4c8dff", "#1fb6a6", "#3fae5f", "#d7dbe6"];

function blankField(type: FieldType): FormField {
  const field: FormField = { id: newId("q"), type, label: type === "statement" ? "A note for respondents" : type === "consent" ? "Please confirm" : "" };
  if ((CHOICE_TYPES as string[]).includes(type)) field.options = [{ id: newId("o"), label: "Option 1" }, { id: newId("o"), label: "Option 2" }];
  if (type === "scale") field.scale = { min: 1, max: 5 };
  if (type === "rating") field.scale = { min: 1, max: 5 };
  if (type === "consent") field.placeholder = "I agree";
  if (type === "social") field.label = "Social or messaging accounts";
  if (type === "telegram") { field.label = "Telegram account"; field.role = "telegram"; }
  if (type === "state") { field.label = "State or union territory"; field.role = "state"; }
  return field;
}

function ConditionEditor({ condition, candidates, onChange, emptyLabel }: { condition: Condition | undefined; candidates: FormField[]; onChange: (next: Condition | undefined) => void; emptyLabel: string }) {
  const rules = condition?.rules ?? [];
  const update = (index: number, patch: Partial<Rule>) => onChange({ mode: condition?.mode ?? "all", rules: rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)) });
  if (!candidates.length) return <p className="va-note">Add an earlier question first; conditions depend on previous answers.</p>;
  return <div className="va-stack" style={{ gap: 8 }}>
    {rules.length > 1 && <label className="va-row va-note">Match <select className="vg-select is-small" style={{ width: "auto" }} value={condition?.mode ?? "all"} onChange={event => onChange({ mode: event.target.value as Condition["mode"], rules })}><option value="all">all of these</option><option value="any">any of these</option></select></label>}
    {rules.map((rule, index) => { const source = candidates.find(field => field.id === rule.field), operator = OPERATORS.find(item => item.op === rule.op) ?? OPERATORS[0];
      const choices = source?.type === "yesno" ? [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] : source?.type === "state" ? INDIA_STATES.map(state => ({ id: state, label: state })) : source?.options;
      return <div className="vb-rule" key={index}>
        <select className="vg-select is-small" aria-label="Question" value={rule.field} onChange={event => update(index, { field: event.target.value, value: "" })}>{candidates.map(field => <option key={field.id} value={field.id}>{(field.label || "Untitled question").slice(0, 50)}</option>)}</select>
        <select className="vg-select is-small" aria-label="Condition" value={rule.op} onChange={event => update(index, { op: event.target.value as Operator })}>{OPERATORS.map(item => <option key={item.op} value={item.op}>{item.label}</option>)}</select>
        {operator.needsValue ? (choices && ["eq", "neq"].includes(rule.op) ? <select className="vg-select is-small" aria-label="Value" value={String(rule.value ?? "")} onChange={event => update(index, { value: event.target.value })}><option value="">Choose…</option>{choices.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input className="vg-input is-small" aria-label="Value" value={String(rule.value ?? "")} onChange={event => update(index, { value: event.target.value })} />) : <span />}
        <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Remove condition" onClick={() => { const next = rules.filter((_, position) => position !== index); onChange(next.length ? { mode: condition?.mode ?? "all", rules: next } : undefined); }}><Cross2Icon /></button>
      </div>; })}
    <div><button type="button" className="vg-btn is-small" onClick={() => onChange({ mode: condition?.mode ?? "all", rules: [...rules, { field: candidates[candidates.length - 1].id, op: "eq", value: "" }] })}><PlusIcon aria-hidden="true" />{rules.length ? "Add another condition" : emptyLabel}</button></div>
  </div>;
}

function QuestionEditor({ field, earlier, onChange }: { field: FormField; earlier: FormField[]; onChange: (next: FormField) => void }) {
  const set = (patch: Partial<FormField>) => onChange({ ...field, ...patch });
  const isChoice = (CHOICE_TYPES as string[]).includes(field.type), isText = field.type === "short" || field.type === "long";
  const validation = field.validation ?? {}, setRule = (key: string, value: string) => { const next: Record<string, unknown> = { ...validation }; if (value === "") delete next[key]; else next[key] = ["pattern", "patternMessage"].includes(key) ? value : Number(value); set({ validation: Object.keys(next).length ? next : undefined }); };
  const changeType = (type: FieldType) => { const fresh = blankField(type); onChange({ ...field, type, stateField: type === "district" ? field.stateField : undefined, options: (CHOICE_TYPES as string[]).includes(type) ? field.options ?? fresh.options : undefined, scale: fresh.scale, allowOther: ["single", "multi"].includes(type) ? field.allowOther : undefined, validation: undefined, placeholder: type === "consent" ? field.placeholder || "I agree" : field.placeholder, required: type === "statement" ? undefined : field.required }); };
  return <div className="vb-q-body">
    <div className="va-fieldgrid"><label className="vg-label" style={{ gridColumn: "1 / -1" }}>{field.type === "statement" ? "Heading" : "Question"}<input className="vg-input" value={field.label} maxLength={400} placeholder="Type your question" onChange={event => set({ label: event.target.value })} /></label>
      <label className="vg-label">Answer type<select className="vg-select is-small" value={field.type} onChange={event => changeType(event.target.value as FieldType)}>{(field.type === "district" ? [{ type: "district", label: "Indian district" }, ...TYPES] : TYPES).map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
      {field.type !== "statement" && <label className="vg-label">Use this answer as<select className="vg-select is-small" value={field.role ?? ""} onChange={event => set({ role: event.target.value || undefined })}>{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}</div>
    <label className="vg-label">{field.type === "statement" ? "Text" : "Hint shown under the question (optional)"}<textarea className="vg-textarea" style={{ minHeight: 64 }} value={field.help ?? ""} maxLength={1000} onChange={event => set({ help: event.target.value || undefined })} /></label>
    {field.type === "consent" && <label className="vg-label">Checkbox text<input className="vg-input is-small" value={field.placeholder ?? ""} onChange={event => set({ placeholder: event.target.value })} /></label>}
    {isChoice && <div className="vg-label">Options<div className="vb-opts">{(field.options ?? []).map((option, index) => <div className="vb-opt" key={option.id}>
      <input className="vg-input is-small" aria-label={`Option ${index + 1}`} value={option.label} maxLength={200} onChange={event => set({ options: field.options!.map(item => (item.id === option.id ? { ...item, label: event.target.value } : item)) })} />
      <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Move option up" disabled={index === 0} onClick={() => { const next = [...field.options!]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; set({ options: next }); }}><ArrowUpIcon /></button>
      <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Remove option" disabled={field.options!.length <= 1} onClick={() => set({ options: field.options!.filter(item => item.id !== option.id) })}><Cross2Icon /></button></div>)}</div>
      <div className="va-row"><button type="button" className="vg-btn is-small" onClick={() => set({ options: [...(field.options ?? []), { id: newId("o"), label: `Option ${(field.options?.length ?? 0) + 1}` }] })}><PlusIcon aria-hidden="true" />Add option</button>
        <button type="button" className="vg-btn is-small is-quiet" onClick={() => { const pasted = window.prompt("Paste options, one per line"); if (pasted) set({ options: [...(field.options ?? []), ...pasted.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 60).map(label => ({ id: newId("o"), label }))] }); }}>Paste a list</button></div></div>}
    {(field.type === "scale" || field.type === "rating") && <div className="va-fieldgrid">{field.type === "scale" && <label className="vg-label">Starts at<select className="vg-select is-small" value={field.scale?.min ?? 1} onChange={event => set({ scale: { ...field.scale!, min: Number(event.target.value) } })}><option value={0}>0</option><option value={1}>1</option></select></label>}
      <label className="vg-label">{field.type === "rating" ? "Number of stars" : "Ends at"}<select className="vg-select is-small" value={field.scale?.max ?? 5} onChange={event => set({ scale: { ...field.scale!, max: Number(event.target.value) } })}>{[3, 4, 5, 6, 7, 8, 9, 10].map(value => <option key={value}>{value}</option>)}</select></label>
      {field.type === "scale" && <><label className="vg-label">Low-end label<input className="vg-input is-small" value={field.scale?.minLabel ?? ""} onChange={event => set({ scale: { ...field.scale!, minLabel: event.target.value || undefined } })} /></label><label className="vg-label">High-end label<input className="vg-input is-small" value={field.scale?.maxLabel ?? ""} onChange={event => set({ scale: { ...field.scale!, maxLabel: event.target.value || undefined } })} /></label></>}</div>}
    {(field.type === "number" || field.type === "multi") && <div className="va-fieldgrid"><label className="vg-label">{field.type === "multi" ? "Choose at least" : "Smallest allowed"}<input className="vg-input is-small" type="number" value={validation.min ?? ""} onChange={event => setRule("min", event.target.value)} /></label><label className="vg-label">{field.type === "multi" ? "Choose at most" : "Largest allowed"}<input className="vg-input is-small" type="number" value={validation.max ?? ""} onChange={event => setRule("max", event.target.value)} /></label></div>}
    {isText && <details><summary className="va-note" style={{ cursor: "pointer" }}>Answer rules (length, format)</summary><div className="va-fieldgrid" style={{ marginTop: 10 }}>
      <label className="vg-label">Minimum characters<input className="vg-input is-small" type="number" min={0} value={validation.minLength ?? ""} onChange={event => setRule("minLength", event.target.value)} /></label><label className="vg-label">Maximum characters<input className="vg-input is-small" type="number" min={1} value={validation.maxLength ?? ""} onChange={event => setRule("maxLength", event.target.value)} /></label>
      <label className="vg-label">Must match pattern (regex)<input className="vg-input is-small" value={validation.pattern ?? ""} placeholder="^[0-9]{6}$" onChange={event => setRule("pattern", event.target.value)} /></label><label className="vg-label">Message when it doesn't match<input className="vg-input is-small" value={validation.patternMessage ?? ""} onChange={event => setRule("patternMessage", event.target.value)} /></label></div></details>}
    <div className="va-row" style={{ gap: 20 }}>
      {field.type !== "statement" && <label className="vg-switch"><input type="checkbox" checked={!!field.required} onChange={event => set({ required: event.target.checked || undefined })} /><span>Required</span></label>}
      {["single", "multi"].includes(field.type) && <label className="vg-switch"><input type="checkbox" checked={!!field.allowOther} onChange={event => set({ allowOther: event.target.checked || undefined })} /><span>Allow “Other”</span></label>}
    </div>
    <div className="vb-logic"><strong style={{ fontSize: "0.88rem" }}>Show this question only when…</strong><ConditionEditor condition={field.showIf} candidates={earlier} onChange={showIf => set({ showIf })} emptyLabel="Add a condition" />{!field.showIf && earlier.length > 0 && <p className="va-note">Without a condition, everyone sees this question.</p>}</div>
    <p className="va-note">Tip: write <span className="va-code">{"{{"}{earlier[0]?.id ?? "question_id"}{"}}"}</span> in a later question to repeat an earlier answer. This question's ID is <span className="va-code">{field.id}</span>.</p>
  </div>;
}

type Draft = Pick<AdminForm, "title" | "description" | "slug" | "schema" | "settings" | "theme">;
const draftOf = (form: AdminForm): Draft => ({ title: form.title, description: form.description, slug: form.slug, schema: form.schema, settings: form.settings, theme: form.theme });
const localDate = (iso: string | null) => { if (!iso) return ""; const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export default function BuilderPane({ context, form, hasCustomFont, onSaved, onFont }: { context: AdminContext; form: AdminForm; hasCustomFont: boolean; onSaved: (form: AdminForm) => void; onFont: () => void }) {
  const run = useAction(), toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(form)), [saved, setSaved] = useState(() => JSON.stringify(draftOf(form)));
  const [openId, setOpenId] = useState<string | null>(null), [side, setSide] = useState<"add" | "design" | "settings" | "preview">("add"), [targetPage, setTargetPage] = useState(0), [saving, setSaving] = useState(false), [removing, setRemoving] = useState(false), [previewKey, setPreviewKey] = useState(0);
  const dirty = JSON.stringify(draft) !== saved;
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  const pages = draft.schema.pages, flat = useMemo(() => pages.flatMap(page => page.fields), [pages]);
  const setPages = (next: SchemaPage[]) => setDraft(current => ({ ...current, schema: { pages: next } }));
  const setPage = (index: number, patch: Partial<SchemaPage>) => setPages(pages.map((page, position) => (position === index ? { ...page, ...patch } : page)));
  const setTheme = (patch: Partial<FormTheme>) => setDraft(current => ({ ...current, theme: { ...current.theme, ...patch } }));
  const setSettings = (patch: Partial<FormSettings>) => setDraft(current => ({ ...current, settings: { ...current.settings, ...patch } }));
  const addField = (type: FieldType) => { const field = blankField(type), index = Math.min(targetPage, pages.length - 1); setPage(index, { fields: [...pages[index].fields, field] }); setOpenId(field.id); window.requestAnimationFrame(() => document.getElementById(`edit-${field.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })); };
  const moveField = (pageIndex: number, fieldIndex: number, delta: number) => {
    const next = pages.map(page => ({ ...page, fields: [...page.fields] })), [field] = next[pageIndex].fields.splice(fieldIndex, 1), target = fieldIndex + delta;
    if (target < 0 && pageIndex > 0) next[pageIndex - 1].fields.push(field); else if (target > next[pageIndex].fields.length && pageIndex < next.length - 1) next[pageIndex + 1].fields.unshift(field); else next[pageIndex].fields.splice(Math.max(0, Math.min(next[pageIndex].fields.length, target)), 0, field);
    setPages(next);
  };
  const save = async () => {
    setSaving(true);
    const result = await run(() => call<{ form: AdminForm }>(`/admin/forms/${form.id}`, { method: "PUT", body: draft }), "Saved. The live form is updated.");
    setSaving(false);
    if (result) { const next = draftOf(result.form); setDraft(next); setSaved(JSON.stringify(next)); onSaved(result.form); }
  };
  const uploadFont = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 600 * 1024) { toast("Fonts must be 600 KB or smaller. WOFF2 files are usually the smallest.", "bad"); return; }
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const result = await run(() => call<{ form: AdminForm }>(`/admin/forms/${form.id}/font`, { method: "PUT", body: { name: file.name.replace(/\.[^.]+$/, ""), data: btoa(binary) } }), "Font uploaded and applied.");
    if (result) { setTheme({ font: "custom", fontName: result.form.theme.fontName }); onFont(); }
  };
  const preview: PublicForm = useMemo(() => ({ slug: form.slug, title: draft.title, description: draft.description, availability: "open", schema: draft.schema, theme: draft.theme, settings: { access: "public", oneResponse: "none", requireApproval: draft.settings.requireApproval, showProgress: draft.settings.showProgress, closedMessage: "", opensAt: null, hasReward: draft.settings.reward.enabled, rewardLabel: draft.settings.reward.label } }), [draft, form.slug]);

  let questionNumber = 0;
  const sideTab = (id: typeof side, label: string) => <button type="button" aria-pressed={side === id} onClick={() => setSide(id)}>{label}</button>;
  const section = (title: string, children: ReactNode) => <section className="va-card vg-glass va-stack"><h2>{title}</h2>{children}</section>;
  return <>
    <div className="vb-savebar vg-glass"><span className="va-note" role="status">{dirty ? "You have unsaved changes." : "All changes saved."}</span><div className="va-row">{dirty && <button type="button" className="vg-btn is-quiet is-small" onClick={() => setDraft(JSON.parse(saved))}>Discard</button>}<button type="button" className="vg-btn is-primary is-small" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button></div></div>
    <div className="vb-layout">
      <div className="va-stack">
        <section className="va-card vg-glass va-stack"><label className="vg-label">Form title<input className="vg-input" style={{ fontSize: "1.2rem", fontWeight: 650 }} value={draft.title} maxLength={140} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><label className="vg-label">Introduction shown at the top<textarea className="vg-textarea" style={{ minHeight: 72 }} value={draft.description} maxLength={2000} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></section>
        {pages.map((page, pageIndex) => { const before = pages.slice(0, pageIndex + 1).flatMap(item => item.fields);
          return <section key={page.id} className="vb-page vg-glass" onFocusCapture={() => setTargetPage(pageIndex)}>
            <header><span className="vg-chip is-plain">Page {pageIndex + 1}</span><input className="vg-input is-small" aria-label={`Page ${pageIndex + 1} title`} placeholder="Page title (optional)" value={page.title} maxLength={200} onChange={event => setPage(pageIndex, { title: event.target.value })} />
              <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Move page up" disabled={pageIndex === 0} onClick={() => { const next = [...pages]; [next[pageIndex - 1], next[pageIndex]] = [next[pageIndex], next[pageIndex - 1]]; setPages(next); }}><ArrowUpIcon /></button>
              <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Delete page" disabled={pages.length <= 1} onClick={() => { if (!page.fields.length || window.confirm(`Delete page ${pageIndex + 1} and its ${page.fields.length} questions?`)) setPages(pages.filter((_, position) => position !== pageIndex)); }}><TrashIcon /></button></header>
            {page.fields.length === 0 && <p className="va-note">No questions on this page yet. Pick a question type from “Add”.</p>}
            {page.fields.map((field, fieldIndex) => { const info = typeInfo(field.type), open = openId === field.id; if (field.type !== "statement") questionNumber += 1; const earlier = flat.slice(0, flat.indexOf(field)).filter(item => item.type !== "statement");
              return <div key={field.id} id={`edit-${field.id}`} className="vb-q" data-open={open}>
                <div className="va-row" style={{ flexWrap: "nowrap", gap: 0 }}>
                  <button type="button" className="vb-q-head" aria-expanded={open} onClick={() => setOpenId(open ? null : field.id)}><span className="vb-type" aria-hidden="true">{info.mark}</span><span style={{ minWidth: 0 }}><strong className="va-truncate" style={{ display: "block" }}>{field.type !== "statement" && `${questionNumber}. `}{field.label || "Untitled question"}{field.required && <span className="vf-req">*</span>}</strong><small>{info.label}{field.showIf ? " · shown conditionally" : ""}</small></span></button>
                  <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Move up" disabled={pageIndex === 0 && fieldIndex === 0} onClick={() => moveField(pageIndex, fieldIndex, -1)}><ArrowUpIcon /></button>
                  <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Move down" disabled={pageIndex === pages.length - 1 && fieldIndex === page.fields.length - 1} onClick={() => moveField(pageIndex, fieldIndex, 2)}><ArrowDownIcon /></button>
                  <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Duplicate" onClick={() => { const copy = { ...field, id: newId("q"), options: field.options?.map(option => ({ ...option, id: newId("o") })), role: undefined }; const fields = [...page.fields]; fields.splice(fieldIndex + 1, 0, copy); setPage(pageIndex, { fields }); setOpenId(copy.id); }}><CopyIcon /></button>
                  <button type="button" className="vg-btn is-quiet is-icon is-small" aria-label="Delete question" style={{ marginRight: 6 }} onClick={() => setPage(pageIndex, { fields: page.fields.filter(item => item.id !== field.id) })}><TrashIcon /></button>
                </div>
                {open && <QuestionEditor field={field} earlier={earlier} onChange={next => setPage(pageIndex, { fields: page.fields.map(item => (item.id === field.id ? next : item)) })} />}
              </div>; })}
            {pageIndex < pages.length - 1 && <details className="vb-logic"><summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.88rem" }}>After this page: {page.jumps?.length ? `${page.jumps.length} skip rule${page.jumps.length === 1 ? "" : "s"}` : "continue to the next page"}</summary><div className="va-stack" style={{ marginTop: 10 }}>
              {(page.jumps ?? []).map((jump, jumpIndex) => <div key={jumpIndex} className="va-stack" style={{ gap: 8, paddingBottom: 10, borderBottom: "1px solid var(--vg-hairline)" }}>
                <label className="va-row va-note">Go to <select className="vg-select is-small" style={{ width: "auto" }} value={jump.to} onChange={event => setPage(pageIndex, { jumps: page.jumps!.map((item, position) => (position === jumpIndex ? { ...item, to: event.target.value } : item)) })}>{pages.slice(pageIndex + 1).map((target, offset) => <option key={target.id} value={target.id}>Page {pageIndex + 2 + offset}{target.title ? `: ${target.title}` : ""}</option>)}<option value="submit">Submit the form</option></select> when</label>
                <ConditionEditor condition={jump.when} candidates={before.filter(item => item.type !== "statement")} emptyLabel="Add a condition" onChange={when => setPage(pageIndex, { jumps: when ? page.jumps!.map((item, position) => (position === jumpIndex ? { ...item, when } : item)) : page.jumps!.filter((_, position) => position !== jumpIndex) })} /></div>)}
              {before.some(item => item.type !== "statement") && <div><button type="button" className="vg-btn is-small" onClick={() => { const source = before.filter(item => item.type !== "statement").at(-1)!; setPage(pageIndex, { jumps: [...(page.jumps ?? []), { to: pages[pageIndex + 1].id, when: { mode: "all", rules: [{ field: source.id, op: "eq", value: "" }] } }] }); }}><PlusIcon aria-hidden="true" />Add a skip rule</button></div>}
            </div></details>}
          </section>; })}
        <div><button type="button" className="vg-btn" onClick={() => { setPages([...pages, { id: newId("p"), title: "", fields: [] }]); setTargetPage(pages.length); }}><PlusIcon aria-hidden="true" />Add a page</button></div>
      </div>

      <aside className="vb-side">
        <div className="va-tabs vg-glass" role="group" aria-label="Builder panel">{sideTab("add", "Add")}{sideTab("design", "Design")}{sideTab("settings", "Settings")}{sideTab("preview", "Preview")}</div>
        {side === "add" && section("Add a question", <><p className="va-note">Adds to page {Math.min(targetPage, pages.length - 1) + 1}. Click inside another page to add there.</p><div className="vb-add">{TYPES.map(item => <button type="button" key={item.type} onClick={() => addField(item.type)}><b aria-hidden="true">{item.mark}</b>{item.label}</button>)}</div></>)}
        {side === "design" && <>
          {section("Colour", <><div className="vb-swatches" role="group" aria-label="Accent colour">{ACCENTS.map(color => <button type="button" key={color} aria-label={`Accent ${color}`} aria-pressed={draft.theme.accent === color} style={{ background: color }} onClick={() => setTheme({ accent: color })} />)}<input type="color" aria-label="Custom accent colour" value={draft.theme.accent} onChange={event => setTheme({ accent: event.target.value })} /></div>
            <div className="va-fieldgrid"><label className="vg-label">Appearance<select className="vg-select is-small" value={draft.theme.mode} onChange={event => setTheme({ mode: event.target.value as FormTheme["mode"] })}><option value="auto">Match the visitor's device</option><option value="dark">Always dark</option><option value="light">Always light</option></select></label>
              <label className="vg-label">Background<select className="vg-select is-small" value={draft.theme.backdrop} onChange={event => setTheme({ backdrop: event.target.value as FormTheme["backdrop"] })}>{BACKDROPS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="dawn">Dawn</option><option value="ink">Ink</option><option value="plain">Plain</option></select></label>
              <label className="vg-label">Cards<select className="vg-select is-small" value={draft.theme.surface} onChange={event => setTheme({ surface: event.target.value as FormTheme["surface"] })}><option value="glass">Liquid glass</option><option value="solid">Solid</option><option value="paper">Flat paper</option></select></label>
              <label className="vg-label">Corner roundness<input type="range" min={0} max={32} value={draft.theme.radius} onChange={event => setTheme({ radius: Number(event.target.value) })} style={{ accentColor: "var(--vg-accent)" }} /></label></div></>)}
          {section("Type and layout", <><label className="vg-label">Font<select className="vg-select is-small" value={draft.theme.font} onChange={event => setTheme({ font: event.target.value as FormTheme["font"] })}>{(Object.keys(FONT_STACKS) as Array<FormTheme["font"]>).filter(key => key !== "custom" || hasCustomFont).map(key => <option key={key} value={key}>{key === "custom" ? `Uploaded: ${draft.theme.fontName || "custom font"}` : FONT_STACKS[key].label}</option>)}</select></label>
            <label className="vg-label">Upload your own font<input className="vg-input is-small" type="file" accept=".woff2,.woff,.ttf,.otf,font/*" onChange={event => { void uploadFont(event.target.files?.[0]); event.target.value = ""; }} /><span className="va-note" style={{ fontWeight: 400 }}>WOFF2, WOFF, TTF or OTF up to 600 KB. Stored on your server, not a font service.</span></label>
            <label className="vg-label">Layout<select className="vg-select is-small" value={draft.theme.layout} onChange={event => { setTheme({ layout: event.target.value as FormTheme["layout"] }); setPreviewKey(key => key + 1); }}><option value="classic">Pages of questions</option><option value="focus">One question at a time</option></select></label>
            <label className="vg-label">Submit button text<input className="vg-input is-small" value={draft.theme.submitLabel} maxLength={40} onChange={event => setTheme({ submitLabel: event.target.value })} /></label></>)}
        </>}
        {side === "settings" && <>
          {section("Approval and the gated link", <>
            <label className="vg-switch"><input type="checkbox" checked={draft.settings.requireApproval} onChange={event => setSettings({ requireApproval: event.target.checked })} /><span>Review responses before unlocking<small>When on, people see “pending” until an admin approves them. When off, the link shows right after submitting.</small></span></label>
            <label className="vg-switch"><input type="checkbox" checked={draft.settings.reward.enabled} onChange={event => setSettings({ reward: { ...draft.settings.reward, enabled: event.target.checked } })} /><span>Give a link after {draft.settings.requireApproval ? "approval" : "submitting"}<small>For example a private Telegram group invite. It is never sent to the browser before then.</small></span></label>
            {draft.settings.reward.enabled && <><label className="vg-label">Button text<input className="vg-input is-small" value={draft.settings.reward.label} maxLength={80} onChange={event => setSettings({ reward: { ...draft.settings.reward, label: event.target.value } })} /></label><label className="vg-label">Link<input className="vg-input is-small" type="url" placeholder="https://t.me/+…" value={draft.settings.reward.url} onChange={event => setSettings({ reward: { ...draft.settings.reward, url: event.target.value } })} /></label></>}</>)}
          {section("Messages", <><label className="vg-label">After submitting: heading<input className="vg-input is-small" value={draft.settings.confirmation.title} maxLength={140} onChange={event => setSettings({ confirmation: { ...draft.settings.confirmation, title: event.target.value } })} /></label>
            <label className="vg-label">After submitting: message<textarea className="vg-textarea" style={{ minHeight: 64 }} value={draft.settings.confirmation.message} maxLength={1200} onChange={event => setSettings({ confirmation: { ...draft.settings.confirmation, message: event.target.value } })} /></label>
            <label className="vg-label">When approved<textarea className="vg-textarea" style={{ minHeight: 56 }} value={draft.settings.approvedMessage} maxLength={600} onChange={event => setSettings({ approvedMessage: event.target.value })} /></label>
            <label className="vg-label">When not approved<textarea className="vg-textarea" style={{ minHeight: 56 }} value={draft.settings.rejectedMessage} maxLength={600} onChange={event => setSettings({ rejectedMessage: event.target.value })} /></label>
            <label className="vg-label">When the form is closed<textarea className="vg-textarea" style={{ minHeight: 56 }} value={draft.settings.closedMessage} maxLength={600} onChange={event => setSettings({ closedMessage: event.target.value })} /></label></>)}
          {section("Who can respond", <><label className="vg-label">Access<select className="vg-select is-small" value={draft.settings.access} onChange={event => setSettings({ access: event.target.value as FormSettings["access"] })}><option value="public">Anyone with the link</option><option value="account">Signed-in readers only</option></select></label>
            <label className="vg-label">Limit to one response<select className="vg-select is-small" value={draft.settings.oneResponse} onChange={event => setSettings({ oneResponse: event.target.value as FormSettings["oneResponse"] })}><option value="none">No limit</option><option value="device">Show their status first (they can still add another)</option><option value="account">Per reader account (enforced)</option></select></label>
            <div className="va-fieldgrid"><label className="vg-label">Opens<input className="vg-input is-small" type="datetime-local" value={localDate(draft.settings.opensAt)} onChange={event => setSettings({ opensAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label><label className="vg-label">Closes<input className="vg-input is-small" type="datetime-local" value={localDate(draft.settings.closesAt)} onChange={event => setSettings({ closesAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label></div>
            <label className="vg-label">Stop after this many responses<input className="vg-input is-small" type="number" min={1} placeholder="No limit" value={draft.settings.responseLimit ?? ""} onChange={event => setSettings({ responseLimit: event.target.value ? Number(event.target.value) : null })} /></label>
            <label className="vg-switch"><input type="checkbox" checked={draft.settings.showProgress} onChange={event => setSettings({ showProgress: event.target.checked })} /><span>Show a progress bar</span></label>
            <label className="vg-switch"><input type="checkbox" checked={draft.settings.notifyTelegram} onChange={event => setSettings({ notifyTelegram: event.target.checked })} /><span>Send each response to the Telegram backup channel</span></label></>)}
          {section("Link name", <><label className="vg-label">vidurneeti.xyz/f/<input className="vg-input is-small" value={draft.slug} maxLength={48} onChange={event => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label><p className="va-note">Changing this breaks links and QR codes you've already shared.</p>
            {context.can("responses.delete") && <div><button type="button" className="vg-btn is-small is-danger is-quiet" onClick={() => setRemoving(true)}><TrashIcon aria-hidden="true" />Delete this form</button></div>}</>)}
        </>}
        {side === "preview" && <><div className="va-row" style={{ justifyContent: "space-between" }}><span className="va-note">Live preview of unsaved changes. Nothing is submitted.</span><button type="button" className="vg-btn is-quiet is-small" onClick={() => setPreviewKey(key => key + 1)}>Restart</button></div>
          <div className="vb-preview"><FormShell theme={draft.theme} fontUrl={draft.theme.font === "custom" && hasCustomFont ? `/api/forms/${form.slug}/font` : undefined}><div className="vf-wrap" style={{ paddingTop: 16 }}><header className="vf-hero vg-glass"><h1 style={{ fontSize: "1.6rem" }}>{draft.title}</h1>{draft.description && <p>{draft.description}</p>}</header><FormRunner key={previewKey} form={preview} preview /></div></FormShell></div></>}
      </aside>
    </div>
    {removing && <Confirm title="Delete this form?" body={<>This permanently deletes <strong>{form.title}</strong>, its share links, and every response collected with it. Export a backup first if you might need the data.</>} action="Delete form and responses" danger onClose={() => setRemoving(false)} onConfirm={async () => { const done = await run(() => call(`/admin/forms/${form.id}`, { method: "DELETE" }), "Form deleted."); if (done) { context.reloadForms(); context.go("/admin"); } }} />}
  </>;
}

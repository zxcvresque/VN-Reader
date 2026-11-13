import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, Cross2Icon, DownloadIcon, MixerHorizontalIcon, TrashIcon, UploadIcon } from "@radix-ui/react-icons";
import { allFields, displayAnswer, districtsFor } from "../../server/formLogic.mjs";
import { call, download, type AdminForm, type FormField, type FormResponse } from "../forms/api";
import type { AdminContext } from "./AdminApp";
import ResponseAnswer from "./ResponseAnswer";
import { Confirm, Failure, Loading, Modal, StatusChip, formatDate, number, timeAgo, useAction, useLoad, useToast } from "./ui";

interface Page { total: number; page: number; pageSize: number; responses: FormResponse[]; states: string[] }
interface Filters { q: string; status: string; state: string; district?: string; after?: string; before?: string; link: string; from: string; to: string; sort: string; field: string; value: string }
const EMPTY: Filters = { q: "", status: "", state: "", link: "", from: "", to: "", sort: "newest", field: "", value: "" };

function queryOf(filters: Filters, page?: number): string {
  const query = new URLSearchParams();
  for (const key of ["q", "status", "state", "link"] as const) if (filters[key]) query.set(key, filters[key]);
  if (filters.district !== undefined) query.set("district", filters.district);
  if (filters.after) query.set("from", filters.after);
  if (filters.before) query.set("to", filters.before);
  if (filters.sort === "oldest") query.set("sort", "oldest");
  if (filters.from) query.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) query.set("to", new Date(new Date(`${filters.to}T00:00:00`).getTime() + 86400000).toISOString());
  if (filters.field && filters.value) query.set(`f.${filters.field}`, filters.value);
  if (page) query.set("page", String(page));
  return query.toString();
}

export default function ResponsesPane({ context, form, onChanged }: { context: AdminContext; form: AdminForm; onChanged: () => void }) {
  const { can } = context, run = useAction(), toast = useToast();
  const fields = useMemo(() => allFields(form.schema).filter(field => field.type !== "statement") as FormField[], [form.schema]);
  const byRole = (role: string) => fields.find(field => field.role === role);
  const defaults = useMemo(() => [byRole("name") ?? fields[0], byRole("district"), byRole("phone"), byRole("telegram")].filter(Boolean).map(field => field!.id), [fields]); // eslint-disable-line react-hooks/exhaustive-deps
  const storageKey = `vn-admin-columns:${form.id}`;
  const [columns, setColumns] = useState<string[]>(() => { try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null"); if (Array.isArray(saved)) return saved.filter(id => fields.some(field => field.id === id)); } catch { /* use defaults */ } return defaults; });
  const [filters, setFilters] = useState<Filters>(() => {
    const params = new URLSearchParams(window.location.search);
    return { ...EMPTY, state: params.get("state") ?? "", status: params.get("status") ?? "",
      district: params.get("district") ?? undefined, after: params.get("from") ?? undefined, before: params.get("to") ?? undefined };
  });
  const [search, setSearch] = useState(""), [page, setPage] = useState(1), [selected, setSelected] = useState<Set<string>>(new Set()), [open, setOpen] = useState<FormResponse | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const drawerOpen = open !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [drawerOpen]);
  const [choosing, setChoosing] = useState(false), [confirmDelete, setConfirmDelete] = useState<string[] | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => { setFilters(current => (current.q === search ? current : { ...current, q: search })); }, 300); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [filters]);
  const { data, error, loading, reload } = useLoad(() => call<Page>(`/admin/forms/${form.id}/responses?${queryOf(filters, page)}`), [form.id, filters, page]);
  const links = useLoad(() => call<{ links: Array<{ code: string; label: string }> }>(`/admin/forms/${form.id}/links`), [form.id]);
  useEffect(() => { setNote(open?.note ?? ""); }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Filters>) => setFilters(current => ({ ...current, ...patch }));
  const active = Object.entries(filters).filter(([key, value]) => (key === "district" ? value !== undefined : value) && !(key === "sort") && !(key === "field" && !filters.value)).length;
  const choiceFields = fields.filter(field => ["single", "multi", "dropdown", "yesno"].includes(field.type));
  const filterField = choiceFields.find(field => field.id === filters.field);
  const shown = columns.map(id => fields.find(field => field.id === id)).filter(Boolean) as FormField[];
  const review = async (ids: string[], status: FormResponse["status"]) => {
    const close = drawerClose.current;
    if (close?.closest(".va-drawer")?.contains(document.activeElement)) close.focus();
    setBusy(true);
    const result = await run(() => call<{ updated: FormResponse[] }>(`/admin/forms/${form.id}/responses`, { method: "PATCH", body: { ids, status } }), `${ids.length === 1 ? "Response" : `${ids.length} responses`} ${status === "pending" ? "moved back to pending" : status}.`);
    setBusy(false);
    if (result) {
      setSelected(new Set());
      setOpen(current => current && (result.updated.find(item => item.id === current.id) ?? current));
      reload();
      onChanged();
    }
  };
  const saveNote = async () => { if (!open) return; const result = await run(() => call<{ updated: FormResponse[] }>(`/admin/forms/${form.id}/responses`, { method: "PATCH", body: { ids: [open.id], note } }), "Note saved."); if (result) { setOpen(result.updated[0]); reload(); } };
  const remove = async (ids: string[]) => { const result = await run(() => call<{ removed: string[] }>(`/admin/forms/${form.id}/responses`, { method: "DELETE", body: { ids } }), `${ids.length === 1 ? "Response" : `${ids.length} responses`} deleted.`); if (result) { setSelected(new Set()); setOpen(null); reload(); onChanged(); } };
  const backup = async () => {
    const result = await run(() => call<{ responses: number; telegram: boolean; r2: boolean; telegramConfigured: boolean; r2Enabled: boolean }>(`/admin/forms/${form.id}/backup`, { body: {} }));
    if (!result) return;
    if (!result.telegramConfigured && !result.r2Enabled) toast("No backup destination is set up yet. Add a Telegram channel under Backups and Telegram.", "bad");
    else if (!result.telegram && !result.r2) toast("The backup couldn't be delivered. Check the channel and bot under Backups and Telegram.", "bad");
    else toast(`Backed up ${result.responses} responses to ${[result.telegram && "Telegram", result.r2 && "R2"].filter(Boolean).join(" and ")}.`);
  };
  const rows = data?.responses ?? [], allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const titleField = shown[0] ?? fields[0];
  const drawerKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      setOpen(null);
    } else if (event.key === "Tab") {
      const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], textarea:not(:disabled)");
      const first = controls[0], last = controls[controls.length - 1];
      const target = event.shiftKey && event.target === first ? last : !event.shiftKey && event.target === last ? first : null;
      if (target) { event.preventDefault(); target.focus(); }
    }
  };

  return <>
    <div className="va-filters vg-glass">
      <input className="vg-input is-small" type="search" placeholder="Search names, numbers, any answer…" aria-label="Search responses" value={search} onChange={event => setSearch(event.target.value)} />
      <select className="vg-select is-small" aria-label="Status" value={filters.status} onChange={event => set({ status: event.target.value })}><option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
      {((data?.states.length ?? 0) > 0 || filters.state === "*") && <select className="vg-select is-small" aria-label="State" value={filters.state} onChange={event => set({ state: event.target.value, district: undefined })}><option value="">All states</option>{filters.state === "*" && <option value="*">State not reported</option>}{data?.states.map(state => <option key={state}>{state}</option>)}</select>}
      {!!filters.state && districtsFor(filters.state).length > 0 && fields.some(field => field.type === "district" || field.role === "district") &&
        <select className="vg-select is-small" aria-label="District" value={filters.district === undefined ? "" : filters.district || "*"} onChange={event => set({ district: event.target.value === "*" ? "" : event.target.value || undefined })}>
          <option value="">All districts</option><option value="*">District not identified</option>
          {districtsFor(filters.state).map(name => <option key={name}>{name}</option>)}
        </select>}
      {(filters.after || filters.before) && <span className="vg-chip is-plain">Map date range</span>}
      {(links.data?.links.length ?? 0) > 0 && <select className="vg-select is-small" aria-label="Source link" value={filters.link} onChange={event => set({ link: event.target.value })}><option value="">All sources</option><option value="direct">Direct link</option>{links.data!.links.map(link => <option key={link.code} value={link.code}>{link.label}</option>)}</select>}
      {choiceFields.length > 0 && <select className="vg-select is-small" aria-label="Filter by a question" value={filters.field} onChange={event => set({ field: event.target.value, value: "" })} style={{ maxWidth: 200 }}><option value="">Filter by answer…</option>{choiceFields.map(field => <option key={field.id} value={field.id}>{field.label.slice(0, 48)}</option>)}</select>}
      {filterField && <select className="vg-select is-small" aria-label="Answer" value={filters.value} onChange={event => set({ value: event.target.value })}><option value="">Any answer</option>{(filterField.type === "yesno" ? [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] : filterField.options ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
      <label className="vg-sr" htmlFor="from-date">From date</label><input id="from-date" className="vg-input is-small" type="date" value={filters.from} max={filters.to || undefined} onChange={event => set({ from: event.target.value, after: undefined, before: undefined })} style={{ flex: "0 1 150px" }} />
      <label className="vg-sr" htmlFor="to-date">To date</label><input id="to-date" className="vg-input is-small" type="date" value={filters.to} min={filters.from || undefined} onChange={event => set({ to: event.target.value, after: undefined, before: undefined })} style={{ flex: "0 1 150px" }} />
      <select className="vg-select is-small" aria-label="Sort" value={filters.sort} onChange={event => set({ sort: event.target.value })}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      {active > 0 && <button type="button" className="vg-btn is-quiet is-small" onClick={() => { setSearch(""); setFilters(EMPTY); }}>Clear filters</button>}
    </div>
    <div className="va-row" style={{ justifyContent: "space-between", padding: "0 4px" }}>
      <span className="vg-muted vg-num">{data ? `${number(data.total)} response${data.total === 1 ? "" : "s"}${active ? " match these filters" : ""}` : " "}</span>
      <div className="va-actions">
        <button type="button" className="vg-btn is-small" onClick={() => setChoosing(true)}><MixerHorizontalIcon aria-hidden="true" />Columns</button>
        {can("responses.export") && <><button type="button" className="vg-btn is-small" onClick={() => void run(() => download(`/admin/forms/${form.id}/export?format=csv&${queryOf(filters)}`, `${form.slug}.csv`))}><DownloadIcon aria-hidden="true" />CSV</button>
          <button type="button" className="vg-btn is-small" onClick={() => void run(() => download(`/admin/forms/${form.id}/export?format=json&${queryOf(filters)}`, `${form.slug}.json`))}><DownloadIcon aria-hidden="true" />JSON</button>
          <button type="button" className="vg-btn is-small" onClick={() => void backup()}><UploadIcon aria-hidden="true" />Back up now</button></>}
      </div>
    </div>
    {error ? <Failure message={error} onRetry={reload} /> : !data && loading ? <Loading /> : rows.length === 0 ? <div className="vg-glass va-empty"><h3>{active ? "No responses match these filters" : "No responses yet"}</h3><p>{active ? "Try removing a filter or widening the dates." : form.status === "live" ? "Share the form link or a QR code from the Share tab." : "Publish the form to start collecting responses."}</p></div>
      : <div className="vg-glass va-tablewrap"><table className="va-table">
        <thead><tr><th style={{ width: 40 }}><input type="checkbox" className="va-check" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(row => row.id)))} /></th>{shown.map(field => <th key={field.id}>{field.label.length > 28 ? `${field.label.slice(0, 26)}…` : field.label}</th>)}<th>State</th><th>Status</th><th>Submitted</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} aria-selected={selected.has(row.id)} onClick={event => { opener.current = event.currentTarget.querySelector(".va-open-response"); setOpen(row); }}>
          <td onClick={event => event.stopPropagation()}><input type="checkbox" className="va-check" aria-label="Select response" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
          {shown.map((field, index) => {
            const answer = displayAnswer(field, row.answers[field.id]);
            return <td key={field.id}>{index === 0 ? <button type="button" className="va-open-response"><span className="vg-sr">Open response: </span>{answer || "View response"}</button> : answer || <span className="vg-muted">—</span>}</td>;
          })}
          <td>{row.state ?? <span className="vg-muted">—</span>}</td><td><StatusChip status={row.status} /></td><td className="vg-num" title={formatDate(row.createdAt)}>{shown.length ? timeAgo(row.createdAt) : <button type="button" className="va-open-response"><span className="vg-sr">Open response submitted </span>{timeAgo(row.createdAt)}</button>}</td>
        </tr>)}</tbody>
      </table>
      <div className="va-pager"><span className="vg-num">Page {page} of {pages}</span><div className="va-row"><button type="button" className="vg-btn is-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button type="button" className="vg-btn is-small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></div></div>}
    {selected.size > 0 && <div className="va-bulk vg-glass" role="region" aria-label="Bulk actions"><strong className="vg-num">{selected.size} selected</strong>
      {can("responses.review") && <><button type="button" className="vg-btn is-small is-primary" disabled={busy} onClick={() => void review([...selected], "approved")}><CheckIcon aria-hidden="true" />Approve</button><button type="button" className="vg-btn is-small" disabled={busy} onClick={() => void review([...selected], "rejected")}><Cross2Icon aria-hidden="true" />Reject</button></>}
      {can("responses.delete") && <button type="button" className="vg-btn is-small is-danger" onClick={() => setConfirmDelete([...selected])}><TrashIcon aria-hidden="true" />Delete</button>}
      <button type="button" className="vg-btn is-small is-quiet" onClick={() => setSelected(new Set())}>Clear</button></div>}

    {open && <div className="va-drawer-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(null); }}><aside className="va-drawer vg-glass" role="dialog" aria-modal="true" aria-label="Response details" onKeyDown={drawerKeys}>
      <header><div><StatusChip status={open.status} /><h2 style={{ marginTop: 10, fontSize: "1.4rem" }}>{(titleField && displayAnswer(titleField, open.answers[titleField.id])) || "Response"}</h2><p className="vg-muted vg-num" style={{ fontSize: "0.86rem", marginTop: 4 }}>Submitted {formatDate(open.createdAt)}{open.reviewedBy ? ` · reviewed by ${open.reviewedBy}` : ""}</p></div><button type="button" ref={drawerClose} className="vg-btn is-quiet is-icon" aria-label="Close" autoFocus onClick={() => setOpen(null)}><Cross2Icon aria-hidden="true" /></button></header>
      {can("responses.review") && <div className="va-row">
        {open.status !== "approved" && <button type="button" className="vg-btn is-primary" disabled={busy} onClick={() => void review([open.id], "approved")}><CheckIcon aria-hidden="true" />Approve{form.settings.reward.enabled ? " and unlock link" : ""}</button>}
        {open.status !== "rejected" && <button type="button" className="vg-btn" disabled={busy} onClick={() => void review([open.id], "rejected")}><Cross2Icon aria-hidden="true" />Reject</button>}
        {open.status !== "pending" && <button type="button" className="vg-btn is-quiet" disabled={busy} onClick={() => void review([open.id], "pending")}>Move back to pending</button>}
      </div>}
      <div className="va-row">{[open.link ? `Source: ${links.data?.links.find(link => link.code === open.link)?.label ?? open.link}` : "Direct link", open.device && `Device: ${open.device}`, open.durationMs && `Took ${Math.max(1, Math.round(open.durationMs / 60000))} min`, open.telegram && `Telegram ID: ${open.telegram.id}${open.telegram.username ? ` (@${open.telegram.username})` : ""}`, open.hasAccount && "Signed-in reader", open.synced && "Mirrored to R2"].filter(Boolean).map(item => <span key={String(item)} className="vg-chip is-plain">{item}</span>)}</div>
      <dl className="va-answers">{fields.map(field => <ResponseAnswer key={field.id} field={field} answer={open.answers[field.id]} />)}</dl>
      {can("responses.review") && <label className="vg-label">Private note for admins<textarea className="vg-textarea" style={{ minHeight: 80 }} value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="Why it was approved or rejected, follow-ups…" /><span><button type="button" className="vg-btn is-small" disabled={note === open.note} onClick={() => void saveNote()}>Save note</button></span></label>}
      {can("responses.delete") && <div><button type="button" className="vg-btn is-small is-danger is-quiet" onClick={() => setConfirmDelete([open.id])}><TrashIcon aria-hidden="true" />Delete this response</button></div>}
      <p className="va-note">Response ID <span className="va-code">{open.id}</span></p>
    </aside></div>}
    {choosing && <Modal title="Choose table columns" onClose={() => setChoosing(false)} footer={<><button type="button" className="vg-btn is-quiet" onClick={() => setColumns(defaults)}>Reset</button><button type="button" className="vg-btn is-primary" onClick={() => { try { localStorage.setItem(storageKey, JSON.stringify(columns)); } catch { /* optional */ } setChoosing(false); }}>Done</button></>}>
      <p className="va-note">State, status and submitted time are always shown. Pick up to six more.</p>
      <div className="va-stack" style={{ gap: 4, maxHeight: "50vh", overflowY: "auto" }}>{fields.map(field => <label key={field.id} className="va-row" style={{ minHeight: 36, cursor: "pointer", flexWrap: "nowrap" }}><input type="checkbox" className="va-check" checked={columns.includes(field.id)} disabled={!columns.includes(field.id) && columns.length >= 6} onChange={() => setColumns(current => (current.includes(field.id) ? current.filter(id => id !== field.id) : [...current, field.id]))} /><span>{field.label}</span></label>)}</div>
    </Modal>}
    {confirmDelete && <Confirm title={`Delete ${confirmDelete.length === 1 ? "this response" : `${confirmDelete.length} responses`}?`} body="This removes the answers from the site and from the R2 mirror. It can't be undone. Copies already sent to your Telegram backup channel stay there." action="Delete permanently" danger onConfirm={() => remove(confirmDelete)} onClose={() => setConfirmDelete(null)} />}
  </>;
}

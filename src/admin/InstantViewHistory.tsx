import { useEffect, useId, useState } from "react";
import { CheckCircledIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, Cross2Icon, ExternalLinkIcon, MinusCircledIcon, ReloadIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { call } from "../forms/api";
import { number } from "./ui";

export interface InstantViewCheck {
  id: number; url: string; status: string; checkedAt: number; nextAttempt: number;
  attempts: number; error: string | null;
  legacy?: number;
}
export interface InstantViewHistoryData {
  items: InstantViewCheck[]; page: number; pageSize: number; total: number; totalPages: number; historyStartedAt?: number;
}

function articleLabel(value: string) {
  try {
    const url = new URL(value), host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.split("/").filter(Boolean).at(-1);
    let title = path || host;
    try { title = decodeURIComponent(title); } catch { /* Keep malformed URL escapes readable. */ }
    title = title.replace(/\.(?:html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ").trim();
    return { title: title || host, host };
  } catch { return { title: value, host: "Original link" }; }
}

function CheckedTime({ value }: { value: number | null }) {
  if (!value || !Number.isFinite(value)) return <span className="va-note">Not scheduled</span>;
  const date = new Date(value * 1000);
  return <time className="iv-history-time vg-num" dateTime={date.toISOString()} title={date.toLocaleString()}>
    <span>{new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date)}</span>
    <small>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)}</small>
  </time>;
}

function CheckResult({ entry }: { entry: InstantViewCheck }) {
  const ready = entry.status === "ready", unavailable = entry.status === "unavailable";
  const Icon = ready ? CheckCircledIcon : unavailable ? MinusCircledIcon : ClockIcon;
  const hint = entry.error === "FloodWaitError" ? "Telegram cooldown" : entry.attempts > 1 ? `Attempt ${entry.attempts}` : null;
  return <div className="iv-history-result">
    <span className="iv-history-status" data-result={ready ? "ready" : unavailable ? "unavailable" : "error"} title={entry.error || undefined}>
      <Icon aria-hidden="true" />{ready ? "Cached" : unavailable ? "No Instant View" : "Retry scheduled"}
    </span>
    {hint && <small>{hint}</small>}
  </div>;
}

export default function InstantViewHistory() {
  const id = useId(), [input, setInput] = useState(""), [query, setQuery] = useState("");
  const [status, setStatus] = useState("all"), [page, setPage] = useState(1), [tick, setTick] = useState(0);
  const [data, setData] = useState<InstantViewHistoryData | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    if (input.trim() === query) return;
    const timer = setTimeout(() => { setQuery(input.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [input, query]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    const params = new URLSearchParams({ query, status, page: String(page), pageSize: "20" });
    void call<InstantViewHistoryData>(`/admin/iv-history?${params}`).then(next => { if (active) setData(next); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Check history could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, status, page, tick]);
  const filtered = Boolean(query) || status !== "all";
  const start = data?.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const refresh = () => setTick(value => value + 1);
  return <section className="iv-history" aria-labelledby={`${id}-title`}>
    <header className="iv-history-heading">
      <div><h3 id={`${id}-title`}>Check history</h3><p>Every saved check, newest first. Search across the full history.</p></div>
      <button type="button" className="vg-btn is-small" disabled={loading} onClick={refresh}><ReloadIcon aria-hidden="true" />{loading && data ? "Refreshing…" : "Refresh history"}</button>
    </header>
    <div className="iv-history-tools">
      <div className="iv-history-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <label className="vg-sr" htmlFor={`${id}-search`}>Search check history</label>
        <input id={`${id}-search`} type="search" className="vg-input" placeholder="Search by article or website" autoComplete="off" value={input} onChange={event => setInput(event.target.value)} />
        {input && <button type="button" className="iv-history-clear" aria-label="Clear search" onClick={() => setInput("")}><Cross2Icon aria-hidden="true" /></button>}
      </div>
      <label className="iv-history-filter"><span>Result</span><select className="vg-select" aria-label="Filter check results" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="all">All results</option><option value="ready">Cached</option><option value="unavailable">No Instant View</option><option value="error">Retry scheduled</option>
      </select></label>
    </div>
    {error ? <div className="iv-history-empty" role="alert"><strong>History couldn't be loaded</strong><p>{error}</p><button type="button" className="vg-btn is-small" onClick={refresh}>Try again</button></div>
      : loading && !data ? <div className="iv-history-empty" role="status"><span className="vg-spinner" aria-hidden="true" /><p>Loading check history…</p></div>
        : data?.items.length ? <>
          <div className="iv-history-scroll" tabIndex={0} role="region" aria-label="Instant View check history" aria-busy={loading}>
            <table className="iv-history-table"><caption className="vg-sr">Instant View check history, newest checks first</caption>
              <colgroup><col className="iv-history-article-col" /><col /><col /><col /></colgroup>
              <thead><tr><th scope="col">Article</th><th scope="col">Result</th><th scope="col">Checked</th><th scope="col">Scheduled recheck</th></tr></thead>
              <tbody>{data.items.map(entry => {
                const article = articleLabel(entry.url);
                return <tr key={entry.id}>
                  <td className="iv-history-article"><a href={entry.url} target="_blank" rel="noopener noreferrer" title={entry.url}><span className="iv-history-article-title">{article.title}</span><ExternalLinkIcon aria-hidden="true" /><small>{article.host}</small></a></td>
                  <td className="iv-history-result-cell"><CheckResult entry={entry} /></td>
                  <td className="iv-history-checked" data-label="Checked"><CheckedTime value={entry.checkedAt} /></td>
                  <td className="iv-history-next" data-label="Scheduled recheck"><CheckedTime value={entry.nextAttempt} /></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <footer className="iv-history-footer">
            <p className="vg-num" role="status">{loading ? "Updating results…" : <>{number(start)}–{number(end)} of {number(data.total)} {data.total === 1 ? "check" : "checks"}{filtered ? " matching" : ""}</>}</p>
            <nav aria-label="Check history pages"><span className="va-note vg-num">Page {number(data.page)} of {number(data.totalPages)}</span>
              <button type="button" className="vg-btn is-small" disabled={loading || data.page <= 1} aria-label="Previous history page" onClick={() => setPage(Math.max(1, data.page - 1))}><ChevronLeftIcon aria-hidden="true" /><span>Previous</span></button>
              <button type="button" className="vg-btn is-small" disabled={loading || data.page >= data.totalPages} aria-label="Next history page" onClick={() => setPage(data.page + 1)}><span>Next</span><ChevronRightIcon aria-hidden="true" /></button>
            </nav>
          </footer>
          {data.items.some(entry => entry.legacy) && <p className="iv-history-legacy">Older entries show the last result saved before full history began.</p>}
        </> : <div className="iv-history-empty"><strong>{filtered ? "No matching checks" : "No checks yet"}</strong><p>{filtered ? "Try a different website, article name, or result." : "Completed article checks will appear here as the worker fills the cache."}</p>{filtered && <button type="button" className="vg-btn is-small" onClick={() => { setInput(""); setQuery(""); setStatus("all"); setPage(1); }}>Clear filters</button>}</div>}
  </section>;
}

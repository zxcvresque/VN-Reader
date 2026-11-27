import { useEffect, useState } from "react";
import { call } from "../forms/api";
import { Card } from "./charts";
import { formatDate, number, useAction, useLoad } from "./ui";

export interface InstantViewStatus {
  enabled: boolean; paused: boolean; workerOnline: boolean;
  state: "disabled" | "paused" | "cooldown" | "waiting" | "working" | "idle";
  retryAfter: number; heartbeatAt: number | null; lastCheckedAt: number | null;
  counts: { pending: number; ready: number; unavailable: number; error: number };
  total: number; due: number; contentBytes: number; intervalSeconds: number; refreshDays: number;
  recent: Array<{ url: string; status: string; checkedAt: number; nextAttempt: number; attempts: number; error: string | null }>;
}

const date = (value: number | null) => value ? formatDate(new Date(value * 1000).toISOString()) : "Not yet";
const labels: Record<InstantViewStatus["state"], string> = {
  disabled: "Automatic fetching is turned off",
  paused: "Fetching is paused",
  cooldown: "Waiting for Telegram's cooldown",
  waiting: "Waiting for the archive worker",
  working: "Filling the article cache",
  idle: "Cache is up to date",
};

export default function InstantViewPanel({ canControl }: { canControl: boolean }) {
  const run = useAction(), [busy, setBusy] = useState("");
  const { data, setData, error, loading, reload } = useLoad(() => call<InstantViewStatus>("/admin/iv-stats"), []);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const control = async (action: string, done: string) => {
    setBusy(action);
    const next = await run(() => call<InstantViewStatus>("/admin/iv-control", { body: { action } }), done);
    if (next) setData(next);
    setBusy("");
  };
  const checked = data ? data.counts.ready + data.counts.unavailable : 0;
  return <Card title="Instant View articles" note="Articles are prepared in the background and shared by every reader."
    action={<button type="button" className="vg-btn is-small" disabled={loading || !!busy} onClick={reload}>{loading && data ? "Refreshing…" : "Refresh status"}</button>}>
    {error && <p className="vg-alert" data-tone="bad" role="alert">{error}</p>}
    {!data ? !error && <p className="va-note" role="status">Loading the article cache…</p> : <div className="va-stack">
      <div className="va-row" style={{ justifyContent: "space-between" }}>
        <span className="vg-chip" data-tone={data.state === "cooldown" || data.state === "paused" || data.state === "waiting" ? "warn" : data.state === "idle" ? "good" : "info"}>{labels[data.state]}</span>
        <span className="va-note vg-num">{number(checked)} of {number(data.total)} links checked</span>
      </div>
      <progress className="va-iv-progress" aria-label="Links checked for Instant View" value={checked} max={Math.max(1, data.total)} />
      <dl className="va-iv-stats">
        {[["Articles cached", data.counts.ready], ["Waiting", data.counts.pending], ["Unavailable", data.counts.unavailable], ["Retrying errors", data.counts.error]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="vg-num">{number(Number(value))}</dd></div>)}
        <div><dt>Saved content</dt><dd className="vg-num">{(data.contentBytes / 1024 / 1024).toFixed(1)} MB</dd></div>
      </dl>
      {!data.total && <p className="va-note">No article links have been queued yet. Discovery runs when the archive worker starts and whenever a new post is saved.</p>}
      {data.state === "cooldown" && <p className="vg-alert" data-tone="warn">Telegram requested a pause of approximately {data.retryAfter < 60 ? `${data.retryAfter} seconds` : `${Math.ceil(data.retryAfter / 60)} minutes`}. The queue resumes automatically afterward.</p>}
      {data.state === "waiting" && <p className="va-note">The worker hasn't checked in recently. The saved queue will continue when the archive worker is running.</p>}
      {data.paused && <p className="va-note">The current fetch can finish. Saved articles remain available to readers.</p>}
      {!data.enabled && <p className="va-note">Automatic fetching is disabled in the server configuration. Saved articles remain available.</p>}
      <p className="va-note">One fetch at a time, at least {data.intervalSeconds} seconds apart. Available and unavailable pages are checked again after {data.refreshDays} days. Last check: {date(data.lastCheckedAt)}.</p>
      {canControl && <div className="va-row">
        <button type="button" className="vg-btn is-small" disabled={!!busy || !data.enabled} onClick={() => void control(data.paused ? "resume" : "pause", data.paused ? "Article fetching resumed." : "Article fetching paused.")}>{busy === "pause" || busy === "resume" ? "Saving…" : data.paused ? "Resume fetching" : "Pause fetching"}</button>
        <button type="button" className="vg-btn is-small" disabled={!!busy} onClick={() => void control("discover", "Archive links scanned. New links are queued.")}>{busy === "discover" ? "Scanning…" : "Discover archive links"}</button>
        <button type="button" className="vg-btn is-small" disabled={!!busy || !data.counts.error} onClick={() => void control("retry-errors", "Failed checks queued for another attempt.")}>Retry failed checks</button>
        <button type="button" className="vg-btn is-small" disabled={!!busy || !data.counts.unavailable} onClick={() => void control("recheck-unavailable", "Unavailable links queued for another check.")}>Recheck unavailable</button>
        <button type="button" className="vg-btn is-small" disabled={!!busy || !data.counts.ready} onClick={() => void control("refresh-articles", "Saved articles queued for a refresh. Existing copies remain readable.")}>Refresh saved articles</button>
      </div>}
      {data.recent.length > 0 && <details><summary>Recent checks</summary><div className="va-tablewrap va-iv-recent" tabIndex={0} aria-label="Recent Instant View checks"><table className="va-table"><thead><tr><th>Article link</th><th>Result</th><th>Checked</th><th>Next check</th></tr></thead><tbody>{data.recent.map(entry => <tr key={entry.url} style={{ cursor: "default" }}><td><a href={entry.url} target="_blank" rel="noopener noreferrer" title={entry.url}>{entry.url}</a></td><td>{entry.status === "ready" ? "Cached" : entry.status === "unavailable" ? "No Instant View" : "Retry scheduled"}{entry.error && entry.error !== "InstantViewUnavailable" && <small className="va-iv-error">{entry.error}</small>}</td><td className="vg-num">{date(entry.checkedAt)}</td><td className="vg-num">{date(entry.nextAttempt)}</td></tr>)}</tbody></table></div></details>}
    </div>}
  </Card>;
}

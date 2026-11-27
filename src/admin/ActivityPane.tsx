import { useState } from "react";
import { call } from "../forms/api";
import type { AdminDashboardData } from "../lib/admin";
import { fetchR2Stats, postR2Control, type R2StatsResponse } from "../lib/r2Admin";
import { Card } from "./charts";
import { Failure, Loading, formatDate, number, useAction, useLoad } from "./ui";
import InstantViewPanel from "./InstantViewPanel";

const size = (bytes?: number) => (bytes === undefined ? "—" : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export default function ActivityPane({ canControl }: { canControl: boolean }) {
  const run = useAction(), [control, setControl] = useState("");
  const [day, setDay] = useState(""), [page, setPage] = useState(1);
  const { data, error, loading, reload } = useLoad(() => call<AdminDashboardData>(`/admin/dashboard?page=${page}${day ? `&day=${day}` : ""}`), [day, page]);
  const storage = useLoad<R2StatsResponse | null>(() => fetchR2Stats().catch(() => null), []);
  const act = async (action: string, done: string) => { setControl(action); await run(() => postR2Control(action), done); setControl(""); storage.reload(); };
  if (error) return <Failure message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const flags = storage.data?.flags;
  const { summary } = data, pages = Math.max(1, Math.ceil(Math.max(data.pagination.totalUsers, data.pagination.totalSignIns) / data.pagination.pageSize));
  return <>
    <header className="va-head"><div><h1>Reader activity</h1><p>Registrations, sign-ins and the daily email allowance for the reader site. Times use {summary.timezone}.</p></div>
      <div className="va-actions"><label className="vg-sr" htmlFor="activity-day">Activity date</label><input id="activity-day" className="vg-input is-small" type="date" style={{ width: "auto" }} value={day || summary.day} onChange={event => { setPage(1); setDay(event.target.value); }} /><button type="button" className="vg-btn is-small" onClick={() => { setDay(""); setPage(1); }}>Today</button><button type="button" className="vg-btn is-small" disabled={loading} onClick={reload}>{loading ? "Refreshing…" : "Refresh"}</button></div></header>
    <div className="va-tiles">
      {[["New registrations", summary.registrations, ""], ["Sign-ins", summary.signIns, `${summary.uniqueSignIns} different readers`], ["Reader accounts", data.pagination.totalUsers, "all time"], ["Email codes sent", summary.used, `${summary.remaining} of ${summary.limit} left today`]].map(([label, value, note]) => <div key={String(label)} className="va-tile vg-glass"><span>{label}</span><strong>{number(Number(value))}</strong><small>{note}</small></div>)}
    </div>
    {summary.accepted !== undefined && <p className="va-note">Email delivery on {summary.day}: {summary.accepted} accepted, {summary.failed ?? 0} failed, {summary.uncertain ?? 0} uncertain. Uncertain sends keep their slot so the allowance is never exceeded.</p>}
    <Card title="Registered readers" note={`${number(data.pagination.totalUsers)} accounts`}><div className="va-tablewrap" style={{ maxHeight: 420, overflowY: "auto" }}><table className="va-table"><thead><tr><th>Email</th><th>Status</th><th>Registered</th><th>Sign-ins</th></tr></thead><tbody>{data.users.map(user => <tr key={user.id} style={{ cursor: "default" }}><td>{user.email}</td><td><span className="vg-chip" data-tone={user.emailVerified ? "good" : "warn"}>{user.emailVerified ? "Verified" : "Unverified"}</span></td><td className="vg-num">{formatDate(user.createdAt, false)}</td><td className="vg-num">{user.signInCount}</td></tr>)}</tbody></table></div>{!data.users.length && <p className="va-note">No accounts yet.</p>}</Card>
    <Card title={`Sign-ins on ${summary.day}`} note={`${number(data.pagination.totalSignIns)} events`}>{data.signIns.length ? <div className="va-tablewrap" style={{ maxHeight: 420, overflowY: "auto" }}><table className="va-table"><thead><tr><th>Email</th><th>Time</th><th>How</th></tr></thead><tbody>{data.signIns.map(event => <tr key={event.id} style={{ cursor: "default" }}><td>{event.email}</td><td className="vg-num">{formatDate(event.occurredAt)}</td><td>{event.kind === "verification" ? "Email verified" : "Password"}</td></tr>)}</tbody></table></div> : <p className="va-note">No sign-ins on this day.</p>}</Card>
    {pages > 1 && <div className="va-pager vg-glass" style={{ borderRadius: 999 }}><span className="vg-num">Page {page} of {pages}</span><div className="va-row"><button type="button" className="vg-btn is-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button type="button" className="vg-btn is-small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></div>}
    <Card title="Media storage (R2)" note="The public bucket that serves archive photos and video.">
      {storage.loading ? <p className="va-note">Checking storage…</p> : !storage.data ? <p className="va-note">The archive service didn't answer. Storage figures appear here when it is running.</p> : !storage.data.enabled ? <p className="va-note">{storage.data.reason ?? "R2 media storage is turned off."}</p>
        : <div className="va-stack">{(storage.data.accounts ?? []).filter(account => account.configured).map(account => <div key={account.label}><div className="va-row" style={{ justifyContent: "space-between" }}><strong>{account.bucket ?? account.label}</strong><span className="vg-num vg-muted">{size(account.bytesUsed)} of {size(account.quotaBytes)} · {number(account.objects)} files</span></div><div className="vq-rate" style={{ height: 8 }}><i style={{ width: `${Math.min(100, account.percentUsed ?? 0)}%`, background: (account.percentUsed ?? 0) > 90 ? "var(--vg-bad)" : "var(--vg-series-1)" }} /></div>{account.error && <p className="va-note">{account.error}</p>}</div>)}
          {storage.data.flags?.pausedWrites && <p className="vg-alert" data-tone="warn">Uploads are paused{storage.data.flags.autoReason ? `: ${storage.data.flags.autoReason}` : "."}</p>}
          {flags?.pausedReads && <p className="vg-alert" data-tone="warn">Serving media from R2 is paused. Readers get media through Telegram streaming instead.</p>}
          {canControl && <div className="va-row">
            <button type="button" className="vg-btn is-small" disabled={!!control} onClick={() => void act(flags?.pausedWrites ? "r2_unpause_writes" : "r2_pause_writes", flags?.pausedWrites ? "Uploads resumed." : "Uploads paused.")}>{flags?.pausedWrites ? "Resume uploads" : "Pause uploads"}</button>
            <button type="button" className="vg-btn is-small" disabled={!!control} onClick={() => void act(flags?.pausedReads ? "r2_unpause_reads" : "r2_pause_reads", flags?.pausedReads ? "R2 delivery resumed." : "R2 delivery paused.")}>{flags?.pausedReads ? "Resume R2 delivery" : "Pause R2 delivery"}</button>
            {flags?.autoStopped && <button type="button" className="vg-btn is-small" disabled={!!control} onClick={() => void act("r2_clear_auto_stop", "Automatic stop cleared.")}>Clear automatic stop</button>}
          </div>}</div>}
    </Card>
    <InstantViewPanel canControl={canControl} />
  </>;
}

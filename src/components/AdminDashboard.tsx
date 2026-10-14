import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AdminDashboardData } from "../lib/admin";
import { fetchR2Stats, type R2StatsResponse } from "../lib/r2Admin";

function formatBytes(n: number): string {
  if (n >= 1024*1024*1024) return `${(n/1024/1024/1024).toFixed(2)} GB`;
  if (n >= 1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n/1024).toFixed(0)} KB`;
  return `${n} B`;
}

function R2Panel() {
  const [r2,setR2]=useState<R2StatsResponse|null>(null);
  const [r2Err,setR2Err]=useState("");const [r2Busy,setR2Busy]=useState(true);
  const load=async()=>{setR2Busy(true);setR2Err("");try{setR2(await fetchR2Stats());}catch(e){setR2Err(e instanceof Error?e.message:String(e));}finally{setR2Busy(false);}};
  useEffect(()=>{void load();},[]);
  if (r2Busy) return <p role="status">Checking R2 storage…</p>;
  if (r2Err) return <><p role="alert" className="admin-error">{r2Err}</p><button type="button" onClick={()=>void load()}>Retry</button></>;
  if (!r2) return null;
  if (!r2.enabled) return <div className="admin-count-note" style={{border:"1px dashed var(--border)",padding:"0.75rem",borderRadius:"8px"}}><strong>Media storage (R2):</strong> {r2.reason}<br/><small>Set <code>R2_ENABLED=1</code> and <code>R2_*</code> in <code>server/.env</code>. See <code>server/.env.example</code>.</small></div>;
  return <section>
    <div className="admin-section-heading"><h3>Media storage (Cloudflare R2)</h3><button type="button" onClick={()=>void load()}>Refresh</button></div>
    {r2.accounts?.map(acct=>!acct.configured
      ? <p key={acct.label} className="admin-count-note"><strong>{acct.label}:</strong> not configured</p>
      : acct.error
        ? <p key={acct.label} role="alert" className="admin-error">{acct.label}: {acct.error}</p>
        : <div key={acct.label} style={{marginBottom:"0.9rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.9rem",marginBottom:"4px"}}>
              <strong>{acct.label} · {acct.bucket}</strong>
              <span>{formatBytes(acct.bytesUsed!)} / {formatBytes(acct.quotaBytes!)} · {acct.percentUsed}%</span>
            </div>
            <div style={{height:"10px",background:"var(--border)",borderRadius:"999px",overflow:"hidden"}}>
              <div style={{width:`${Math.min(100,acct.percentUsed!)}%`,height:"100%",background:acct.percentUsed!>=95?"#dc2626":acct.percentUsed!>=90?"#d97706":"var(--accent)",transition:"width 0.4s"}}/>
            </div>
            <div style={{display:"flex",gap:"1rem",fontSize:"0.8rem",color:"var(--text-dim)",marginTop:"4px"}}>
              <span>{(acct.objects??0).toLocaleString()} objects</span>
              <span>{formatBytes(acct.bytesFree!)} free</span>
              {acct.publicBase&&<a href={acct.publicBase} target="_blank" rel="noreferrer">{acct.publicBase}</a>}
            </div>
            {acct.percentUsed!>=95&&<p role="alert" className="admin-error" style={{marginTop:"6px"}}>⚠ {acct.label} is {acct.percentUsed}% full — high-priority DM has been sent. {acct.label==="primary"?"New uploads will auto-switch to the secondary bucket at 100%.":"Primary is full; all uploads are now here."}</p>}
            {acct.percentUsed!>=90&&acct.percentUsed!<95&&<p className="admin-count-note" style={{marginTop:"6px"}}>↗ {acct.label} is {acct.percentUsed}% full — you’ll be notified again at 95%.</p>}
          </div>
    )}
    {r2.localR2Rows&&<p className="admin-count-note">Local R2 index: {r2.localR2Rows.objects.toLocaleString()} posts · {formatBytes(r2.localR2Rows.bytes)}</p>}
    <p className="admin-count-note">Free tier: 10 GB per bucket. Auto-switch to secondary at 100% of primary. Notifications at 90% and 95% (+ owner DM at 95%/full).</p>
  </section>;
}

export default function AdminDashboard({onClose}:{onClose:()=>void}) {
  const [data,setData]=useState<AdminDashboardData|null>(null);
  const [day,setDay]=useState("");const [page,setPage]=useState(1);const [attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(true);const [error,setError]=useState("");
  const panel=useRef<HTMLDivElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow="hidden";panel.current?.querySelector<HTMLElement>("button")?.focus();
    const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();closeRef.current();}if(e.key!=="Tab")return;const controls=[...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')??[])].filter(el=>el.getClientRects().length);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}};
    document.addEventListener("keydown",key);return()=>{document.body.style.overflow=overflow;document.removeEventListener("keydown",key);if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{let active=true;const load=async()=>{setBusy(true);setError("");try{const query=new URLSearchParams({page:String(page)});if(day)query.set("day",day);const next=await api<AdminDashboardData>(`/admin/dashboard?${query}`);if(active)setData(next);}catch(e){if(active){setData(null);setError(e instanceof Error?e.message:"The dashboard couldn’t be opened.");}}finally{if(active)setBusy(false);}};void load();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void load();},30000);return()=>{active=false;window.clearInterval(timer);};},[day,page,attempt]);
  const time=(value:string|null)=>value?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:data?.summary.timezone??"UTC"}).format(new Date(value)):"Not signed in yet";
  const pages=data?Math.max(1,Math.ceil(Math.max(data.pagination.totalUsers,data.pagination.totalSignIns)/data.pagination.pageSize)):1;
  return <div className="admin-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="admin-dashboard" ref={panel} role="dialog" aria-modal="true" aria-labelledby="admin-title">
    <header className="admin-header"><div><p className="eyebrow">VN Reader · Admin only</p><h2 id="admin-title">Reader activity</h2><p>Registration, sign-ins, and the daily email allowance.</p></div><button type="button" className="admin-close" onClick={onClose} aria-label="Close admin dashboard">×</button></header>
    <div className="admin-controls"><label>Activity date<input type="date" value={day||data?.summary.day||""} onChange={e=>{setPage(1);setDay(e.target.value);}}/></label><button type="button" onClick={()=>{setDay("");setPage(1);}}>Today</button><button type="button" onClick={()=>setAttempt(n=>n+1)} disabled={busy}>{busy?"Refreshing…":"Refresh"}</button><span>Auto-refreshes every 30 seconds</span></div>
    {error?<p role="alert" className="admin-error">{error}</p>:!data?<p role="status">Opening your dashboard…</p>:<>
      <div className="admin-metrics">{[["New registrations",data.summary.registrations],["Successful sign-ins",data.summary.signIns],["Distinct readers signed in",data.summary.uniqueSignIns],["Email slots used",data.summary.used],["Email slots left",data.summary.remaining],["Daily email allowance",data.summary.limit]].map(([label,count])=><div key={label} className="admin-metric"><span>{label}</span><strong>{Number(count).toLocaleString()}</strong></div>)}</div>
      <p className="admin-count-note">Daily counts and timestamps use {data.summary.timezone}. Email slots include verification, resends, and password reset codes sent by VN Reader. Other sending on your email-provider account is excluded.</p>
      {data.summary.accepted!==undefined&&<p className="admin-count-note">Accepted by email server: {data.summary.accepted} · Failed: {data.summary.failed??0} · Delivery uncertain: {data.summary.uncertain??0}. Uncertain sends retain their slot to avoid exceeding the allowance.</p>}
      <section><div className="admin-section-heading"><h3>Registered readers</h3><span>{data.pagination.totalUsers.toLocaleString()} accounts</span></div><div className="admin-table-scroll" tabIndex={0} aria-label="Registered reader details"><table><thead><tr><th>Email</th><th>Status</th><th>Registered</th><th>Last sign-in</th><th>Sign-ins</th></tr></thead><tbody>{data.users.map(user=><tr key={user.id}><td>{user.email}</td><td><span className={`admin-status ${user.emailVerified?"is-verified":""}`}>{user.emailVerified?"Verified":"Awaiting verification"}</span></td><td>{time(user.createdAt)}</td><td>{time(user.lastSignIn)}</td><td>{user.signInCount}</td></tr>)}</tbody></table>{!data.users.length&&<p>No accounts to show.</p>}</div></section>
      <section><div className="admin-section-heading"><h3>Sign-ins on {data.summary.day}</h3><span>{data.pagination.totalSignIns.toLocaleString()} events</span></div><div className="admin-table-scroll" tabIndex={0} aria-label="Sign-in event details"><table><thead><tr><th>Email</th><th>Time</th><th>Method</th></tr></thead><tbody>{data.signIns.map(event=><tr key={event.id}><td>{event.email}</td><td>{time(event.occurredAt)}</td><td>{event.kind==="verification"?"Email verified":"Password sign-in"}</td></tr>)}</tbody></table>{!data.signIns.length&&<p>No successful sign-ins on this day.</p>}</div></section>
      <R2Panel/>
      <nav className="admin-pagination" aria-label="Dashboard pages"><button type="button" onClick={()=>setPage(n=>Math.max(1,n-1))} disabled={page<=1||busy}>Previous</button><span>Page {page} of {pages}</span><button type="button" onClick={()=>setPage(n=>n+1)} disabled={page>=pages||busy}>Next</button></nav>
    </>}
  </div></div>;
}

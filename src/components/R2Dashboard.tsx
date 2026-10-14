import { useEffect, useState, useCallback } from "react";
import { fetchR2Stats, fetchR2Analytics, postR2Control, type R2StatsResponse, type R2AnalyticsResponse } from "../lib/r2Admin";

function fmtBytes(n: number): string {
  if (n >= 1024*1024*1024) return `${(n/1024/1024/1024).toFixed(2)} GiB`;
  if (n >= 1024*1024) return `${(n/1024/1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n/1024).toFixed(0)} KiB`;
  return `${n} B`;
}
function pctColor(p: number): string {
  if (p >= 98) return "#dc2626";
  if (p >= 95) return "#dc2626";
  if (p >= 90) return "#d97706";
  return "var(--accent)";
}
function Bar({ pct, color }: { pct: number; color: string }) {
  return <div style={{height:10,background:"var(--border)",borderRadius:999,overflow:"hidden"}}>
    <div style={{width:`${Math.min(100,pct)}%`,height:"100%",background:color,transition:"width 0.4s"}}/>
  </div>;
}

export default function R2Dashboard(){
  const [stats,setStats]=useState<R2StatsResponse|null>(null);
  const [analytics,setAnalytics]=useState<R2AnalyticsResponse|null>(null);
  const [err,setErr]=useState(""); const [busy,setBusy]=useState(true);
  const [ctrlBusy,setCtrlBusy]=useState("");
  const load=useCallback(async()=>{
    setBusy(true); setErr("");
    try{
      const [s,a]=await Promise.all([
        fetchR2Stats(),
        fetchR2Analytics().catch(()=>null),
      ]);
      setStats(s); if(a) setAnalytics(a);
    }catch(e){ setErr(e instanceof Error?e.message:String(e)); }
    finally{ setBusy(false); }
  },[]);
  useEffect(()=>{ void load(); },[load]);

  const doControl=async(action:string)=>{
    setCtrlBusy(action);
    try{ await postR2Control(action); await load(); }
    catch(e){ setErr(e instanceof Error?e.message:String(e)); }
    finally{ setCtrlBusy(""); }
  };

  if(busy) return <p role="status">Loading R2 dashboard…</p>;
  if(err) return <><p role="alert" className="admin-error">{err}</p><button type="button" onClick={()=>void load()}>Retry</button></>;
  if(!stats) return null;
  if(!stats.enabled) return <div className="admin-count-note" style={{border:"1px dashed var(--border)",padding:"0.75rem",borderRadius:8}}>
    <strong>Media storage (R2):</strong> {stats.reason}<br/><small>Set <code>R2_ENABLED=1</code> and <code>R2_*</code> in <code>server/.env</code>.</small></div>;

  const acct=stats.accounts?.[0];
  const flags=stats.flags;
  const thresholds=stats.thresholds;
  const warn90Pct=(thresholds?.warn90??0.90)*100, warn95Pct=(thresholds?.warn95??0.95)*100, autoStopPct=(thresholds?.autoStop98??0.98)*100;

  return <section aria-label="R2 storage dashboard">
    <style>{` .r2-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem} @media(max-width:640px){.r2-grid{grid-template-columns:1fr}} .r2-card{border:1px solid var(--border);border-radius:10px;padding:0.75rem} .r2-kbd{font-size:0.78rem;color:var(--text-dim)} .r2-threshold{font-size:0.75rem;color:var(--text-dim);display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:4px}`}</style>
    <div className="admin-section-heading"><h3>Media storage · Cloudflare R2</h3><button type="button" onClick={()=>void load()}>Refresh</button></div>

    {/* Storage gauge */}
    {!acct?.configured ? <p className="admin-count-note"><strong>{acct?.label ?? "primary"}:</strong> not configured</p>
      : acct.error ? <p role="alert" className="admin-error">{acct.label}: {acct.error}</p>
      : <>
        <div className="r2-card">
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.9rem",marginBottom:6}}>
            <strong>{acct.label} · {acct.bucket}</strong>
            <span>{fmtBytes(acct.bytesUsed!)} / {fmtBytes(acct.quotaBytes!)} · {acct.percentUsed}%</span>
          </div>
          <Bar pct={acct.percentUsed ?? 0} color={pctColor(acct.percentUsed ?? 0)} />
          <div className="r2-threshold">
            <span>90% → {warn90Pct.toFixed(0)}%</span><span>95% → {warn95Pct.toFixed(0)}%</span><span>98% auto-stop → {autoStopPct.toFixed(0)}%</span>
          </div>
          {/* Threshold markers overlay hint */}
          <div style={{display:"flex",gap:"1rem",fontSize:"0.8rem",color:"var(--text-dim)",marginTop:6,flexWrap:"wrap"}}>
            <span>{(acct.objects??0).toLocaleString()} objects</span><span>{fmtBytes(acct.bytesFree!)} free</span>
            {acct.publicBase && <a href={acct.publicBase} target="_blank" rel="noreferrer">{acct.publicBase}</a>}
          </div>
          {acct.percentUsed!>=95 && <p role="alert" className="admin-error" style={{marginTop:6}}>⚠ {acct.label} is {acct.percentUsed}% full — critical threshold. Reduce uploads or free space.</p>}
          {acct.percentUsed!>=90 && acct.percentUsed!<95 && <p className="admin-count-note" style={{marginTop:6}}>↗ {acct.label} is {acct.percentUsed}% full — notified at 90%. Next alert at 95%.</p>}
          {flags?.autoStopped && <p role="alert" className="admin-error" style={{marginTop:6}}>⛔ Auto-stopped at 98%: {flags.autoReason || "cap reached"} — writes blocked. Use Clear Auto-Stop.</p>}
        </div>

        {/* Class A / B bars */}
        <div className="r2-grid" style={{marginTop:"0.75rem"}}>
          <div className="r2-card">
            <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
              <strong>Class A (writes)</strong><span>{(acct.classAUsed??0).toLocaleString()} / 1,000,000 · {(acct.classApct??0).toFixed(1)}%</span>
            </div>
            <Bar pct={acct.classApct ?? 0} color={pctColor(acct.classApct ?? 0)} />
            <p className="r2-kbd" style={{marginTop:4}}>PUT / POST / List — resets monthly (UTC).</p>
          </div>
          <div className="r2-card">
            <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.85rem",marginBottom:4}}>
              <strong>Class B (reads)</strong><span>{(acct.classBUsed??0).toLocaleString()} / 10,000,000 · {(acct.classBpct??0).toFixed(1)}%</span>
            </div>
            <Bar pct={acct.classBpct ?? 0} color={pctColor(acct.classBpct ?? 0)} />
            <p className="r2-kbd" style={{marginTop:4}}>GET / HEAD — primary hits edge cache; soft cap.</p>
          </div>
        </div>
      </>}

    {/* Flags row with toggles */}
    <div style={{display:"flex",gap:"0.5rem",flexWrap:"wrap",alignItems:"center",marginTop:"0.75rem"}}>
      <span className="admin-count-note" style={{marginRight:"0.25rem"}}>Controls (owner-only):</span>
      <button type="button" disabled={!!ctrlBusy} onClick={()=>void doControl(flags?.pausedWrites ? "r2_unpause_writes" : "r2_pause_writes")} title={flags?.autoStopped ? "Clear auto-stop first" : undefined}>
        {ctrlBusy==="r2_pause_writes"||ctrlBusy==="r2_unpause_writes"?"…":flags?.pausedWrites ? "▶ Resume Writes" : "⏸ Pause Writes"}
      </button>
      <button type="button" disabled={!!ctrlBusy} onClick={()=>void doControl(flags?.pausedReads ? "r2_unpause_reads" : "r2_pause_reads")}>
        {ctrlBusy==="r2_pause_reads"||ctrlBusy==="r2_unpause_reads"?"…":flags?.pausedReads ? "▶ Resume Reads" : "⏸ Pause Reads"}
      </button>
      {flags?.autoStopped && <button type="button" disabled={!!ctrlBusy} onClick={()=>void doControl("r2_clear_auto_stop")}>{ctrlBusy==="r2_clear_auto_stop"?"…":"✅ Clear Auto-Stop"}</button>}
      <button type="button" disabled={!!ctrlBusy} onClick={()=>void doControl("r2_pause_all")}>⏸ Pause All</button>
      <button type="button" disabled={!!ctrlBusy} onClick={()=>void doControl("r2_resume_all")}>▶ Resume All</button>
    </div>
    {flags && <p className="r2-kbd" style={{marginTop:4}}>
      Paused Writes: {flags.pausedWrites?"yes":"no"} · Paused Reads: {flags.pausedReads?"yes":"no"} · Auto-Stopped: {flags.autoStopped?"yes":"no"}{flags.autoReason?` · ${flags.autoReason}`:""}
    </p>}

    {/* Monthly table */}
    {stats.monthlyCounters && stats.monthlyCounters.length>0 && <div style={{marginTop:"0.75rem"}}>
      <h4 style={{fontSize:"0.9rem",marginBottom:4}}>Monthly counters</h4>
      <div className="admin-table-scroll" tabIndex={0} aria-label="Monthly R2 counters">
        <table><thead><tr><th>Month</th><th>Bucket</th><th>Class</th><th>Count</th></tr></thead>
        <tbody>{stats.monthlyCounters.map((r,i)=><tr key={i}><td>{r.month}</td><td style={{fontSize:"0.85rem"}}>{r.bucket}</td><td>{r.class}</td><td>{r.count.toLocaleString()}</td></tr>)}</tbody></table>
      </div>
    </div>}

    {/* Time-series + top objects */}
    {analytics && <>
      {analytics.storageHistory.length>0 && <div style={{marginTop:"0.75rem"}} className="r2-card">
        <h4 style={{fontSize:"0.9rem",margin:"0 0 4px"}}>Storage history (last 30 days)</h4>
        <div className="admin-table-scroll" tabIndex={0}><table><thead><tr><th>Date</th><th>Bytes used</th><th>Objects</th></tr></thead>
        <tbody>{analytics.storageHistory.map((r,i)=><tr key={i}><td>{r.date}</td><td>{fmtBytes(r.bytesUsed)}</td><td>{r.objects.toLocaleString()}</td></tr>)}</tbody></table></div>
      </div>}
      {analytics.topObjects.length>0 && <div style={{marginTop:"0.75rem"}} className="r2-card">
        <h4 style={{fontSize:"0.9rem",margin:"0 0 4px"}}>Largest objects (top 20)</h4>
        <div className="admin-table-scroll" tabIndex={0}><table><thead><tr><th>Post</th><th>Key</th><th>Size</th></tr></thead>
        <tbody>{analytics.topObjects.map(o=><tr key={o.sourceId}><td>#{o.sourceId}</td><td style={{fontSize:"0.8rem",wordBreak:"break-all"}}>{o.key}</td><td>{o.bytes!=null?fmtBytes(o.bytes):"—"}</td></tr>)}</tbody></table></div>
      </div>}
    </>}

    {stats.localR2Rows && <p className="admin-count-note" style={{marginTop:"0.75rem"}}>Local R2 index: {stats.localR2Rows.objects.toLocaleString()} posts · {fmtBytes(stats.localR2Rows.bytes)}</p>}

    {/* Notes */}
    <div className="admin-count-note" style={{marginTop:"0.75rem",lineHeight:1.5}}>
      <p style={{margin:"0 0 4px"}}><strong>Time hint:</strong> Billing is GB-month average — cap is instantaneous 10 GiB.</p>
      <p style={{margin:"0 0 4px"}}><strong>Public URL note:</strong> Uploads: bot token only, private group only. Bucket not publicly listable. Public URL is edge-cached read-only for indexed keys.</p>
      <p style={{margin:0}}><strong>Secure note:</strong> Token is Object Read&amp;Write scoped to this bucket only. No public upload endpoint — only bot+group via server S3 credentials.</p>
    </div>
  </section>;
}

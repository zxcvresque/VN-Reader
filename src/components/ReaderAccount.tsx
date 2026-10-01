import { useEffect, useRef, useState } from "react";
import { ApiError, authRequest, type AccountUser } from "../lib/api";
import type { useReaderAccount } from "../lib/useReaderAccount";

type AccountController = ReturnType<typeof useReaderAccount>;
type Mode = "login" | "register" | "verify" | "forgot" | "reset";
export default function ReaderAccount({account,onClose,onGuest}:{account:AccountController;onClose:()=>void;onGuest?:()=>void}) {
  const [mode,setMode]=useState<Mode>("login");const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [code,setCode]=useState("");
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");const [cooldown,setCooldown]=useState(0);
  const panel=useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";panel.current?.querySelector<HTMLElement>("input,button")?.focus();const key=(e:KeyboardEvent)=>{
    if(e.key==="Escape"){e.preventDefault();closeRef.current();}
    if(e.key==="Tab"){const items=[...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };document.addEventListener("keydown",key);return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener("keydown",key);if(previous?.isConnected)previous.focus();};},[]);
  useEffect(()=>{if(!cooldown)return;const t=window.setTimeout(()=>setCooldown(v=>v-1),1000);return()=>window.clearTimeout(t);},[cooldown]);
  const changeMode=(next:Mode)=>{setMode(next);setError("");setNotice("");setPassword("");setCode("");};
  async function submit(){setBusy(true);setError("");setNotice("");try{
    if(mode==="register"){await authRequest("register",{email,password});setMode("verify");setPassword("");setNotice("Check your inbox for your six-digit verification code.");setCooldown(60);}
    else if(mode==="verify"){const result=await authRequest<{user:AccountUser}>("verify-email",{email,code});await account.initialize(result.user);setCode("");}
    else if(mode==="login"){const result=await authRequest<{user:AccountUser}>("login",{email,password});await account.initialize(result.user);setPassword("");}
    else if(mode==="forgot"){await authRequest("request-password-reset",{email});setMode("reset");setNotice("If this address has an account, a reset code is on its way.");setCooldown(60);}
    else{await authRequest("reset-password",{email,code,password});changeMode("login");setNotice("Password updated. Sign in with your new password.");}
  }catch(e){setError(e instanceof Error?e.message:"Please try again.");if(e instanceof ApiError&&e.status===403&&mode==="login"){setMode("verify");setPassword("");}}
  finally{setBusy(false);}}
  const titles={login:"Your place, everywhere.",register:"Make a little room for reading.",verify:"Verify your email.",forgot:"Find your way back.",reset:"Choose a new password."};
  return <div className="account-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={panel} className="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title" data-tour="account">
    <header><span className="eyebrow">VN Reader · {account.user?"Your account":"Reading account"}</span><button type="button" aria-label="Close account" onClick={onClose}>×</button></header>
    {account.user?<><h2 id="account-title">Welcome back.</h2><p>{account.user.email}</p><div className="account-sync" role="status"><span className={`sync-dot sync-${account.status}`}/>{({guest:"Browser only",loading:"Opening your reading state…",saving:"Saving across devices…",saved:"Saved across devices",offline:"Saved on this device · sync pending",conflict:"Changes need your attention"})[account.status]}</div>
      {account.message&&<p role="status">{account.message}</p>}
      {account.conflicts.length>0?<div className="account-conflict"><h3>Both devices changed the same information.</h3><p>Export a backup in Settings before choosing a copy if you want to keep both. Other edits have already been combined in the device copy.</p><p>Fields: {account.conflicts.slice(0,8).map(p=>p.replace(/^readingState\./,"")).join(", ")}</p><button disabled={busy} onClick={()=>void account.resolve("device")}>Keep this device’s copy</button><button disabled={busy} onClick={()=>void account.resolve("server")}>Use the server copy</button></div>:null}
      {account.guestImport&&account.ready?<div className="account-import"><h3>Bring your browser reading with you?</h3><p>Your guest notes and progress stay in this browser. You can replace this account’s current archive progress with that browser copy, including its appearance.</p><button onClick={()=>{if(window.confirm("Replace this account’s progress for this archive with the guest copy from this browser?"))account.importGuest();}}>Bring browser progress into my account</button></div>:null}
      <p className="account-explainer">Your notes, saved passages, collections, queue, bookmarks, media position, and appearance travel with this account. Signing out returns to your separate guest reading.</p>
      <div className="account-actions"><button onClick={()=>account.sync()} disabled={account.status==="loading"||account.status==="saving"}>Sync now</button><button onClick={()=>{setBusy(true);void account.logout().catch(e=>setError(e.message)).finally(()=>setBusy(false));}} disabled={busy}>Sign out</button></div>
    </>:<><h2 id="account-title">{titles[mode]}</h2><p>{mode==="verify"?"Enter the six-digit code sent to your email. It expires in 10 minutes.":"Read freely as a guest, or keep your reading progress across devices with an account."}</p>
      {account.config?.accountsEnabled===false?<p className="account-service-note">Email delivery hasn’t been connected to this site yet. Guest reading is available.</p>:null}
      {account.configError?<div className="account-service-note"><p role="alert">The account service couldn’t be reached. Your guest reading is available.</p><button type="button" onClick={account.refreshConfig}>Retry connection</button></div>:null}
      <form onSubmit={e=>{e.preventDefault();void submit();}}>
        <label>Email address<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy} maxLength={254}/></label>
        {["login","register","reset"].includes(mode)?<label>{mode==="reset"?"New password":"Password"}<input type="password" required autoComplete={mode==="login"?"current-password":"new-password"} minLength={mode==="login"?1:12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/>{mode!=="login"&&<small>Use at least 12 characters.</small>}</label>:null}
        {["verify","reset"].includes(mode)?<label>Six-digit email code<input className="account-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} disabled={busy}/></label>:null}
        <button type="submit" className="account-primary" disabled={busy||!account.config?.accountsEnabled}>{busy?"Please wait…":({login:"Sign in",register:"Create account",verify:"Verify and start reading",forgot:"Send reset code",reset:"Update password"})[mode]}</button>
      </form>
      {["verify","reset"].includes(mode)?<button className="btn-ghost" disabled={busy||cooldown>0} onClick={()=>{setBusy(true);setError("");void authRequest(mode==="verify"?"resend-code":"request-password-reset",{email}).then(()=>{setNotice("A new code has been requested. Check your inbox.");setCooldown(60);}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{cooldown?`Resend code in ${cooldown}s`:"Resend email code"}</button>:null}
      <nav className="account-links" aria-label="Account options">{mode==="login"?<><button onClick={()=>changeMode("register")}>Create an account</button><button onClick={()=>changeMode("forgot")}>Forgot password?</button></>:<button onClick={()=>changeMode("login")}>Back to sign in</button>}</nav>
      <button className="account-guest btn-ghost" onClick={onGuest??onClose}>Continue reading as a guest →</button>
    </>}
    {notice&&<p className="account-notice" role="status">{notice}</p>}{error&&<p className="account-error" role="alert">{error}</p>}
  </div></div>;
}

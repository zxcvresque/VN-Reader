import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, authRequest, loadCloudState, saveCloudState, type AccountUser, type SiteConfig } from "./api";
import { mergeDocuments } from "./cloudMerge";
import type { ReadingBackup } from "./backup";

export type SyncStatus = "guest" | "loading" | "saving" | "saved" | "offline" | "conflict";
export function useReaderAccount(document: ReadingBackup, onApply: (data: ReadingBackup, restorePosition?: boolean) => void, onGuest: () => void, validate: (data: unknown) => ReadingBackup) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [status, setStatus] = useState<SyncStatus>("guest");
  const [message, setMessage] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [guestImport, setGuestImport] = useState<ReadingBackup | null>(null);
  const [trigger, setTrigger] = useState(0);
  const state = useRef<{ user: AccountUser | null; chat: number | null; revision: number; base: ReadingBackup | null; generation: number; running: boolean; conflictRemote: ReadingBackup | null; conflictRevision: number }>({ user:null,chat:null,revision:0,base:null,generation:0,running:false,conflictRemote:null,conflictRevision:0 });
  const current = useRef(document); current.current = document;
  const handlers = useRef({onApply,onGuest,validate}); handlers.current={onApply,onGuest,validate};
  const canonical = (d: ReadingBackup): ReadingBackup => ({...d,exportedAt:"2000-01-01T00:00:00.000Z"});
  const cacheKey = (id: string | number, chat: number) => `vn-reader:account:${id}:${chat}`;
  const changed = JSON.stringify(canonical(document));
  const apply = (data: ReadingBackup, restorePosition = false) => {current.current=data;handlers.current.onApply(data,restorePosition);};

  const initialize = useCallback(async (account: AccountUser) => {
    const s=state.current; s.generation++; s.user=account; s.chat=null; s.base=null; s.running=false; s.conflictRemote=null; s.conflictRevision=0;
    setConflicts([]);
    setUser(account); setReady(false); setStatus("loading"); setMessage(""); setTrigger(v=>v+1);
  },[]);
  useEffect(()=>{ let active=true;
    void api<SiteConfig>("/config").then(c=>{if(active)setConfig(c);}).catch(()=>{});
    void api<{user:AccountUser|null}|null>("/auth/get-session").then(result=>{if(active&&result?.user)void initialize(result.user);}).catch(()=>{});
    return()=>{active=false;state.current.generation++;};
  },[initialize]);

  useEffect(()=>{
    const s=state.current, chat=document.chatId;
    if(!user||chat===null||document.readingState.chatId!==chat||s.chat===chat)return;
    s.chat=chat; s.base=null; s.running=true; s.conflictRemote=null;setConflicts([]);
    const generation=++s.generation;setReady(false);setStatus("loading");
    const guest=structuredClone(current.current);setGuestImport(guest);
    const empty:ReadingBackup={...guest,readingState:{version:1,chatId:chat,positions:{},statuses:{},queue:[],notes:{},passages:[],collections:[],media:{}},bookmarks:[],readOverrides:[],readCursor:null};
    // Hydrate account data before networking. Guest work never becomes the account's offline copy.
    let initial=canonical(empty);s.base=initial;s.revision=0;
    try{
      const raw=localStorage.getItem(cacheKey(user.id,chat));
      if(raw){const cached=JSON.parse(raw);initial=canonical(handlers.current.validate(cached.data));s.base=canonical(handlers.current.validate(cached.base));s.revision=cached.revision;}
    }catch{setMessage("The saved account cache could not be restored. Your server copy is intact.");}
    apply(initial,true);setReady(true);
    void loadCloudState(chat).then(remote=>{
      if(s.generation!==generation)return;
      const cloud=remote.data?canonical(handlers.current.validate(remote.data)):canonical(empty);
      const positionUnchanged=JSON.stringify(current.current.readingState.positions)===JSON.stringify(initial.readingState.positions);
      const result=mergeDocuments(s.base!,canonical(current.current),cloud);
      s.base=cloud;s.revision=remote.revision;apply(result.data,positionUnchanged);
      if(result.conflicts.length){s.conflictRemote=cloud;s.conflictRevision=remote.revision;setConflicts(result.conflicts);setStatus("conflict");}
      else setStatus("saved");
    }).catch(error=>{if(s.generation!==generation)return;setMessage(error.message);setStatus("offline");})
      .finally(()=>{if(s.generation===generation)s.running=false;});
  },[user,document.chatId,document.readingState.chatId,trigger]);

  const sync=useCallback(async()=>{
    const s=state.current,account=s.user,chat=s.chat;
    if(!account||chat===null||!s.base||s.running||s.conflictRemote)return;
    s.running=true;const generation=s.generation;setStatus("saving");
    try{
      const remote=await loadCloudState(chat);if(s.generation!==generation)return;
      const cloud=remote.data?canonical(handlers.current.validate(remote.data)):s.base;
      const local=canonical(current.current);
      const result=mergeDocuments(s.base,local,cloud);
      if(result.conflicts.length){s.conflictRemote=cloud;s.conflictRevision=remote.revision;apply(result.data);setConflicts(result.conflicts);setStatus("conflict");return;}
      if(JSON.stringify(result.data)!==JSON.stringify(local))apply(result.data);
      s.base=cloud;s.revision=remote.revision;
      if(JSON.stringify(result.data)!==JSON.stringify(cloud)||remote.data===null){
        const saved=await saveCloudState(chat,result.data,s.revision);if(s.generation!==generation)return;
        s.base=result.data;s.revision=saved.revision;
      }
      localStorage.setItem(cacheKey(account.id,chat),JSON.stringify({base:s.base,data:canonical(current.current),revision:s.revision}));
      setStatus("saved");setMessage("");
    }catch(error){if(s.generation!==generation)return;setStatus("offline");setMessage(error instanceof ApiError&&error.status===401?"Your session expired. Sign in again; your unsynced account data is saved on this device.":error instanceof Error?error.message:"Sync unavailable.");}
    finally{if(s.generation===generation)s.running=false;}
  },[]);
  useEffect(()=>{
    const s=state.current;if(!ready||!user||document.chatId===null||!s.base||s.chat!==document.chatId||document.readingState.chatId!==document.chatId)return;
    try{localStorage.setItem(cacheKey(user.id,document.chatId),JSON.stringify({base:s.base,data:canonical(document),revision:s.revision}));}catch{setMessage("Device storage is full. Keep this page open until sync completes.");}
    const timer=window.setTimeout(()=>void sync(),1200);return()=>window.clearTimeout(timer);
  },[changed,user,ready,sync]);
  useEffect(()=>{if(!user)return;const timer=window.setInterval(()=>void sync(),15000);const online=()=>{if(!state.current.base)setTrigger(v=>v+1);else void sync();};
    window.addEventListener("online",online);const visible=()=>{if(documentVisibility())online();};documentGlobal().addEventListener("visibilitychange",visible);
    return()=>{window.clearInterval(timer);window.removeEventListener("online",online);documentGlobal().removeEventListener("visibilitychange",visible);};
  },[user,sync]);
  function documentGlobal(){return window.document;} function documentVisibility(){return window.document.visibilityState==="visible";}

  const resolve=async(choice:"device"|"server")=>{
    const s=state.current;if(!s.conflictRemote||s.chat===null)return;
    const generation=s.generation,chat=s.chat;
    const target=choice==="device"?canonical(current.current):s.conflictRemote;
    try{
      if(choice==="device"){const saved=await saveCloudState(chat,target,s.conflictRevision);if(s.generation!==generation)return;s.revision=saved.revision;}else s.revision=s.conflictRevision;
      s.base=target;s.conflictRemote=null;setConflicts([]);if(choice==="server")apply(target);setStatus("saved");setMessage("");setTrigger(v=>v+1);
    }catch(error){if(s.generation!==generation)return;setMessage(error instanceof Error?error.message:"Please retry sync.");if(error instanceof ApiError&&[409,412].includes(error.status)){s.conflictRemote=null;setConflicts([]);void sync();}}
  };
  const logout=async()=>{
    // Do not discard pending work merely because logout was pressed.
    if(status==="conflict")throw new Error("Resolve the sync conflict before signing out, or export a reading backup first.");
    await sync();if(state.current.conflictRemote)throw new Error("Both devices changed the same information. Resolve the conflict before signing out.");if(state.current.running)throw new Error("Sync is still saving. Try signing out in a moment.");
    await authRequest("logout",{});
    state.current.generation++;state.current.user=null;state.current.chat=null;state.current.base=null;state.current.conflictRemote=null;
    setUser(null);setReady(false);setStatus("guest");setGuestImport(null);setMessage("");handlers.current.onGuest();
  };
  const flush=(data:ReadingBackup)=>{
    const s=state.current;if(!s.user||s.chat===null||!s.base||data.chatId!==s.chat)return;
    const copy=canonical(data);
    try{localStorage.setItem(cacheKey(s.user.id,s.chat),JSON.stringify({base:s.base,data:copy,revision:s.revision}));}catch{/* Normal saving surfaces storage errors. */}
    if(!s.running&&!s.conflictRemote&&JSON.stringify(copy).length<60000)void saveCloudState(s.chat,copy,s.revision,true).catch(()=>{});
  };
  return {user,config,status,message,ready,conflicts,guestImport,initialize,logout,flush,sync:()=>{if(!state.current.base)setTrigger(v=>v+1);else void sync();},resolve,importGuest:()=>{if(guestImport){apply(guestImport);setGuestImport(null);}}};
}

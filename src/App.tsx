import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, MixerHorizontalIcon, MagnifyingGlassIcon, ResetIcon, BookmarkIcon } from "@radix-ui/react-icons";
import WelcomePage, { FeatureWalkthrough } from "./components/WelcomePage";
import { hasEnteredAsGuest, rememberGuestEntry, shouldOfferTour, rememberTourInvitation } from "./lib/entry";
import ReaderSettings from "./components/ReaderSettings";
import ReadingWidth from "./components/ReadingWidth";
import ReaderGuide from "./components/ReaderGuide";
import AdminDashboard from "./components/AdminDashboard";
import { useSignupCapacity } from "./lib/useSignupCapacity";
import ReaderAccount from "./components/ReaderAccount";
import { useReaderAccount } from "./lib/useReaderAccount";
import { fetchSiteArchive } from "./lib/api";
import type { ReadingBackup } from "./lib/backup";
import type { GuideTopic, TourStep } from "./lib/tours";
import ReadingLibrary from "./components/ReadingLibrary";
import { applyPreferences, loadPreferences, savePreferences, PREFERENCES_KEY, type ReaderPreferences } from "./lib/preferences";
import { createReadingState, loadReadingState, saveReadingState, type ReadingState } from "./lib/readingState";
import { createBackup, parseBackup } from "./lib/backup";
import CommandPalette, { type ViewName } from "./components/CommandPalette";
import MediaLightbox, { type LightboxMedia } from "./components/MediaLightbox";
import MessageCard from "./components/MessageCard";
import ThreadRail from "./components/ThreadRail";
import TopBar from "./components/TopBar";
import PostTimeline from "./components/PostTimeline";
import VirtualizedMessageList, {
  type ReadingPosition,
  type VirtualizedMessageListHandle
} from "./components/VirtualizedMessageList";
import {
  getDirectoryPermission,
  parseTagInput,
  recomputeThreadLinks, buildThreadRecords
} from "./lib/archive";
import {
  deleteBookmark,
  deleteReadOverride,
  loadAppSnapshot,
  putBookmark,
  putReadCursor,
  putReadOverride,
  restoreLegacyReadingState,
  replaceAllMessages, replaceAllThreads, saveManifest, saveDirectoryHandle,
} from "./lib/idb";
import { revokeAllMediaObjectUrls } from "./lib/media";
import type {
  AppSnapshot,
  BookmarkRecord,
  MessageReadOverride,
  MessageRecord,
  ReadCursor,
  ThreadRecord
} from "./types";

interface NavEntry {
  view: ViewName;
  threadKey: string | null;
  messageKey: string | null;
  label: string;
  position: ReadingPosition | null;
}

const EMPTY_SNAPSHOT: AppSnapshot = {
  manifest: null,
  messages: [],
  threads: [],
  bookmarks: [],
  readOverrides: [],
  readCursor: null,
  importSessions: [],
  directoryHandle: null
};

function savedPosition(position:ReadingPosition) {
  const {messageKey: _key,...withinPost}=position;
  return {...withinPost,updatedAt:new Date().toISOString()};
}
function nowIso(): string {
  return new Date().toISOString();
}

function formatDate(value: string | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDayDivider(value: string | null): string {
  if (!value) return "Undated";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(value));
}

function trimPreview(value: string, limit = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "No text content";
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}...`;
}

function bookmarkId(targetType: "message" | "thread", targetKey: string): string {
  return `${targetType}:${targetKey}`;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [entered, setEntered] = useState(hasEnteredAsGuest);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archiveAttempt, setArchiveAttempt] = useState(0);
  const [busyLabel, setBusyLabel] = useState<string | null>("Loading local archive…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ViewName>("read");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [highlightedMessageKey, setHighlightedMessageKey] = useState<string | null>(null);
  const [threadRailOpen, setThreadRailOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [navStack, setNavStack] = useState<NavEntry[]>([]);
  const [forwardStack, setForwardStack] = useState<NavEntry[]>([]);
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadPreferences);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMode,setAccountMode] = useState<"login"|"register">("login");
  const [adminOpen,setAdminOpen] = useState(false);
  const signupCapacity=useSignupCapacity();
  const openAccount=(mode:"login"|"register"="login")=>{setAccountMode(mode);setAccountOpen(true);};
  const accountActiveRef = useRef(false);
  const guestBackupRef = useRef<ReadingBackup | null>(null);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [tourInvitation, setTourInvitation] = useState(shouldOfferTour);
  const basicTourStarted = useRef(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [guideTopic, setGuideTopic] = useState<GuideTopic | null>(null);
  const [guideStep, setGuideStep] = useState<TourStep | null>(null);
  const guideReturnRef = useRef<{ entry: NavEntry; library: boolean; search: boolean; query: string; streamQuery: string; toolsOpen: boolean; windowTop: number; readingPosition: ReadingPosition | null; settings: boolean; settingsScroll: number; reached: boolean; source: {message: MessageRecord; origin: MessageRecord} | null } | null>(null);
  const guideActiveRef = useRef(false);
  const [readerSearchOpen, setReaderSearchOpen] = useState(false);
  const [readerSearch, setReaderSearch] = useState("");
  const [sourcePeek, setSourcePeek] = useState<{message: MessageRecord; origin: MessageRecord} | null>(null);
  const [personal, setPersonal] = useState<ReadingState>(() => createReadingState(null));
  const personalRef = useRef(personal);
  const lastPositionRef = useRef<ReadingPosition | null>(null);
  const pendingPositionRef = useRef<ReadingPosition | null>(null);
  const initialRestoreRef = useRef<number | null>(null);
  const searchReturnRef = useRef<NavEntry | null>(null);
  const positionTimerRef = useRef<number | null>(null);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const appliedNavigationRef = useRef(-1);
  const [backupBusy, setBackupBusy] = useState(false);
  const restoringBackupRef=useRef(false);
  const [sessionMode, setSessionMode] = useState<"posts"|"minutes"|"date">("posts");
  const [sessionValue, setSessionValue] = useState("5");
  const [session, setSession] = useState<{endKey:string; label:string} | null>(null);
  const [sessionReached, setSessionReached] = useState(false);

  const commitPersonal = useCallback((next: ReadingState) => {
    try { if (!accountActiveRef.current) saveReadingState(next); personalRef.current = next; setPersonal(next); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save reading state."); }
  }, []);
  const changePreferences = useCallback((next: ReaderPreferences) => {
    try { if (!accountActiveRef.current) savePreferences(next); applyPreferences(next); setPreferences(next); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save preferences."); }
  }, []);
  useEffect(() => {
    applyPreferences(guideOpen && guideTopic ? { ...preferences, focusMode: false } : preferences);
    document.documentElement.dataset.touring = String(guideOpen && guideTopic !== null);
  }, [preferences, guideOpen, guideTopic]);
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key===PREFERENCES_KEY&&!accountActiveRef.current)setPreferences(loadPreferences());};
    window.addEventListener("storage",sync);return()=>window.removeEventListener("storage",sync);
  },[]);
  useEffect(()=>{
    if(!preferences.focusMode)return;
    setView("read");setLibraryOpen(false);setReaderSearchOpen(false);setSourcePeek(null);setThreadRailOpen(false);
  },[preferences.focusMode]);
  const [lightboxMedia, setLightboxMedia] = useState<LightboxMedia | null>(null);
  const [quoteHighlight, setQuoteHighlight] = useState<{
    messageKey: string;
    offset: number;
    length: number;
    fallbackText: string | null;
  } | null>(null);
  const [directoryPermission, setDirectoryPermission] = useState<
    "granted" | "needs-reattach" | "unsupported"
  >("needs-reattach");

  const timelineRef = useRef<VirtualizedMessageListHandle | null>(null);
  const applyAccountDocument = useCallback((data: ReadingBackup, restorePosition = false) => {
    const initial = guestBackupRef.current === null;
    if (initial) guestBackupRef.current = createBackup(snapshotRef.current, personalRef.current, preferencesRef.current);
    if(positionTimerRef.current){window.clearTimeout(positionTimerRef.current);positionTimerRef.current=null;}
    personalRef.current=data.readingState;setPersonal(data.readingState);setPreferences(data.preferences);
    setSnapshot(s=>({...s,bookmarks:data.bookmarks,readOverrides:data.readOverrides,readCursor:data.readCursor}));
    if(initial||restorePosition){
      lastPositionRef.current=null;
      const latest=Object.entries(data.readingState.positions).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
      pendingPositionRef.current=latest?{...latest[1],messageKey:latest[0]}:null;
      setHighlightedMessageKey(latest?.[0]??data.readCursor?.message_key??null);setNavigationVersion(v=>v+1);
    }
  },[]);
  const restoreGuest = useCallback(() => {
    const saved=guestBackupRef.current;guestBackupRef.current=null;
    if(saved&&saved.chatId===snapshotRef.current.manifest?.source.chat_id){
      personalRef.current=saved.readingState;setPersonal(saved.readingState);setPreferences(loadPreferences());
      setSnapshot(s=>({...s,bookmarks:saved.bookmarks,readOverrides:saved.readOverrides,readCursor:saved.readCursor}));
      const latest=Object.entries(saved.readingState.positions).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
      lastPositionRef.current=null;pendingPositionRef.current=latest?{...latest[1],messageKey:latest[0]}:null;
      setHighlightedMessageKey(latest?.[0]??saved.readCursor?.message_key??null);setNavigationVersion(v=>v+1);
    }else{initialRestoreRef.current=null;setPreferences(loadPreferences());void loadAppSnapshot().then(s=>setSnapshot(s));}
  },[]);
  const accountDocument=useMemo(()=>({...createBackup(snapshot,personal,preferences),exportedAt:"2000-01-01T00:00:00.000Z"}),[snapshot,personal,preferences]);
  const account=useReaderAccount(accountDocument,applyAccountDocument,restoreGuest,(data)=>parseBackup(data,snapshotRef.current));
  const continueAsGuest=useCallback(()=>{rememberGuestEntry();setEntered(true);setAccountOpen(false);},[]);
  useEffect(()=>{if(account.user){setEntered(true);setAccountOpen(false);}},[account.user]);
  const accountFlushRef=useRef(account.flush);accountFlushRef.current=account.flush;
  accountActiveRef.current=account.user!==null;
  const accountDialog=accountOpen?<ReaderAccount account={account} onClose={()=>setAccountOpen(false)} onGuest={!entered?continueAsGuest:undefined} initialMode={accountMode} capacity={signupCapacity.capacity} capacityError={signupCapacity.error} onRefreshCapacity={signupCapacity.refresh} onOpenAdmin={()=>{setAccountOpen(false);setAdminOpen(true);}}/>:null;
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());

  // -------- snapshot loading --------

  const refreshSnapshot = useCallback(async (message?: string): Promise<void> => {
    const next = await loadAppSnapshot();
    startTransition(() => {
      setSnapshot(current=>accountActiveRef.current?{...next,
        bookmarks:current.bookmarks.filter(b=>b.chat_id===next.manifest?.source.chat_id),
        readOverrides:current.readOverrides.filter(r=>r.message_key.startsWith(`${next.manifest?.source.chat_id}:`)),
        readCursor:current.readCursor?.chat_id===next.manifest?.source.chat_id?current.readCursor:null}:next);
      setBusyLabel(null);
      if (message) setNotice(message);
    });
  }, []);

  useEffect(() => {
    void refreshSnapshot().catch((e) => { setBusyLabel(null); setError(e instanceof Error ? e.message : "Could not load archive."); }).finally(()=>setLocalLoaded(true));
  }, [refreshSnapshot]);

  useEffect(() => {
    if(!account.config?.archiveEnabled||!localLoaded)return;
    let stopped=false;let running=false;
    const update=async()=>{
      if(running)return;running=true;setArchiveLoading(true);setArchiveError("");
      try{
        const data=await fetchSiteArchive();if(stopped)return;
        const messages=recomputeThreadLinks(data.messages);const threads=buildThreadRecords(messages);
        if(!messages.length)throw new Error("The Vidurneeti archive is being prepared. Please try again shortly.");
        if(stopped)return;
        setSnapshot(current=>({...current,manifest:data.manifest,messages,threads,directoryHandle:null,
          bookmarks:current.bookmarks.filter(b=>b.chat_id===data.manifest.source.chat_id),
          readOverrides:current.readOverrides.filter(r=>r.message_key.startsWith(`${data.manifest.source.chat_id}:`)),
          readCursor:current.readCursor?.chat_id===data.manifest.source.chat_id?current.readCursor:null}));
        setBusyLabel(null);
        // Display server posts before writing the offline cache. A storage restriction
        // must not prevent a visitor from reading the public archive.
        try{await replaceAllMessages(messages);await replaceAllThreads(threads);await saveManifest(data.manifest);await saveDirectoryHandle(null);}
        catch{if(!stopped)setNotice("Posts are available, but this browser could not cache the archive for offline use.");}
      }catch(e){if(!stopped)setArchiveError(e instanceof Error?e.message:"The archive could not be reached.");}
      finally{running=false;if(!stopped)setArchiveLoading(false);}
    };
    void update();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void update();},60000);
    return()=>{stopped=true;window.clearInterval(timer);};
  },[account.config?.archiveEnabled,localLoaded,archiveAttempt]);

  useEffect(() => {
    let cancelled = false;
    async function syncPermission(): Promise<void> {
      const status = await getDirectoryPermission(snapshot.directoryHandle);
      if (!cancelled) setDirectoryPermission(status);
    }
    void syncPermission();
    return () => {
      cancelled = true;
    };
  }, [snapshot.directoryHandle]);

  useEffect(() => () => revokeAllMediaObjectUrls(), []);

  useEffect(() => {
    const chatId = snapshot.manifest?.source.chat_id ?? null;
    if (chatId === null || initialRestoreRef.current === chatId) return;
    initialRestoreRef.current = chatId;
    // Load schedules a new navigation render; do not consume its pending position
    // in the current render and then jump to the post start in the next one.
    appliedNavigationRef.current = navigationVersion;
    if(positionTimerRef.current){window.clearTimeout(positionTimerRef.current);positionTimerRef.current=null;}
    lastPositionRef.current=null;pendingPositionRef.current=null;
    setNavStack([]);setForwardStack([]);setHighlightedMessageKey(null);setSelectedThreadKey(null);
    setSession(null);setSessionReached(false);
    try {
      const next = loadReadingState(chatId);
      personalRef.current = next; setPersonal(next);
      const saved = Object.entries(next.positions).filter(([key]) => snapshot.messages.some(m => m.message_key === key))
        .sort((a,b) => b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
      if (saved) { pendingPositionRef.current = {...saved[1],messageKey:saved[0]}; setHighlightedMessageKey(saved[0]); }
      else if (snapshot.readCursor) { setHighlightedMessageKey(snapshot.readCursor.message_key); }
      setNavigationVersion(v => v+1);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load reading state."); }
  }, [snapshot.manifest, snapshot.messages, snapshot.readCursor]);

  useEffect(() => {
    const flush = () => {
      const position = lastPositionRef.current;
      if (!position || personalRef.current.chatId === null || restoringBackupRef.current) return;
      const next = {...personalRef.current, positions: {...personalRef.current.positions,
        [position.messageKey]: savedPosition(position)}};
      try {if(!accountActiveRef.current)saveReadingState(next); personalRef.current = next;} catch { /* surfaced during normal saves */ }
      if(accountActiveRef.current)accountFlushRef.current(createBackup(snapshotRef.current,next,preferencesRef.current));
    };
    window.addEventListener("pagehide",flush);
    return () => {window.removeEventListener("pagehide",flush);flush(); if(positionTimerRef.current) window.clearTimeout(positionTimerRef.current);};
  }, []);

  // Auto-clear notices
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // ⌘K listener
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (guideOpen || !entered || accountOpen || snapshot.messages.length===0) return;
      const isModK =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isModK) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      } else if (event.key === "/" && !paletteOpen) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen, guideOpen, entered, accountOpen, snapshot.messages.length]);

  // -------- derived collections --------

  const messageBookmarkByKey = useMemo(
    () =>
      new Map(
        snapshot.bookmarks
          .filter((b) => b.target_type === "message" && b.message_key)
          .map((b) => [b.message_key!, b])
      ),
    [snapshot.bookmarks]
  );

  const threadBookmarkByKey = useMemo(
    () =>
      new Map(
        snapshot.bookmarks
          .filter((b) => b.target_type === "thread" && b.thread_key)
          .map((b) => [b.thread_key!, b])
      ),
    [snapshot.bookmarks]
  );

  const readOverrideMap = useMemo(
    () => new Map(snapshot.readOverrides.map((o) => [o.message_key, o.status])),
    [snapshot.readOverrides]
  );

  // Re-derive threads using quote-replies only. Plain `is_reply` (without
  // a quote) doesn't form a logical thread in this channel.
  const quoteThreads = useMemo(() => {
    const messageById = new Map<number, MessageRecord>();
    for (const m of snapshot.messages) messageById.set(m.message_id, m);

    // Build a parent map: child message_id -> parent message_id (only for
    // quote-replies, where the parent is the quoted target).
    const parentOf = new Map<number, number>();
    for (const m of snapshot.messages) {
      if (m.is_quote_reply && m.reply_to_msg_id != null) {
        parentOf.set(m.message_id, m.reply_to_msg_id);
      }
    }

    // Find the root of each message by walking up the parent chain.
    const rootCache = new Map<number, number>();
    function findRoot(id: number): number {
      const cached = rootCache.get(id);
      if (cached !== undefined) return cached;
      let current = id;
      const seen = new Set<number>();
      while (parentOf.has(current) && !seen.has(current)) {
        seen.add(current);
        current = parentOf.get(current)!;
      }
      rootCache.set(id, current);
      return current;
    }

    const messagesByRoot = new Map<number, MessageRecord[]>();
    for (const m of snapshot.messages) {
      const root = findRoot(m.message_id);
      const list = messagesByRoot.get(root);
      if (list) list.push(m);
      else messagesByRoot.set(root, [m]);
    }

    // Sort each thread chronologically.
    for (const list of messagesByRoot.values()) {
      list.sort((a, b) => a.message_id - b.message_id);
    }

    // Build derived ThreadRecord[] only for threads with > 1 message.
    const threads: ThreadRecord[] = [];
    const threadMap = new Map<string, MessageRecord[]>();
    for (const [rootId, msgs] of messagesByRoot) {
      if (msgs.length < 2) continue; // singletons aren't threads
      const root = messageById.get(rootId);
      if (!root) continue;
      const last = msgs[msgs.length - 1];
      const threadKey = root.thread_key; // reuse the original key for IDB consistency
      threadMap.set(threadKey, msgs);
      threads.push({
        thread_key: threadKey,
        chat_id: root.chat_id,
        root_message_id: rootId,
        root_message_key: root.message_key,
        root_missing: false,
        first_message_id: msgs[0].message_id,
        first_message_date_utc: msgs[0].date_utc,
        last_message_id: last.message_id,
        last_message_date_utc: last.date_utc,
        message_count: msgs.length,
        preview_text: root.text || root.quote_text || "(media)",
        has_media: msgs.some((m) => m.media_present),
        has_quote_replies: true,
        has_replies: true
      });
    }
    threads.sort((a, b) => a.first_message_id - b.first_message_id);

    return { threads, messagesByThreadKey: threadMap };
  }, [snapshot.messages]);

  const derivedThreads = quoteThreads.threads;

  const threadMessagesMap = useMemo(() => {
    // For messages NOT part of a quote-reply thread, return a single-message
    // map keyed by the message's original thread_key. This keeps the rail
    // logic simple downstream: threadMessagesMap.get(message.thread_key)
    // either returns the quote-thread chain or just [message].
    const map = new Map<string, MessageRecord[]>();
    for (const [key, list] of quoteThreads.messagesByThreadKey) {
      map.set(key, list);
    }
    for (const m of snapshot.messages) {
      if (!map.has(m.thread_key)) map.set(m.thread_key, [m]);
    }
    return map;
  }, [snapshot.messages, quoteThreads]);

  const threadByKey = useMemo(
    () => new Map(derivedThreads.map((t) => [t.thread_key, t])),
    [derivedThreads]
  );

  const messageByKey = useMemo(
    () => new Map(snapshot.messages.map((m) => [m.message_key, m])),
    [snapshot.messages]
  );

  const isMessageRead = useCallback(
    (message: MessageRecord): boolean => {
      const override = readOverrideMap.get(message.message_key);
      if (override === "read") return true;
      if (override === "unread") return false;
      if (!snapshot.readCursor) return false;
      return message.message_id <= snapshot.readCursor.message_id;
    },
    [readOverrideMap, snapshot.readCursor]
  );

  const filteredMessages = useMemo(() => {
    let list = snapshot.messages;
    if (session) {
      const end = list.findIndex(m => m.message_key === session.endKey);
      if (end >= 0) list = list.slice(0,end+1);
    }
    if (deferredSearch) {
      list = list.filter((m) => m.search_text.includes(deferredSearch));
    }
    return list;
  }, [snapshot.messages, deferredSearch, session]);

  const filteredThreads = useMemo(() => {
    if (!deferredSearch) return derivedThreads;
    return derivedThreads.filter((thread) => {
      if (thread.preview_text.toLowerCase().includes(deferredSearch)) return true;
      const messages = threadMessagesMap.get(thread.thread_key) ?? [];
      return messages.some((m) => m.search_text.includes(deferredSearch));
    });
  }, [derivedThreads, threadMessagesMap, deferredSearch]);

  useEffect(() => {
    if (view !== "threads") return;
    if (!filteredThreads.length) {
      setSelectedThreadKey(null);
      return;
    }
    if (!selectedThreadKey || !filteredThreads.some((t) => t.thread_key === selectedThreadKey)) {
      setSelectedThreadKey(filteredThreads[0].thread_key);
    }
  }, [filteredThreads, selectedThreadKey, view]);

  useEffect(() => {
    if (view !== "read" || appliedNavigationRef.current === navigationVersion || !timelineRef.current) return;
    const pending = pendingPositionRef.current;
    const targetKey = pending?.messageKey ?? highlightedMessageKey;
    if (!targetKey) {appliedNavigationRef.current = navigationVersion;return;}
    const index = filteredMessages.findIndex(m=>m.message_key===targetKey);
    if(index<0)return; // Deferred filters may still be clearing; wait for the target.
    if (pending) {timelineRef.current.restorePosition(pending);pendingPositionRef.current=null;}
    else timelineRef.current.scrollToIndex(index,"start");
    appliedNavigationRef.current=navigationVersion;
  }, [view, navigationVersion, filteredMessages, highlightedMessageKey, entered]);

  // Stats
  const stats = useMemo(() => {
    let read = 0;
    let longestUnread = 0;
    let currentUnread = 0;

    for (const m of snapshot.messages) {
      if (isMessageRead(m)) {
        read += 1;
        currentUnread = 0;
      } else {
        currentUnread += 1;
        if (currentUnread > longestUnread) longestUnread = currentUnread;
      }
    }

    const tagCounts = new Map<string, number>();
    for (const b of snapshot.bookmarks) {
      for (const tag of b.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const totalMessages = snapshot.messages.length;
    const unreadThreadCount = derivedThreads.filter((t) =>
      (threadMessagesMap.get(t.thread_key) ?? []).some((m) => !isMessageRead(m))
    ).length;

    return {
      totalMessages,
      totalThreads: derivedThreads.length,
      readMessages: read,
      unreadMessages: totalMessages - read,
      bookmarkedItems: snapshot.bookmarks.length,
      percentRead: totalMessages === 0 ? 0 : Math.round((read / totalMessages) * 100),
      longestUnreadStretch: longestUnread,
      unreadThreadCount,
      bookmarksByTag: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    };
  }, [snapshot.bookmarks, snapshot.messages, derivedThreads, threadMessagesMap, isMessageRead]);

  const latestMessage = snapshot.messages.at(-1) ?? null;

  const firstUnreadMessage = useMemo(() => {
    for (const m of snapshot.messages) {
      if (!isMessageRead(m)) return m;
    }
    return null;
  }, [snapshot.messages, isMessageRead]);

  const resumeNextMessage = useMemo(() => {
    if (!snapshot.readCursor) return null;
    const idx = snapshot.messages.findIndex(
      (m) => m.message_key === snapshot.readCursor?.message_key
    );
    if (idx < 0) return null;
    return snapshot.messages[idx + 1] ?? null;
  }, [snapshot.messages, snapshot.readCursor]);

  const activeAnchorMessage = useMemo(() => {
    if (highlightedMessageKey) {
      return snapshot.messages.find((m) => m.message_key === highlightedMessageKey) ?? null;
    }
    if (snapshot.readCursor) {
      return (
        snapshot.messages.find((m) => m.message_key === snapshot.readCursor?.message_key) ?? null
      );
    }
    return snapshot.messages[0] ?? null;
  }, [highlightedMessageKey, snapshot.messages, snapshot.readCursor]);

  const anchorIndex = activeAnchorMessage
    ? snapshot.messages.findIndex(
        (m) => m.message_key === activeAnchorMessage.message_key
      )
    : -1;

  const anchorPercent =
    anchorIndex >= 0 && snapshot.messages.length
      ? Math.round(((anchorIndex + 1) / snapshot.messages.length) * 100)
      : 0;

  // -------- handlers --------
  function runAction(task:Promise<unknown>):void {
    void task.catch(e=>setError(e instanceof Error?e.message:"Could not save this change."));
  }

  function updateReadOverrides(next: MessageReadOverride): void {
    setSnapshot((c) => ({
      ...c,
      readOverrides: [
        ...c.readOverrides.filter((o) => o.message_key !== next.message_key),
        next
      ]
    }));
  }

  async function handleMarkReadTillHere(message: MessageRecord): Promise<void> {
    if (!snapshot.manifest) return;
    const cursor: ReadCursor = {
      chat_id: snapshot.manifest.source.chat_id,
      message_key: message.message_key,
      message_id: message.message_id,
      date_utc: message.date_utc,
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putReadCursor(cursor);
    setSnapshot((c) => ({ ...c, readCursor: cursor }));
  }

  async function handleMarkRead(message: MessageRecord): Promise<void> {
    const next: MessageReadOverride = {
      message_key: message.message_key,
      status: "read",
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putReadOverride(next);
    updateReadOverrides(next);
  }

  async function handleMarkUnread(message: MessageRecord): Promise<void> {
    const next: MessageReadOverride = {
      message_key: message.message_key,
      status: "unread",
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putReadOverride(next);
    updateReadOverrides(next);
  }

  async function handleClearReadOverride(messageKey: string): Promise<void> {
    if (!accountActiveRef.current) await deleteReadOverride(messageKey);
    setSnapshot((c) => ({
      ...c,
      readOverrides: c.readOverrides.filter((o) => o.message_key !== messageKey)
    }));
  }

  async function handleToggleMessageBookmark(message: MessageRecord): Promise<void> {
    const existing = messageBookmarkByKey.get(message.message_key);
    if (existing) {
      if (!accountActiveRef.current) await deleteBookmark(existing.bookmark_id);
      setSnapshot((c) => ({
        ...c,
        bookmarks: c.bookmarks.filter((b) => b.bookmark_id !== existing.bookmark_id)
      }));
      return;
    }
    const bookmark: BookmarkRecord = {
      bookmark_id: bookmarkId("message", message.message_key),
      target_type: "message",
      target_key: message.message_key,
      chat_id: message.chat_id,
      message_key: message.message_key,
      thread_key: message.thread_key,
      tags: [],
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putBookmark(bookmark);
    setSnapshot((c) => ({ ...c, bookmarks: [...c.bookmarks, bookmark] }));
  }

  async function handleSaveMessageBookmarkTags(
    message: MessageRecord,
    rawTags: string[]
  ): Promise<void> {
    const existing = messageBookmarkByKey.get(message.message_key);
    const bookmark: BookmarkRecord = {
      bookmark_id: bookmarkId("message", message.message_key),
      target_type: "message",
      target_key: message.message_key,
      chat_id: message.chat_id,
      message_key: message.message_key,
      thread_key: message.thread_key,
      tags: parseTagInput(rawTags.join(",")),
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putBookmark(bookmark);
    setSnapshot((c) => ({
      ...c,
      bookmarks: [...c.bookmarks.filter((b) => b.bookmark_id !== existing?.bookmark_id), bookmark]
    }));
  }

  async function handleToggleThreadBookmark(thread: ThreadRecord): Promise<void> {
    const existing = threadBookmarkByKey.get(thread.thread_key);
    if (existing) {
      if (!accountActiveRef.current) await deleteBookmark(existing.bookmark_id);
      setSnapshot((c) => ({
        ...c,
        bookmarks: c.bookmarks.filter((b) => b.bookmark_id !== existing.bookmark_id)
      }));
      return;
    }
    const bookmark: BookmarkRecord = {
      bookmark_id: bookmarkId("thread", thread.thread_key),
      target_type: "thread",
      target_key: thread.thread_key,
      chat_id: thread.chat_id,
      message_key: null,
      thread_key: thread.thread_key,
      tags: [],
      updated_at_utc: nowIso()
    };
    if (!accountActiveRef.current) await putBookmark(bookmark);
    setSnapshot((c) => ({ ...c, bookmarks: [...c.bookmarks, bookmark] }));
  }

  // -------- focus actions --------

  function captureEntry(): NavEntry {
    const position = view === "read" ? timelineRef.current?.getPosition() ?? lastPositionRef.current : null;
    return {view,threadKey:selectedThreadKey,messageKey:position?.messageKey ?? highlightedMessageKey,
      label: position ? `post #${messageByKey.get(position.messageKey)?.message_id ?? ""}` : view,
      position};
  }
  function recordNavigation(): void {
    setNavStack(stack => [...stack.slice(-49), captureEntry()]);
    setForwardStack([]);
  }
  const focusMessage = (messageKey: string, options?: {openRail?:boolean; skipTrail?:boolean; position?:ReadingPosition}) => {
    const target = messageByKey.get(messageKey);
    if (!target) {setError(`Message ${messageKey} not in archive.`);return;}
    if (!options?.skipTrail) recordNavigation();
    setSession(null);setSessionReached(false);
    setSearchQuery(""); setView("read"); setHighlightedMessageKey(target.message_key);
    setSelectedThreadKey(target.thread_key);
    pendingPositionRef.current = options?.position ?? null;
    setNavigationVersion(v => v+1);
    if (options?.openRail && (threadMessagesMap.get(target.thread_key)?.length ?? 0)>1) setThreadRailOpen(true);
    setPaletteOpen(false);
  };
  const focusThread = (threadKey:string) => {
    if (!threadByKey.has(threadKey)) {setError("Thread not found.");return;}
    recordNavigation();setView("threads");setSelectedThreadKey(threadKey);setSearchQuery("");setPaletteOpen(false);
  };
  function setAppView(next: ViewName): void {
    if (next === view) return;
    recordNavigation();setView(next);setSearchQuery("");setPaletteOpen(false);
    if(next === "read" && lastPositionRef.current) {pendingPositionRef.current=lastPositionRef.current;setNavigationVersion(v=>v+1);}
  }

  const launchFromBeginning = useCallback(() => {
    const first = snapshot.messages[0];
    if (!first) return;
    focusMessage(first.message_key);
  }, [snapshot.messages, focusMessage]);

  const launchResume = () => {
    const saved = Object.entries(personalRef.current.positions).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
    if (saved && messageByKey.has(saved[0])) focusMessage(saved[0],{position:{...saved[1],messageKey:saved[0]}});
    else if (snapshot.readCursor) focusMessage(snapshot.readCursor.message_key);
    else launchFromBeginning();
  };

  const launchLatest = useCallback(() => {
    if (latestMessage) focusMessage(latestMessage.message_key);
  }, [latestMessage, focusMessage]);

  const launchRandom = useCallback(() => {
    if (!snapshot.messages.length) return;
    const idx = Math.floor(Math.random() * snapshot.messages.length);
    focusMessage(snapshot.messages[idx].message_key);
  }, [snapshot.messages, focusMessage]);

  const launchFirstUnread = useCallback(() => {
    if (firstUnreadMessage) focusMessage(firstUnreadMessage.message_key);
    else setNotice("Everything is marked read.");
  }, [firstUnreadMessage, focusMessage]);

  const handleJumpToMessageId = useCallback(
    (id: number) => {
      const target = snapshot.messages.find((m) => m.message_id === id);
      if (!target) {
        setError(`Message #${id} not in archive.`);
        return;
      }
      focusMessage(target.message_key, { openRail: true });
    },
    [snapshot.messages, focusMessage]
  );

  const handleOpenQuoteSource = (currentMessage: MessageRecord, replyToMsgId:number) => {
    const target = snapshot.messages.find(m=>m.message_id===replyToMsgId);
    if(!target){setError(`Quoted post #${replyToMsgId} is not in this archive.`);return;}
    setLibraryOpen(false);setReaderSearchOpen(false);setSourcePeek({message:target,origin:currentMessage});
  };
  function restoreEntry(target: NavEntry):void {
    setView(target.view);setSelectedThreadKey(target.threadKey);setHighlightedMessageKey(target.messageKey);
    setSearchQuery("");setQuoteHighlight(null);setSession(null);setSessionReached(false);
    pendingPositionRef.current=target.position;setNavigationVersion(v=>v+1);
  }
  const handleNavigateBack = () => {
    const target=navStack.at(-1);if(!target)return;
    setForwardStack(stack=>[...stack,captureEntry()]);setNavStack(stack=>stack.slice(0,-1));restoreEntry(target);
  };
  const handleNavigateForward = () => {
    const target=forwardStack.at(-1);if(!target)return;
    setNavStack(stack=>[...stack,captureEntry()]);setForwardStack(stack=>stack.slice(0,-1));restoreEntry(target);
  };

  function onPositionChange(position:ReadingPosition):void {
    if (guideActiveRef.current || restoringBackupRef.current || !snapshot.messages.some(m=>m.message_key===position.messageKey) || Number(position.messageKey.split(":")[0])!==personalRef.current.chatId) return;
    lastPositionRef.current=position;
    if(positionTimerRef.current)window.clearTimeout(positionTimerRef.current);
    positionTimerRef.current=window.setTimeout(()=>{
      if(personalRef.current.chatId===null || Number(position.messageKey.split(":")[0])!==personalRef.current.chatId)return;
      commitPersonal({...personalRef.current,positions:{...personalRef.current.positions,[position.messageKey]:savedPosition(position)}});
    },250);
  }
  function cardExtras(message:MessageRecord) {
    return {
      readingStatus:personal.statuses[message.message_key] ?? null,
      onSetReadingStatus:(m:MessageRecord,status:"in-progress"|"finished"|"revisit"|null)=>{
        const current=personalRef.current;const statuses={...current.statuses};
        if(status)statuses[m.message_key]=status;else delete statuses[m.message_key];
        commitPersonal({...current,statuses,queue:status==="finished"?current.queue.filter(k=>k!==m.message_key):current.queue});
      },
      queued:personal.queue.includes(message.message_key),
      onToggleQueue:(m:MessageRecord)=>{const c=personalRef.current;commitPersonal({...c,queue:c.queue.includes(m.message_key)?c.queue.filter(k=>k!==m.message_key):[...c.queue,m.message_key]});},
      note:personal.notes[message.message_key]??"",
      onSaveNote:(m:MessageRecord,note:string)=>{const c=personalRef.current;const notes={...c.notes};if(note.trim())notes[m.message_key]=note;else delete notes[m.message_key];commitPersonal({...c,notes});setNotice("Note saved.");},
      savedPassages:personal.passages.filter(p=>p.messageKey===message.message_key),
      onSavePassage:(m:MessageRecord,text:string)=>{const c=personalRef.current;if(c.passages.some(p=>p.messageKey===m.message_key&&p.text===text))return;commitPersonal({...c,passages:[...c.passages,{id:crypto.randomUUID(),messageKey:m.message_key,text,note:"",createdAt:nowIso()}]});setNotice("Passage saved to My work.");},
      onRemovePassage:(id:string)=>{const c=personalRef.current;commitPersonal({...c,passages:c.passages.filter(p=>p.id!==id),collections:c.collections.map(col=>({...col,items:col.items.filter(i=>i.passageId!==id)}))});},
      mediaMode:preferences.mediaMode,
      mediaPlayback:personal.media[message.message_key]??null,
      onSaveMediaPlayback:(m:MessageRecord,playback:{time:number;rate:number})=>{const c=personalRef.current;commitPersonal({...c,media:{...c.media,[m.message_key]:playback}});},
      searchHighlight:readerSearchOpen?readerSearch:"",
      onReadAround:(m:MessageRecord)=>readAround(m.message_key)
    };
  }
  function readAround(key:string):void {
    setLibraryOpen(false);focusMessage(key);
    setNotice("Showing this post in its surrounding chronological context.");
  }
  function toggleReaderSearch():void {
    if(readerSearchOpen){setReaderSearchOpen(false);if(searchReturnRef.current){restoreEntry(searchReturnRef.current);searchReturnRef.current=null;}}
    else{setLibraryOpen(false);setSourcePeek(null);searchReturnRef.current=captureEntry();setReaderSearchOpen(true);}
  }
  function startSession():void {
    const position=timelineRef.current?.getPosition()??lastPositionRef.current;
    const start=Math.max(0,snapshot.messages.findIndex(m=>m.message_key===(position?.messageKey??highlightedMessageKey)));
    let end=start;let label="";
    if(sessionMode==="date"){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(sessionValue)){setError("Choose an ending date.");return;}
      const eligible=snapshot.messages.slice(start).filter(m=>m.date_utc&&m.date_utc.slice(0,10)<=sessionValue);
      if(!eligible.length){setError("Choose a date on or after your current post.");return;}
      end=snapshot.messages.indexOf(eligible.at(-1)!);label=`Through ${sessionValue}`;
    }else{
      const count=Number(sessionValue);if(!Number.isFinite(count)||count<1||count>500){setError("Choose a target from 1 to 500.");return;}
      if(sessionMode==="posts"){end=Math.min(snapshot.messages.length-1,start+Math.floor(count)-1);label=`${end-start+1} posts`;}
      else{let minutes=0;while(end<snapshot.messages.length-1){minutes+=Math.max(.25,snapshot.messages[end].text.split(/\s+/).length/220);if(minutes>=count)break;end++;}label=`About ${count} minutes`;}
    }
    if(!snapshot.messages[end])return;
    pendingPositionRef.current=position;
    setSession({endKey:snapshot.messages[end].message_key,label});setSessionReached(false);setNavigationVersion(v=>v+1);
  }
  async function exportBackup():Promise<void>{
    try{
      const data=createBackup(snapshot,personalRef.current,preferences);
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
      const anchor=document.createElement("a");anchor.href=url;anchor.download=`vn-reader-state-${new Date().toISOString().slice(0,10)}.json`;anchor.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice("Reading-state backup exported.");
    }catch(e){setError(e instanceof Error?e.message:"Could not export backup.");}
  }
  async function importBackup(file:File):Promise<void>{
    restoringBackupRef.current=true;setBackupBusy(true);
    if(positionTimerRef.current){window.clearTimeout(positionTimerRef.current);positionTimerRef.current=null;}
    try{
      if(file.size>20_000_000)throw new Error("Backup exceeds the 20 MB limit.");
      const data=parseBackup(JSON.parse(await file.text()),snapshot);
      // Preflight browser storage before committing the IndexedDB transaction.
      const previous=personalRef.current;const previousPrefs=preferences;
      try {if(!accountActiveRef.current){saveReadingState(data.readingState);savePreferences(data.preferences);await restoreLegacyReadingState(data.bookmarks,data.readOverrides,data.readCursor);}}
      catch(e){try{if(!accountActiveRef.current){saveReadingState(previous);savePreferences(previousPrefs);}}catch{ /* preserve original error */ }throw e;}
      personalRef.current=data.readingState;setPersonal(data.readingState);changePreferences(data.preferences);
      lastPositionRef.current=null;
      if(accountActiveRef.current)setSnapshot(s=>({...s,bookmarks:data.bookmarks,readOverrides:data.readOverrides,readCursor:data.readCursor}));else await refreshSnapshot();setNotice("Reading state restored.");
      const saved=Object.entries(data.readingState.positions).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
      if(saved)focusMessage(saved[0],{position:{...saved[1],messageKey:saved[0]}});
      else if(data.readCursor)focusMessage(data.readCursor.message_key);
    }catch(e){setError(e instanceof Error?e.message:"Could not restore backup.");}
    finally{restoringBackupRef.current=false;setBackupBusy(false);}
  }
  function dismissTourInvitation(): void {
    rememberTourInvitation(); setTourInvitation(false);
  }
  function openGuide(): void {
    dismissTourInvitation();
    guideReturnRef.current = { entry: captureEntry(), library: libraryOpen, search: readerSearchOpen, query: readerSearch, streamQuery: searchQuery, toolsOpen: document.querySelector<HTMLDetailsElement>(".reader-tools-menu")?.open ?? false, windowTop: window.scrollY, settings: settingsOpen, settingsScroll: document.querySelector(".reader-settings-body")?.scrollTop ?? 0, reached: sessionReached, readingPosition: view === "read" ? timelineRef.current?.getPosition() ?? lastPositionRef.current : lastPositionRef.current, source: sourcePeek };
    guideActiveRef.current = true;
    if (positionTimerRef.current) { window.clearTimeout(positionTimerRef.current); positionTimerRef.current = null; }
    setSettingsOpen(false); setPaletteOpen(false); setSourcePeek(null);
    setGuideTopic(null); setGuideOpen(true);
  }
  function closeGuide(): void {
    setGuideOpen(false); setGuideTopic(null); setGuideStep(null);
    const tools=document.querySelector<HTMLDetailsElement>(".reader-tools-menu"); if(tools)tools.open=guideReturnRef.current?.toolsOpen??false;
    const origin = guideReturnRef.current;
    setSettingsOpen(origin?.settings ?? false);
    if (origin) {
      setSessionReached(origin.reached);
      setView(origin.entry.view); setSelectedThreadKey(origin.entry.threadKey); setHighlightedMessageKey(origin.entry.messageKey);
      setLibraryOpen(origin.library); setSourcePeek(origin.source); setReaderSearchOpen(origin.search); setReaderSearch(origin.query); setSearchQuery(origin.streamQuery);
      pendingPositionRef.current = origin.entry.position;
      lastPositionRef.current = origin.readingPosition;
      setNavigationVersion(v => v + 1);
    }
    guideReturnRef.current = null;
    // Resume saving after the virtual reader has restored the original passage.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (guideReturnRef.current) return;
      if (origin) {
        window.scrollTo({ top: origin.windowTop, behavior: "instant" });
        const settingsBody = document.querySelector(".reader-settings-body");
        if (settingsBody) settingsBody.scrollTop = origin.settingsScroll;
      }
      if (document.activeElement === document.body) document.querySelector<HTMLButtonElement>('[data-tour="help"]')?.focus();
      guideActiveRef.current = false;
    }));
  }
  const prepareTourStep = useCallback((step: TourStep | null) => {
    setGuideStep(step);
    document.documentElement.dataset.tourStep = step?.id ?? "";
    if (!step) return;
    if(step.id.startsWith("account-")||step.id==="basic-tools"||step.id==="basic-help")window.scrollTo({top:0,behavior:"instant"});
    const appearance = step.id.startsWith("appearance-");
    const search = step.id === "search-panel" || step.id === "search-context";
    setSettingsOpen(appearance); setReaderSearchOpen(search); setSourcePeek(null); setPaletteOpen(false);
    setView(step.id === "reading-timeline" ? "progress" : "read"); setSearchQuery("");
    const tools=document.querySelector<HTMLDetailsElement>(".reader-tools-menu"); if(tools) tools.open=["basic-tools","reading-resume","reading-trail","reading-session"].includes(step.id);
    if (["basic-actions", "reading-state", "reading-context", "library-save", "library-notes"].includes(step.id)) {
      const post = (step.id === "reading-context" ? snapshot.messages.find(m => m.is_quote_reply) : null)
        ?? snapshot.messages.find(m => m.text.length > 0 && m.text.length < 900) ?? snapshot.messages[0];
      if (post) {
        pendingPositionRef.current = { messageKey: post.message_key, offset: 0 };
        setHighlightedMessageKey(post.message_key); setNavigationVersion(v => v + 1);
      }
    }
  }, [snapshot.messages]);
  useEffect(() => {
    if (!guideStep) return;
    let frame = 0;
    let attempts = 0;
    const reveal = () => {
      if (guideStep.id === "library-collections" || guideStep.id === "library-work") {
        const tab = document.getElementById(guideStep.id === "library-work" ? "guide-library-tab-work" : "guide-library-tab-collections");
        if (tab?.getAttribute("aria-selected") === "false") tab.click();
      }
      const candidates = [...document.querySelectorAll<HTMLElement>(guideStep.target)];
      const target = candidates.find(el => el.getBoundingClientRect().height > 0);
      const container = target?.closest<HTMLElement>(".virtual-list-container, .reader-settings-body");
      if (target && container) {
        let rect = target.getBoundingClientRect(), bounds = container.getBoundingClientRect();
        if (container.classList.contains("virtual-list-container") && window.innerWidth < 1000 && bounds.top > 150) {
          window.scrollTo({ top: window.scrollY + bounds.top - 110, behavior: "instant" });
          rect = target.getBoundingClientRect(); bounds = container.getBoundingClientRect();
        }
        if (rect.top < bounds.top || rect.bottom > Math.min(bounds.bottom, window.innerHeight - 16)) container.scrollTop += rect.top - bounds.top - 28;
      }
      if (++attempts < 24) frame = window.requestAnimationFrame(reveal);
    };
    frame = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(frame);
  }, [guideStep]);
  const guideDialog = guideOpen ? <ReaderGuide topic={guideTopic} hasArchive={snapshot.messages.length > 0} onSelectTopic={topic => { setGuideTopic(topic); }} onClose={closeGuide} onStepChange={prepareTourStep} onLearnMore={()=>{closeGuide();setFeaturesOpen(true);}} /> : null;
  useEffect(()=>{
    if(!entered||!snapshot.messages.length||!tourInvitation||basicTourStarted.current||accountOpen)return;
    basicTourStarted.current=true;
    openGuide();setGuideTopic("basic");
  },[entered,snapshot.messages.length,tourInvitation,accountOpen]);
  const settingsDialog = settingsOpen || (guideOpen && guideReturnRef.current?.settings) ? <div hidden={guideOpen && guideTopic !== "appearance"}><ReaderSettings preferences={preferences} onChange={changePreferences} onClose={() => setSettingsOpen(false)} onOpenGuide={openGuide} tourActive={guideOpen} onExportBackup={() => void exportBackup()} onImportBackup={importBackup} backupBusy={backupBusy} /></div> : null;


  // Auto-clear the quote highlight if the user navigates away or stays a while
  useEffect(() => {
    if (!quoteHighlight) return undefined;
    const timer = window.setTimeout(() => setQuoteHighlight(null), 6000);
    return () => window.clearTimeout(timer);
  }, [quoteHighlight]);

  // After the highlight mark renders, scroll it into view within the virtualizer
  useEffect(() => {
    if (!quoteHighlight) return;
    let cancelled = false;
    const poll = (attempts: number) => {
      if (cancelled) return;
      const mark = document.querySelector(".reading-stage .tg-quote-highlight");
      if (mark) {
        const container = mark.closest(".virtual-list-container");
        if (container) {
          const cRect = container.getBoundingClientRect();
          const mRect = mark.getBoundingClientRect();
          const offset = mRect.top - cRect.top + container.scrollTop - cRect.height / 2 + mRect.height / 2;
          container.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
        } else {
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } else if (attempts < 8) {
        window.setTimeout(() => poll(attempts + 1), 150);
      }
    };
    window.setTimeout(() => poll(0), 250);
    return () => { cancelled = true; };
  }, [quoteHighlight]);

  const handleJumpToDate = useCallback(
    (yyyyMmDd: string) => {
      const target = snapshot.messages.find(
        (m) => m.date_utc && m.date_utc.slice(0, 10) >= yyyyMmDd
      );
      if (!target) {
        setError(`No message on or after ${yyyyMmDd}.`);
        return;
      }
      focusMessage(target.message_key);
    },
    [snapshot.messages, focusMessage]
  );

  const handleJumpToThreadId = useCallback(
    (id: number) => {
      const target = snapshot.threads.find((t) => t.root_message_id === id);
      if (!target) {
        setError(`Thread #${id} not found.`);
        return;
      }
      focusThread(target.thread_key);
    },
    [snapshot.threads, focusThread]
  );

  // Entry is independent of archive availability, so fetching posts never flashes
  // an import screen or opens the reader before a visitor has chosen a mode.
  if (!entered) return <><WelcomePage theme={preferences.theme} onThemeChange={theme=>changePreferences({...preferences,theme})} onGuest={continueAsGuest} onSignIn={()=>openAccount()} onSignUp={()=>openAccount("register")} capacity={signupCapacity.capacity} capacityError={signupCapacity.error} onRefreshCapacity={signupCapacity.refresh} messages={snapshot.messages} manifest={snapshot.manifest}/>{accountDialog}</>;
  if (snapshot.messages.length === 0) {
    const loading=!localLoaded||!account.configReady||archiveLoading||(account.config?.archiveEnabled&&!archiveError);
    const problem=archiveError||account.configError||"The Vidurneeti archive is not connected yet. Please try again shortly.";
    return (
      <div className="welcome-reader-loading">
        <div role={loading?"status":"alert"}>
          <h1>{loading?"Opening Vidurneeti…":"The archive couldn’t be opened."}</h1>
          <p>{loading?"Preparing the posts and your saved reading place.":problem}</p>
          {loading?<div className="welcome-loading-lines" aria-hidden="true"><span/><span/><span/></div>:<button type="button" className="btn-primary" onClick={()=>{setArchiveAttempt(v=>v+1);account.refreshConfig();}}>Try again</button>}
          <button type="button" className="btn-ghost" onClick={()=>setEntered(false)}>Back to welcome</button>
        </div>
        {accountDialog}
      </div>
    );
  }

  // -------- main shell --------

  const channelTitle = snapshot.manifest?.source.chat_title ?? "Archive";
  const channelMeta = `${stats.totalMessages.toLocaleString()} messages · ${stats.totalThreads.toLocaleString()} threads · ${stats.percentRead}% seen`;
  const anchorLabel = activeAnchorMessage
    ? `#${activeAnchorMessage.message_id} · ${anchorPercent}%`
    : "—";

  const selectedThreadMessages = selectedThreadKey
    ? threadMessagesMap.get(selectedThreadKey) ?? []
    : [];
  const selectedThread = selectedThreadKey ? threadByKey.get(selectedThreadKey) ?? null : null;

  const railThreadKey = highlightedMessageKey
    ? messageByKey.get(highlightedMessageKey)?.thread_key ?? null
    : null;
  const railMessages = railThreadKey ? threadMessagesMap.get(railThreadKey) ?? [] : [];
  const showRail = view === "read" && threadRailOpen && railMessages.length > 1;

  return (
    <div className="app-shell">
      <TopBar
        channelTitle={channelTitle}
        channelMeta={channelMeta}
        anchorLabel={anchorLabel}
        progressPercent={anchorPercent}
        view={view}
        onSetView={setAppView}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={()=>setSettingsOpen(true)}
        onOpenGuide={openGuide}
        onOpenAccount={()=>openAccount()}
        accountLabel={account.user?"Your account":"Sign in or create account"}
        paletteOpen={paletteOpen}
        settingsOpen={settingsOpen}
        guideOpen={guideOpen}
        guideMenuOpen={Boolean(guideStep && (["basic-navigation","basic-help","reading-navigation","search-threads"].includes(guideStep.id) || guideStep.id.startsWith("account-")))}
        accountOpen={accountOpen}
        focusMode={preferences.focusMode}
        onToggleFocus={()=>{if(!preferences.focusMode)setAppView("read");changePreferences({...preferences,focusMode:!preferences.focusMode});}}
      />

      {account.user && ["offline","conflict"].includes(account.status) ? <div className="account-strip" data-tour="account-status"><button onClick={()=>openAccount()}>{account.user?account.user.email:"Reading as a guest"}</button><span role="status">{account.user?({guest:"Browser only",loading:"Opening account…",saving:"Saving…",saved:"Saved across devices",offline:"Sync pending · device copy kept",conflict:"Sync needs attention"})[account.status]:"Progress saved in this browser"}</span>{account.user&&account.status==="offline"?<button onClick={()=>account.sync()}>Retry sync</button>:null}</div>:null}
      {view==="read" ? <div className="reader-toolbar">{view==="read"?<h2>{deferredSearch?`${filteredMessages.length.toLocaleString()} matches`:"Your reading"}</h2>:null}
      <details className="reader-tools-menu"><summary aria-label="Open reading tools"><MixerHorizontalIcon aria-hidden="true"/><span>Tools</span></summary><div className="reader-tools-content">
      <div className="reading-tools" data-tour="reading-tools">
        <div className="reader-trail" aria-label="Reading trail">
          <button type="button" disabled={!navStack.length} onClick={handleNavigateBack} aria-label="Previous reading location"><ArrowLeftIcon aria-hidden="true"/> Back</button>
          <button type="button" disabled={!forwardStack.length} onClick={handleNavigateForward} aria-label="Next reading location">Forward <ArrowRightIcon aria-hidden="true"/></button>
          {navStack.length ? <span>Return to {navStack.at(-1)?.label}</span>: null}
        </div>
        <div className="reader-tool-actions">
          <button type="button" onClick={launchResume}><ResetIcon aria-hidden="true"/> Resume your place</button>
          <button type="button" aria-expanded={readerSearchOpen} onClick={toggleReaderSearch}><MagnifyingGlassIcon aria-hidden="true"/> Search beside reading</button>
          <button type="button" aria-expanded={libraryOpen} onClick={()=>{setReaderSearchOpen(false);setSourcePeek(null);setLibraryOpen(o=>!o);}}><BookmarkIcon aria-hidden="true"/> My library{personal.queue.length?` · ${personal.queue.length}`:""}</button>
        </div>
      </div>
      {view==="read" ? <form className="session-controls" data-tour="session" onSubmit={e=>{e.preventDefault();startSession();}}>
        <span className="eyebrow">Session boundary</span>
        <label>Session target <select value={sessionMode} onChange={e=>{const mode=e.target.value as typeof sessionMode;setSessionMode(mode);setSessionValue(mode==="date"?(activeAnchorMessage?.date_utc?.slice(0,10)??new Date().toISOString().slice(0,10)):"5");}}><option value="posts">Posts</option><option value="minutes">Reading minutes</option><option value="date">Until date</option></select></label>
        <label className="session-value-label">{sessionMode==="date"?"End date":sessionMode==="minutes"?"Minutes":"Number of posts"}<input aria-label="Session target value" type={sessionMode==="date"?"date":"number"} min="1" max="500" value={sessionValue} onChange={e=>setSessionValue(e.target.value)}/></label>
        <button type="submit">Set boundary</button>
        {session?<><span className="session-boundary-status">{session.label} · ending at #{messageByKey.get(session.endKey)?.message_id}</span><button type="button" className="btn-ghost session-boundary-clear" onClick={()=>{const pos=timelineRef.current?.getPosition();setSession(null);setSessionReached(false);pendingPositionRef.current=pos??null;setNavigationVersion(v=>v+1);}}>Clear boundary</button></>:null}
      </form>:null}
      </div></details>
      {view==="read"?<><ReadingWidth value={preferences.readingWidth} onChange={readingWidth=>changePreferences({...preferences,readingWidth})}/><details className="stream-filter"><summary><MagnifyingGlassIcon aria-hidden="true"/><span>Filter</span></summary><div className="stream-filter-panel"><input type="search" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} aria-label="Filter reading stream" placeholder="Find words in this stream…"/></div></details></>:null}</div> : null}
      {preferences.focusMode?<button type="button" className="reader-focus-exit" onClick={()=>changePreferences({...preferences,focusMode:false})}>Exit focus</button>:null}
      {libraryOpen?<aside hidden={guideOpen && guideTopic !== null} className="reader-side-panel" data-tour="library-panel" aria-label="Personal reading library"><header><h2>Your reading library</h2><button type="button" onClick={()=>setLibraryOpen(false)} aria-label="Close library">×</button></header><ReadingLibrary state={personal} onChange={commitPersonal} messages={snapshot.messages} onOpenMessage={key=>{setLibraryOpen(false);focusMessage(key);}} onReadAround={readAround}/></aside>:null}
      {guideOpen && guideStep && ["library-queue", "library-collections", "library-work"].includes(guideStep.id) ? <aside className="reader-side-panel" data-tour="library-panel" aria-label="Library tour preview"><header><h2>Your reading library</h2><span className="eyebrow">Tour preview</span></header><ReadingLibrary idPrefix="guide-" state={personal} onChange={() => {}} messages={snapshot.messages} onOpenMessage={() => {}} onReadAround={() => {}} /></aside> : null}
      {readerSearchOpen?<aside className="reader-side-panel reader-search-panel" data-tour="search-panel" aria-label="Search beside reading"><header><h2>Find a thought</h2><button type="button" onClick={toggleReaderSearch} aria-label="Close search and return to your place">×</button></header><input autoFocus type="search" aria-label="Search archive beside reading" placeholder="Search the archive…" value={readerSearch} onChange={e=>setReaderSearch(e.target.value)}/><p>Close to return to your original passage.</p>{readerSearch.trim()?snapshot.messages.filter(m=>m.search_text.includes(readerSearch.trim().toLowerCase())).slice(0,100).map(m=><article className="library-card" key={m.message_key}><p><strong>#{m.message_id}</strong> · {trimPreview(m.text,180)}</p><div className="library-actions"><button type="button" onClick={()=>focusMessage(m.message_key)}>Read post</button><button type="button" onClick={()=>readAround(m.message_key)}>Read around this</button></div></article>):<p>Search for a phrase, topic, or source.</p>}{readerSearch.trim()&&!snapshot.messages.some(m=>m.search_text.includes(readerSearch.trim().toLowerCase()))?<p>No posts match this phrase.</p>:null}</aside>:null}
      {sourcePeek?<aside className="reader-side-panel reader-source-peek" role="dialog" aria-label="Quoted source preview"><header><div><p className="eyebrow">Quoted source</p><h2>Post #{sourcePeek.message.message_id}</h2></div><button type="button" onClick={()=>setSourcePeek(null)} aria-label="Close quoted source">×</button></header><p>Your place in post #{sourcePeek.origin.message_id} is preserved.</p><div className="reader-message-text" style={{whiteSpace:"pre-wrap"}}>{sourcePeek.message.text||"This source contains media without text."}</div><div className="library-actions"><button type="button" onClick={()=>{const peek=sourcePeek;setSourcePeek(null);focusMessage(peek.message.message_key);setQuoteHighlight({messageKey:peek.message.message_key,offset:peek.origin.quote_offset_utf16??-1,length:peek.origin.quote_text_length??0,fallbackText:peek.origin.quote_text});}}>Expand source</button><button type="button" onClick={()=>{const key=sourcePeek.message.message_key;setSourcePeek(null);readAround(key);}}>Read surrounding posts</button></div></aside>:null}
      {accountDialog}
      {settingsDialog}
      {view === "read" ? (
        <ReadingView
          messages={filteredMessages}
          cardExtras={cardExtras}
          onPositionChange={onPositionChange}
          layoutKey={JSON.stringify(preferences)}
          sessionEndKey={session?.endKey??null}
          onSessionEnd={()=>{if(!guideActiveRef.current)setSessionReached(true);}}
          sessionReached={sessionReached}
          onContinueSession={()=>{const pos=timelineRef.current?.getPosition();setSession(null);setSessionReached(false);pendingPositionRef.current=pos??null;setNavigationVersion(v=>v+1);}}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          deferredSearch={deferredSearch}
          quoteHighlight={quoteHighlight}
          hasReadCursor={Boolean(snapshot.readCursor)}
          firstUnreadMessage={firstUnreadMessage}
          resumeNextMessage={resumeNextMessage}
          latestMessage={latestMessage}
          highlightedMessageKey={highlightedMessageKey}
          messageBookmarkByKey={messageBookmarkByKey}
          readOverrideMap={readOverrideMap}
          isMessageRead={isMessageRead}
          threadMessagesMap={threadMessagesMap}
          threadByKey={threadByKey}
          directoryHandle={
            directoryPermission === "granted" || directoryPermission === "unsupported"
              ? snapshot.directoryHandle
              : null
          }
          timelineRef={timelineRef}
          onLaunchFromStart={launchFromBeginning}
          onLaunchResume={launchResume}
          onLaunchLatest={launchLatest}
          onLaunchRandom={launchRandom}
          onClearReadOverride={(key) => runAction(handleClearReadOverride(key))}
          onMarkRead={(m) => runAction(handleMarkRead(m))}
          onMarkReadTillHere={(m) => runAction(handleMarkReadTillHere(m))}
          onMarkUnread={(m) => runAction(handleMarkUnread(m))}
          onOpenMedia={(url, kind, caption) =>
            setLightboxMedia({ url, kind, caption })
          }
          onOpenQuoteSource={handleOpenQuoteSource}
          onSaveBookmarkTags={(m, t) => runAction(handleSaveMessageBookmarkTags(m, t))}
          onToggleBookmark={(m) => runAction(handleToggleMessageBookmark(m))}
          onOpenThreadRail={(key) => {
            setHighlightedMessageKey(key);
            setThreadRailOpen(true);
          }}
        />
      ) : null}

      {view === "threads" ? (
        <ThreadsView
          cardExtras={cardExtras}
          threads={filteredThreads}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedThread={selectedThread}
          selectedMessages={selectedThreadMessages}
          quoteHighlight={quoteHighlight}
          messageBookmarkByKey={messageBookmarkByKey}
          threadBookmarkByKey={threadBookmarkByKey}
          readOverrideMap={readOverrideMap}
          isMessageRead={isMessageRead}
          threadMessagesMap={threadMessagesMap}
          directoryHandle={
            directoryPermission === "granted" || directoryPermission === "unsupported"
              ? snapshot.directoryHandle
              : null
          }
          onSelect={setSelectedThreadKey}
          onToggleThreadBookmark={(t) => runAction(handleToggleThreadBookmark(t))}
          onClearReadOverride={(key) => runAction(handleClearReadOverride(key))}
          onMarkRead={(m) => runAction(handleMarkRead(m))}
          onMarkReadTillHere={(m) => runAction(handleMarkReadTillHere(m))}
          onMarkUnread={(m) => runAction(handleMarkUnread(m))}
          onOpenMedia={(url, kind, caption) =>
            setLightboxMedia({ url, kind, caption })
          }
          onOpenQuoteSource={handleOpenQuoteSource}
          onSaveBookmarkTags={(m, t) => runAction(handleSaveMessageBookmarkTags(m, t))}
          onToggleBookmark={(m) => runAction(handleToggleMessageBookmark(m))}
        />
      ) : null}

      {view === "bookmarks" ? (
        <BookmarksView
          bookmarks={snapshot.bookmarks}
          messages={snapshot.messages}
          threads={snapshot.threads}
          onOpenMessage={(key) => focusMessage(key, { openRail: true })}
          onOpenThread={focusThread}
          onReadAround={readAround}
        />
      ) : null}

      {view === "progress" ? (
        <ProgressView
          messages={snapshot.messages}
          directoryHandle={snapshot.directoryHandle}
          onOpenMessage={focusMessage}
          readingState={personal}
          stats={stats}
          firstUnread={firstUnreadMessage}
        />
      ) : null}

      <ThreadRail
        open={showRail}
        threadMessages={railMessages}
        currentMessageKey={highlightedMessageKey}
        onSelectMessage={(key) => {
          focusMessage(key);
          const target = messageByKey.get(key);
          if (!target) return;
          const child = railMessages.find(
            (m) => m.is_quote_reply && m.reply_to_msg_id === target.message_id
          );
          if (child) {
            setQuoteHighlight({
              messageKey: key,
              offset: child.quote_offset_utf16 ?? -1,
              length: child.quote_text_length ?? 0,
              fallbackText: child.quote_text
            });
          } else {
            setQuoteHighlight(null);
          }
        }}
        onClose={() => setThreadRailOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        messages={snapshot.messages}
        threads={derivedThreads}
        bookmarks={snapshot.bookmarks}
        isMessageRead={isMessageRead}
        isMessageBookmarked={(m) =>
          messageBookmarkByKey.has(m.message_key) || threadBookmarkByKey.has(m.thread_key)
        }
        isInQuoteThread={(m) => {
          const list = threadMessagesMap.get(m.thread_key);
          return Boolean(list && list.length > 1);
        }}
        onClose={() => setPaletteOpen(false)}
        onFromStart={launchFromBeginning}
        onResume={launchResume}
        onLatest={launchLatest}
        onRandom={launchRandom}
        onJumpToFirstUnread={launchFirstUnread}
        onJumpToMessage={(key) => focusMessage(key, { openRail: true })}
        onJumpToThread={focusThread}
        onJumpToMessageId={handleJumpToMessageId}
        onJumpToDate={handleJumpToDate}
        onJumpToThreadId={handleJumpToThreadId}
        onSetView={setAppView}
      />

      {guideDialog}
      {adminOpen&&account.user&&<AdminDashboard onClose={()=>setAdminOpen(false)}/>}
      {featuresOpen && <FeatureWalkthrough onClose={()=>setFeaturesOpen(false)}/>}
      <MediaLightbox media={lightboxMedia} onClose={() => setLightboxMedia(null)} />


      {busyLabel ? <div className="status-banner">{busyLabel}</div> : null}
      {notice ? <div role="status" className="status-banner status-ok">{notice}</div> : null}
      {error ? <div role="alert" className="status-banner status-error">{error}</div> : null}
    </div>
  );
}

// =================================================================
// Reading view
// =================================================================

interface QuoteHighlight {
  messageKey: string;
  offset: number;
  length: number;
  fallbackText: string | null;
}

type CardExtras = (message: MessageRecord) => Partial<React.ComponentProps<typeof MessageCard>>;
interface ReadingViewProps {
  cardExtras: CardExtras;
  onPositionChange: (position:ReadingPosition)=>void;
  layoutKey:string;
  sessionEndKey:string|null;
  onSessionEnd:()=>void;
  sessionReached:boolean;
  onContinueSession:()=>void;
  messages: MessageRecord[];
  searchQuery: string;
  onSearchChange: (next: string) => void;
  deferredSearch: string;
  quoteHighlight: QuoteHighlight | null;
  hasReadCursor: boolean;
  firstUnreadMessage: MessageRecord | null;
  resumeNextMessage: MessageRecord | null;
  latestMessage: MessageRecord | null;
  highlightedMessageKey: string | null;
  messageBookmarkByKey: Map<string, BookmarkRecord>;
  readOverrideMap: Map<string, "read" | "unread">;
  isMessageRead: (m: MessageRecord) => boolean;
  threadMessagesMap: Map<string, MessageRecord[]>;
  threadByKey: Map<string, ThreadRecord>;
  directoryHandle: FileSystemDirectoryHandle | null;
  timelineRef: React.MutableRefObject<VirtualizedMessageListHandle | null>;
  onLaunchFromStart: () => void;
  onLaunchResume: () => void;
  onLaunchLatest: () => void;
  onLaunchRandom: () => void;
  onClearReadOverride: (key: string) => void;
  onMarkRead: (m: MessageRecord) => void;
  onMarkReadTillHere: (m: MessageRecord) => void;
  onMarkUnread: (m: MessageRecord) => void;
  onOpenMedia: (url: string, kind: string | null, caption?: string) => void;
  onOpenQuoteSource: (current: MessageRecord, replyToMsgId: number) => void;
  onSaveBookmarkTags: (m: MessageRecord, tags: string[]) => void;
  onToggleBookmark: (m: MessageRecord) => void;
  onOpenThreadRail: (key: string) => void;
}

function ReadingView(props: ReadingViewProps) {
  const {
    messages,
    searchQuery,
    onSearchChange,
    deferredSearch,
    quoteHighlight,
    hasReadCursor,
    firstUnreadMessage,
    resumeNextMessage,
    latestMessage,
    highlightedMessageKey,
    messageBookmarkByKey,
    readOverrideMap,
    isMessageRead,
    threadMessagesMap,
    threadByKey,
    directoryHandle,
    timelineRef,
    onLaunchFromStart,
    onLaunchResume,
    onLaunchLatest,
    onLaunchRandom,
    onClearReadOverride,
    onMarkRead,
    onMarkReadTillHere,
    onMarkUnread,
    onOpenMedia,
    onOpenQuoteSource,
    onSaveBookmarkTags,
    onToggleBookmark,
    onOpenThreadRail
  } = props;

  const showLaunchpad =
    !hasReadCursor && !highlightedMessageKey && !deferredSearch;

  return (
    <div className="reading-stage">

      {showLaunchpad ? (
        <div className="launchpad">
          <button type="button" className="launchpad-tile full" onClick={onLaunchFromStart}>
            <span className="launchpad-tile-title">First post</span>
            <span className="launchpad-tile-detail">
              Walk through the archive front to back like a book
            </span>
          </button>
          <button type="button" className="launchpad-tile" onClick={onLaunchLatest}>
            <span className="launchpad-tile-title">Latest post</span>
            <span className="launchpad-tile-detail">Jump straight to the end of the archive</span>
          </button>
          <button type="button" className="launchpad-tile" onClick={onLaunchRandom}>
            <span className="launchpad-tile-title">Surprise me</span>
            <span className="launchpad-tile-detail">Wander into an unexpected message</span>
          </button>
        </div>
      ) : null}

      {hasReadCursor && !highlightedMessageKey && !deferredSearch ? (
        <div className="launchpad" style={{ marginBottom: "1.5rem" }}>
          <button type="button" className="launchpad-tile full" onClick={onLaunchResume}>

            <span className="launchpad-tile-title">Resume reading</span>
            <span className="launchpad-tile-detail">Picks up at your saved reading anchor</span>
          </button>
        </div>
      ) : null}

      <VirtualizedMessageList
        ref={timelineRef}
        messages={messages}
        layoutKey={props.layoutKey}
        onPositionChange={props.onPositionChange}
        emptyState={
          deferredSearch
            ? `No messages matched "${searchQuery.trim()}".`
            : "Archive is empty."
        }
        renderMessage={(message, index) => {
          const previous = messages[index - 1] ?? null;
          const showDayDivider =
            !previous ||
            previous.date_utc?.slice(0, 10) !== message.date_utc?.slice(0, 10);
          const showResume = resumeNextMessage?.message_key === message.message_key;
          const showUnread = hasReadCursor && firstUnreadMessage?.message_key === message.message_key;
          const showLatest = latestMessage?.message_key === message.message_key;

          return (
            <div className="timeline-entry">
              {showDayDivider ? (
                <div className="timeline-divider">
                  <span>{formatDayDivider(message.date_utc)}</span>
                </div>
              ) : null}
              {showResume ? (
                <div className="timeline-anchor timeline-anchor-resume">
                  You left off here
                </div>
              ) : null}
              {showUnread ? (
                <div className="timeline-anchor timeline-anchor-unread">
                  First unread
                </div>
              ) : null}
              {showLatest && messages.length > 1 ? (
                <div className="timeline-anchor timeline-anchor-latest">
                  Latest message in archive
                </div>
              ) : null}
              <MessageCard
                {...props.cardExtras(message)}
                bookmark={messageBookmarkByKey.get(message.message_key) ?? null}
                directoryHandle={directoryHandle}
                hasManualReadOverride={readOverrideMap.has(message.message_key)}
                highlighted={highlightedMessageKey === message.message_key}
                isRead={isMessageRead(message)}
                message={message}
                quoteHighlight={
                  quoteHighlight && quoteHighlight.messageKey === message.message_key
                    ? quoteHighlight
                    : null
                }
                onClearReadOverride={onClearReadOverride}
                onMarkRead={onMarkRead}
                onMarkReadTillHere={onMarkReadTillHere}
                onMarkUnread={onMarkUnread}
                onOpenMedia={onOpenMedia}
                onOpenQuoteSource={(replyTo) => onOpenQuoteSource(message, replyTo)}
                onOpenThread={() => onOpenThreadRail(message.message_key)}
                onSaveBookmarkTags={onSaveBookmarkTags}
                onToggleBookmark={onToggleBookmark}
                threadMessageCount={(threadMessagesMap.get(message.thread_key) ?? []).length}
                threadRootMissing={threadByKey.get(message.thread_key)?.root_missing ?? false}
              />
              {props.sessionEndKey===message.message_key?<SessionBoundary reached={props.sessionReached} onReached={props.onSessionEnd} onContinue={props.onContinueSession}/>:null}
            </div>
          );
        }}
      />

    </div>
  );
}

// =================================================================
// Threads view
// =================================================================

interface ThreadsViewProps {
  cardExtras: CardExtras;
  threads: ThreadRecord[];
  searchQuery: string;
  onSearchChange: (next: string) => void;
  selectedThread: ThreadRecord | null;
  selectedMessages: MessageRecord[];
  quoteHighlight: QuoteHighlight | null;
  messageBookmarkByKey: Map<string, BookmarkRecord>;
  threadBookmarkByKey: Map<string, BookmarkRecord>;
  readOverrideMap: Map<string, "read" | "unread">;
  isMessageRead: (m: MessageRecord) => boolean;
  threadMessagesMap: Map<string, MessageRecord[]>;
  directoryHandle: FileSystemDirectoryHandle | null;
  onSelect: (key: string) => void;
  onToggleThreadBookmark: (t: ThreadRecord) => void;
  onClearReadOverride: (key: string) => void;
  onMarkRead: (m: MessageRecord) => void;
  onMarkReadTillHere: (m: MessageRecord) => void;
  onMarkUnread: (m: MessageRecord) => void;
  onOpenMedia: (url: string, kind: string | null, caption?: string) => void;
  onOpenQuoteSource: (current: MessageRecord, replyToMsgId: number) => void;
  onSaveBookmarkTags: (m: MessageRecord, tags: string[]) => void;
  onToggleBookmark: (m: MessageRecord) => void;
}

function ThreadsView(props: ThreadsViewProps) {
  const {
    threads,
    searchQuery,
    onSearchChange,
    selectedThread,
    selectedMessages,
    quoteHighlight,
    messageBookmarkByKey,
    threadBookmarkByKey,
    readOverrideMap,
    isMessageRead,
    threadMessagesMap,
    directoryHandle,
    onSelect,
    onToggleThreadBookmark,
    onClearReadOverride,
    onMarkRead,
    onMarkReadTillHere,
    onMarkUnread,
    onOpenMedia,
    onOpenQuoteSource,
    onSaveBookmarkTags,
    onToggleBookmark
  } = props;

  return (
    <div className="threads-stage">
      <aside>
        <div className="reading-header" style={{ marginTop: 0 }}>
          <p className="eyebrow">Threads</p>
          <h2>{threads.length.toLocaleString()} threads</h2>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label="Filter threads"
            placeholder="Filter threads…"
          />
        </div>
        <div className="thread-list">
          {threads.map((thread) => {
            const messages = threadMessagesMap.get(thread.thread_key) ?? [];
            const unread = messages.filter((m) => !isMessageRead(m)).length;
            const bookmarked = threadBookmarkByKey.has(thread.thread_key);
            return (
              <button
                key={thread.thread_key}
                type="button"
                className={`thread-list-card ${
                  selectedThread?.thread_key === thread.thread_key ? "is-selected" : ""
                }`}
                onClick={() => onSelect(thread.thread_key)}
              >
                <span className="thread-list-card-head">
                  <span>#{thread.root_message_id}</span>
                  <span>
                    {bookmarked ? "★ " : ""}
                    {thread.message_count} msg
                  </span>
                </span>
                <span className="thread-list-card-preview">
                  {trimPreview(thread.preview_text, 110)}
                </span>
                <span className="thread-list-card-meta">
                  {unread > 0 ? `${unread} unread` : "all read"}
                </span>
              </button>
            );
          })}
          {threads.length === 0 ? (
            <div className="empty-panel">No threads match.</div>
          ) : null}
        </div>
      </aside>

      <div className="thread-detail">
        {selectedThread && selectedMessages.length ? (
          <>
            <div className="reading-header" style={{ marginTop: 0 }}>
              <p className="eyebrow">Thread #{selectedThread.root_message_id}</p>
              <h2>{trimPreview(selectedThread.preview_text, 80)}</h2>
              <p>
                {selectedThread.message_count} messages ·{" "}
                {selectedThread.root_missing ? "root missing" : "root present"}
              </p>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                <button type="button" onClick={() => onToggleThreadBookmark(selectedThread)}>
                  {threadBookmarkByKey.has(selectedThread.thread_key)
                    ? "Saved"
                    : "Bookmark thread"}
                </button>
              </div>
            </div>
            {selectedMessages.map((message) => (
              <MessageCard
                {...props.cardExtras(message)}
                key={message.message_key}
                bookmark={messageBookmarkByKey.get(message.message_key) ?? null}
                directoryHandle={directoryHandle}
                hasManualReadOverride={readOverrideMap.has(message.message_key)}
                isRead={isMessageRead(message)}
                message={message}
                quoteHighlight={
                  quoteHighlight && quoteHighlight.messageKey === message.message_key
                    ? quoteHighlight
                    : null
                }
                onClearReadOverride={onClearReadOverride}
                onMarkRead={onMarkRead}
                onMarkReadTillHere={onMarkReadTillHere}
                onMarkUnread={onMarkUnread}
                onOpenMedia={onOpenMedia}
                onOpenQuoteSource={(replyTo) => onOpenQuoteSource(message, replyTo)}
                onOpenThread={() => undefined}
                onSaveBookmarkTags={onSaveBookmarkTags}
                onToggleBookmark={onToggleBookmark}
                threadMessageCount={selectedMessages.length}
                threadRootMissing={selectedThread.root_missing}
                viewMode="thread"
              />
            ))}
          </>
        ) : (
          <div className="thread-detail-empty">Select a thread to read it.</div>
        )}
      </div>
    </div>
  );
}

// =================================================================
// Bookmarks view
// =================================================================

interface BookmarksViewProps {
  bookmarks: BookmarkRecord[];
  messages: MessageRecord[];
  threads: ThreadRecord[];
  onOpenMessage: (key: string) => void;
  onOpenThread: (key: string) => void;
  onReadAround:(key:string)=>void;
}

function BookmarksView({
  bookmarks,
  messages,
  threads,
  onOpenMessage,
  onOpenThread,
  onReadAround
}: BookmarksViewProps) {
  const messageByKey = useMemo(() => new Map(messages.map((m) => [m.message_key, m])), [messages]);
  const threadByKey = useMemo(() => new Map(threads.map((t) => [t.thread_key, t])), [threads]);

  return (
    <div className="bookmarks-stage">
      <div className="reading-header">
        <p className="eyebrow">Bookmarks</p>
        <h2>{bookmarks.length.toLocaleString()} saved items</h2>
        <p>Tag bookmarks from inside the reader to organize them here.</p>
      </div>

      {bookmarks.length === 0 ? (
        <div className="empty-panel">No bookmarks yet. Save messages or threads from the reader.</div>
      ) : (
        <div className="bookmark-grid">
          {bookmarks.map((bookmark) => {
            const message = bookmark.message_key ? messageByKey.get(bookmark.message_key) ?? null : null;
            const thread = bookmark.thread_key ? threadByKey.get(bookmark.thread_key) ?? null : null;
            return (
              <article className="bookmark-card" key={bookmark.bookmark_id}>
                <header>
                  <p className="eyebrow">
                    {bookmark.target_type === "message" ? "Message" : "Thread"}
                  </p>
                  <h3>
                    {bookmark.target_type === "message"
                      ? `#${message?.message_id ?? "?"}`
                      : `Thread #${thread?.root_message_id ?? "?"}`}
                  </h3>
                </header>
                <p>
                  {bookmark.target_type === "message"
                    ? trimPreview(message?.text ?? message?.quote_text ?? "Saved message missing.")
                    : trimPreview(thread?.preview_text ?? "Saved thread missing.")}
                </p>
                <div className="bookmark-tags">
                  {bookmark.tags.length === 0 ? (
                    <span style={{ color: "var(--text-dim)" }}>untagged</span>
                  ) : (
                    bookmark.tags.map((tag) => (
                      <span key={tag} className="bookmark-tag-chip">
                        {tag}
                      </span>
                    ))
                  )}
                </div>
                <div className="bookmark-actions">
                  {bookmark.target_type === "message" && bookmark.message_key ? (
                    <button type="button" onClick={() => onOpenMessage(bookmark.message_key!)}>
                      Open message
                    </button>
                  ) : null}
                  {bookmark.message_key?<button type="button" className="btn-ghost" onClick={()=>onReadAround(bookmark.message_key!)}>Read around this</button>:null}
                  {bookmark.thread_key ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => onOpenThread(bookmark.thread_key!)}
                    >
                      Open thread
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =================================================================
// Progress view
// =================================================================

interface ProgressViewProps {
  messages:MessageRecord[];
  directoryHandle:FileSystemDirectoryHandle|null;
  onOpenMessage:(key:string)=>void;
  readingState:ReadingState;
  stats: {
    totalMessages: number;
    totalThreads: number;
    readMessages: number;
    unreadMessages: number;
    bookmarkedItems: number;
    percentRead: number;
    longestUnreadStretch: number;
    unreadThreadCount: number;
    bookmarksByTag: Array<{ tag: string; count: number }>;
  };
  firstUnread: MessageRecord | null;
}

function ProgressView({ messages,directoryHandle,onOpenMessage,readingState, stats, firstUnread }: ProgressViewProps) {
  return (
    <div className="progress-stage">
      <div className="reading-header">
        <p className="eyebrow">Progress</p>
        <h2>
          {stats.percentRead}% of posts seen
        </h2>
        <p>
          {stats.readMessages.toLocaleString()} of {stats.totalMessages.toLocaleString()} messages
          seen · {stats.unreadMessages.toLocaleString()} unread
        </p>
      </div>

      <PostTimeline messages={messages} directoryHandle={directoryHandle} onOpenMessage={onOpenMessage}/>
      <div className="stat-grid">
        <Stat label="Seen" value={`${stats.readMessages.toLocaleString()}`} />
        <Stat label="Finished" value={String(Object.values(readingState.statuses).filter(s=>s==="finished").length)} />
        <Stat label="In progress" value={String(Object.values(readingState.statuses).filter(s=>s==="in-progress").length)} />
        <Stat label="To revisit" value={String(Object.values(readingState.statuses).filter(s=>s==="revisit").length)} />
        <Stat label="Read later" value={String(readingState.queue.length)} />
        <Stat label="Unread" value={`${stats.unreadMessages.toLocaleString()}`} />
        <Stat label="Threads" value={`${stats.totalThreads.toLocaleString()}`} />
        <Stat label="Unread threads" value={`${stats.unreadThreadCount.toLocaleString()}`} />
        <Stat label="Bookmarks" value={`${stats.bookmarkedItems.toLocaleString()}`} />
        <Stat
          label="First unread"
          value={firstUnread ? `#${firstUnread.message_id}` : "All read"}
          detail={firstUnread ? formatDate(firstUnread.date_utc) : "You're caught up."}
        />
        <Stat
          label="Longest unread streak"
          value={stats.longestUnreadStretch.toLocaleString()}
          detail="Consecutive unread messages"
        />
      </div>

      <div className="stat-secondary">
        <section className="stat-panel">
          <h3>Bookmark tags</h3>
          {stats.bookmarksByTag.length ? (
            <ul>
              {stats.bookmarksByTag.map((item) => (
                <li key={item.tag}>
                  <span>{item.tag}</span>
                  <strong>{item.count}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-panel" style={{ padding: "1rem 0" }}>
              No tags yet
            </div>
          )}
        </section>


      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
      {detail ? <span className="stat-tile-detail">{detail}</span> : null}
    </div>
  );
}

function SessionBoundary({reached,onReached,onContinue}:{reached:boolean;onReached:()=>void;onContinue:()=>void}) {
  const ref=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{const node=ref.current;if(!node)return;const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))onReached();},{threshold:.5});observer.observe(node);return()=>observer.disconnect();},[onReached]);
  return <div className="reader-session-banner" ref={ref}><p className="eyebrow">{reached?"A good place to pause":"Your session boundary"}</p><h3>Let this settle.</h3><p>You reached the last post in this session. Your place is saved.</p><button type="button" onClick={onContinue}>Keep reading</button></div>;
}

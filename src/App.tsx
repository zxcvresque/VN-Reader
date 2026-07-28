import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import AliasReview, { type AliasProposal, type AliasProposalsFile } from "./components/AliasReview";
import CommandPalette, { type ViewName } from "./components/CommandPalette";
import GraphView from "./components/GraphView";
import MediaLightbox, { type LightboxMedia } from "./components/MediaLightbox";
import MessageCard from "./components/MessageCard";
import ThreadRail from "./components/ThreadRail";
import TopBar from "./components/TopBar";
import VirtualizedMessageList, {
  type VirtualizedMessageListHandle
} from "./components/VirtualizedMessageList";
import { extractEntities } from "./lib/entities";
import {
  globalSingleAlias,
  parseEntityResolutionJson
} from "./lib/entity-resolutions";
import {
  getDirectoryPermission,
  importArchiveDirectory,
  parseTagInput,
  pickArchiveDirectory,
  reattachArchiveDirectory
} from "./lib/archive";
import {
  deleteBookmark,
  deleteReadOverride,
  deleteUserAlias,
  getEntityResolutions,
  getUserAliases,
  loadAppSnapshot,
  putBookmark,
  putReadCursor,
  putReadOverride,
  putUserAlias,
  replaceEntityResolutionsForDataset,
  resetArchiveData,
  type UserAliasRecord
} from "./lib/idb";
import { setUserAliases as setRuntimeUserAliases } from "./lib/entities";
import { revokeAllMediaObjectUrls } from "./lib/media";
import type {
  AppSnapshot,
  BookmarkRecord,
  EntityResolutionRecord,
  MessageReadOverride,
  MessageRecord,
  ReadCursor,
  ThreadRecord
} from "./types";

interface NavEntry {
  view: ViewName;
  threadKey: string | null;
  messageKey: string | null;
  entityFilter: string | null;
  label: string; // human-readable origin, e.g. "msg #4551"
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
  const [busyLabel, setBusyLabel] = useState<string | null>("Loading local archive…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ViewName>("read");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [highlightedMessageKey, setHighlightedMessageKey] = useState<string | null>(null);
  const [threadRailOpen, setThreadRailOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [entityFilter, setEntityFilter] = useState<string | null>(null);
  const [navStack, setNavStack] = useState<NavEntry[]>([]);
  const [lightboxMedia, setLightboxMedia] = useState<LightboxMedia | null>(null);
  const [userAliases, setUserAliasesState] = useState<UserAliasRecord[]>([]);
  const [entityResolutions, setEntityResolutions] = useState<EntityResolutionRecord[]>([]);
  const [aliasProposals, setAliasProposals] = useState<AliasProposal[] | null>(null);
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
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());

  // -------- snapshot loading --------

  const refreshSnapshot = useCallback(async (message?: string): Promise<void> => {
    const next = await loadAppSnapshot();
    startTransition(() => {
      setSnapshot(next);
      setBusyLabel(null);
      if (message) setNotice(message);
    });
  }, []);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    void (async () => {
      const [aliases, resolutions] = await Promise.all([
        getUserAliases(),
        getEntityResolutions()
      ]);
      setUserAliasesState(aliases);
      setEntityResolutions(resolutions);
      setRuntimeUserAliases(aliases.map((a) => ({ match: a.match, canonical: a.canonical })));
    })();
  }, []);

  const handleMergeEntities = useCallback(
    async (fromMatch: string, toCanonical: string) => {
      if (fromMatch === toCanonical) return;
      const next: UserAliasRecord = {
        match: fromMatch,
        canonical: toCanonical,
        created_at_utc: nowIso()
      };
      await putUserAlias(next);
      setUserAliasesState((current) => {
        const filtered = current.filter((a) => a.match !== fromMatch);
        const updated = [...filtered, next];
        setRuntimeUserAliases(
          updated.map((a) => ({ match: a.match, canonical: a.canonical }))
        );
        return updated;
      });
      setNotice(`Merged "${fromMatch}" into "${toCanonical}". Graph rebuilding…`);
    },
    []
  );

  const handleLoadAliasProposals = useCallback(async () => {
    try {
      const win = window as unknown as {
        showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
      };
      let text: string;
      if (win.showOpenFilePicker) {
        const [handle] = await win.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: "VN Reader alias proposals",
              accept: { "application/json": [".json"] }
            }
          ]
        });
        const file = await handle.getFile();
        text = await file.text();
      } else {
        // Fallback: legacy <input type=file>
        text = await new Promise<string>((resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "application/json,.json";
          input.onchange = async () => {
            const f = input.files?.[0];
            if (!f) return reject(new Error("No file chosen"));
            resolve(await f.text());
          };
          input.click();
        });
      }
      const parsed = JSON.parse(text) as AliasProposalsFile;
      if (parsed.schema !== "vn-reader-aliases" || !Array.isArray(parsed.proposals)) {
        throw new Error("Not a vn-reader-aliases file");
      }
      setAliasProposals(parsed.proposals);
      setView("aliases");
      setNotice(`Loaded ${parsed.proposals.length} alias proposals.`);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Could not load proposals.");
    }
  }, []);

  const handleLoadEntityResolutions = useCallback(async () => {
    try {
      const win = window as unknown as {
        showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
      };
      let text: string;
      if (win.showOpenFilePicker) {
        const [handle] = await win.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: "VN Reader entity resolutions",
              accept: { "application/json": [".json"] }
            }
          ]
        });
        text = await (await handle.getFile()).text();
      } else {
        text = await new Promise<string>((resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "application/json,.json";
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return reject(new Error("No file chosen"));
            resolve(await file.text());
          };
          input.click();
        });
      }

      const parsed = parseEntityResolutionJson(text);
      await replaceEntityResolutionsForDataset(
        parsed.dataset.dataset_id,
        parsed.resolutions
      );

      const aliasesToApply = parsed.resolutions
        .map(globalSingleAlias)
        .filter((value): value is { match: string; canonical: string } => Boolean(value));
      const appliedAt = nowIso();
      for (const alias of aliasesToApply) {
        await putUserAlias({
          match: alias.match,
          canonical: alias.canonical,
          created_at_utc: appliedAt
        });
      }

      const [nextAliases, nextResolutions] = await Promise.all([
        getUserAliases(),
        getEntityResolutions()
      ]);
      setUserAliasesState(nextAliases);
      setEntityResolutions(nextResolutions);
      setRuntimeUserAliases(
        nextAliases.map((alias) => ({
          match: alias.match,
          canonical: alias.canonical
        }))
      );
      setPaletteOpen(false);
      setNotice(
        `Imported ${parsed.resolutions.length.toLocaleString()} entity resolutions`
        + ` · ${aliasesToApply.length.toLocaleString()} reusable aliases`
        + " · contextual references will appear in the graph."
      );
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Could not load entity resolutions.");
    }
  }, []);

  const handleApplyAliases = useCallback(
    async (accepted: Array<{ match: string; canonical: string }>) => {
      if (accepted.length === 0) return;
      const now = nowIso();
      const records: UserAliasRecord[] = accepted.map((a) => ({
        match: a.match,
        canonical: a.canonical,
        created_at_utc: now
      }));
      for (const rec of records) {
        await putUserAlias(rec);
      }
      setUserAliasesState((current) => {
        const map = new Map(current.map((a) => [a.match, a]));
        for (const r of records) map.set(r.match, r);
        const updated = Array.from(map.values());
        setRuntimeUserAliases(
          updated.map((a) => ({ match: a.match, canonical: a.canonical }))
        );
        return updated;
      });
      setAliasProposals(null);
      setNotice(`Applied ${records.length} alias${records.length === 1 ? "" : "es"}. Graph rebuilds on next visit.`);
    },
    []
  );

  const handleDeleteUserAlias = useCallback(async (match: string) => {
    await deleteUserAlias(match);
    setUserAliasesState((current) => {
      const updated = current.filter((a) => a.match !== match);
      setRuntimeUserAliases(
        updated.map((a) => ({ match: a.match, canonical: a.canonical }))
      );
      return updated;
    });
    setNotice(`Removed alias "${match}".`);
  }, []);

  const handleUpdateUserAlias = useCallback(
    async (match: string, canonical: string) => {
      const next: UserAliasRecord = {
        match,
        canonical,
        created_at_utc: nowIso()
      };
      await putUserAlias(next);
      setUserAliasesState((current) => {
        const updated = current.map((a) => (a.match === match ? next : a));
        setRuntimeUserAliases(
          updated.map((a) => ({ match: a.match, canonical: a.canonical }))
        );
        return updated;
      });
      setNotice(`Updated "${match}" → "${canonical}".`);
    },
    []
  );

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
    if (!highlightedMessageKey && snapshot.readCursor?.message_key) {
      setHighlightedMessageKey(snapshot.readCursor.message_key);
    }
  }, [highlightedMessageKey, snapshot.readCursor]);

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
      const isModK =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isModK) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      } else if (event.key === "/" && !paletteOpen) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen]);

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

  const contextualEntitiesByMessage = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const resolution of entityResolutions) {
      if (
        (resolution.status !== "resolved" && resolution.status !== "same_as_written")
        || resolution.resolution_scope === "global_alias"
      ) {
        continue;
      }
      for (const evidence of resolution.evidence) {
        if (!evidence.message_key) continue;
        const entities = map.get(evidence.message_key) ?? new Set<string>();
        resolution.canonical_names.forEach((name) => entities.add(name));
        map.set(evidence.message_key, entities);
      }
    }
    return map;
  }, [entityResolutions]);

  // Entity filter set: which message_keys mention the active entity. Built
  // lazily so the cost is paid only when a filter is active.
  const entityMatchKeys = useMemo(() => {
    if (!entityFilter) return null;
    const set = new Set<string>();
    const globalSurfaces = entityResolutions
      .filter(
        (resolution) =>
          (resolution.status === "resolved" || resolution.status === "same_as_written")
          && resolution.resolution_scope === "global_alias"
          && resolution.canonical_names.includes(entityFilter)
      )
      .map((resolution) => resolution.surface_form.toLocaleLowerCase())
      .filter(Boolean);
    for (const m of snapshot.messages) {
      const combined = `${m.text ?? ""} ${m.quote_text ?? ""}`;
      const ents = extractEntities(combined);
      contextualEntitiesByMessage
        .get(m.message_key)
        ?.forEach((name) => ents.add(name));
      const lower = combined.toLocaleLowerCase();
      if (globalSurfaces.some((surface) => lower.includes(surface))) {
        ents.add(entityFilter);
      }
      if (ents.has(entityFilter)) set.add(m.message_key);
    }
    return set;
  }, [
    snapshot.messages,
    entityFilter,
    entityResolutions,
    contextualEntitiesByMessage
  ]);

  const filteredMessages = useMemo(() => {
    let list = snapshot.messages;
    if (entityMatchKeys) {
      list = list.filter((m) => entityMatchKeys.has(m.message_key));
    }
    if (deferredSearch) {
      list = list.filter((m) => m.search_text.includes(deferredSearch));
    }
    return list;
  }, [snapshot.messages, deferredSearch, entityMatchKeys]);

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
    if (view !== "read" || !highlightedMessageKey) return;
    const index = filteredMessages.findIndex(
      (m) => m.message_key === highlightedMessageKey
    );
    if (index >= 0) timelineRef.current?.scrollToIndex(index, "center");
  }, [filteredMessages, highlightedMessageKey, view]);

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

  async function handleImportArchive(): Promise<void> {
    setBusyLabel("Importing archive folder...");
    setError(null);
    setNotice(null);
    try {
      const handle = await pickArchiveDirectory();
      const result = await importArchiveDirectory(handle);
      await refreshSnapshot(
        `Imported ${result.importedMessageCount} messages — total ${result.totalMessageCount} across ${result.totalThreadCount} threads.`
      );
      setView("read");
      setSearchQuery("");
    } catch (e) {
      setBusyLabel(null);
      setError(e instanceof Error ? e.message : "Import failed.");
    }
  }

  async function handleReattachFolder(): Promise<void> {
    setBusyLabel("Reattaching archive folder…");
    setError(null);
    setNotice(null);
    try {
      const handle = await pickArchiveDirectory();
      await reattachArchiveDirectory(handle);
      await refreshSnapshot("Archive folder reattached.");
    } catch (e) {
      setBusyLabel(null);
      setError(e instanceof Error ? e.message : "Could not reattach folder.");
    }
  }

  async function handleResetArchive(): Promise<void> {
    if (!window.confirm("Clear the imported archive, bookmarks, and read state from this browser?")) {
      return;
    }
    setBusyLabel("Clearing local archive…");
    setError(null);
    setNotice(null);
    try {
      revokeAllMediaObjectUrls();
      await resetArchiveData();
      await refreshSnapshot("Local archive cleared.");
      setSelectedThreadKey(null);
      setHighlightedMessageKey(null);
    } catch (e) {
      setBusyLabel(null);
      setError(e instanceof Error ? e.message : "Could not reset.");
    }
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
    await putReadCursor(cursor);
    setSnapshot((c) => ({ ...c, readCursor: cursor }));
  }

  async function handleMarkRead(message: MessageRecord): Promise<void> {
    const next: MessageReadOverride = {
      message_key: message.message_key,
      status: "read",
      updated_at_utc: nowIso()
    };
    await putReadOverride(next);
    updateReadOverrides(next);
  }

  async function handleMarkUnread(message: MessageRecord): Promise<void> {
    const next: MessageReadOverride = {
      message_key: message.message_key,
      status: "unread",
      updated_at_utc: nowIso()
    };
    await putReadOverride(next);
    updateReadOverrides(next);
  }

  async function handleClearReadOverride(messageKey: string): Promise<void> {
    await deleteReadOverride(messageKey);
    setSnapshot((c) => ({
      ...c,
      readOverrides: c.readOverrides.filter((o) => o.message_key !== messageKey)
    }));
  }

  async function handleToggleMessageBookmark(message: MessageRecord): Promise<void> {
    const existing = messageBookmarkByKey.get(message.message_key);
    if (existing) {
      await deleteBookmark(existing.bookmark_id);
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
    await putBookmark(bookmark);
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
    await putBookmark(bookmark);
    setSnapshot((c) => ({
      ...c,
      bookmarks: [...c.bookmarks.filter((b) => b.bookmark_id !== existing?.bookmark_id), bookmark]
    }));
  }

  async function handleToggleThreadBookmark(thread: ThreadRecord): Promise<void> {
    const existing = threadBookmarkByKey.get(thread.thread_key);
    if (existing) {
      await deleteBookmark(existing.bookmark_id);
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
    await putBookmark(bookmark);
    setSnapshot((c) => ({ ...c, bookmarks: [...c.bookmarks, bookmark] }));
  }

  // -------- focus actions --------

  const focusMessage = useCallback(
    (messageKey: string, options?: { openRail?: boolean }) => {
      const target = messageByKey.get(messageKey);
      if (!target) {
        setError(`Message ${messageKey} not in archive.`);
        return;
      }
      setView("read");
      setHighlightedMessageKey(target.message_key);
      setSelectedThreadKey(target.thread_key);
      if (options?.openRail) {
        const threadSize = (threadMessagesMap.get(target.thread_key) ?? []).length;
        if (threadSize > 1) setThreadRailOpen(true);
      }
      setPaletteOpen(false);
    },
    [messageByKey, threadMessagesMap]
  );

  const focusThread = useCallback(
    (threadKey: string) => {
      const thread = threadByKey.get(threadKey);
      if (!thread) {
        setError("Thread not found.");
        return;
      }
      setView("threads");
      setSelectedThreadKey(threadKey);
      setPaletteOpen(false);
    },
    [threadByKey]
  );

  const launchFromBeginning = useCallback(() => {
    const first = snapshot.messages[0];
    if (!first) return;
    focusMessage(first.message_key);
  }, [snapshot.messages, focusMessage]);

  const launchResume = useCallback(() => {
    if (snapshot.readCursor?.message_key) {
      focusMessage(snapshot.readCursor.message_key);
    } else {
      launchFromBeginning();
    }
  }, [snapshot.readCursor, focusMessage, launchFromBeginning]);

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

  const handleOpenQuoteSource = useCallback(
    (currentMessage: MessageRecord, replyToMsgId: number) => {
      const target = snapshot.messages.find((m) => m.message_id === replyToMsgId);
      if (!target) {
        setError(`Quoted message #${replyToMsgId} not in archive.`);
        return;
      }
      // Push current view+selection so the user can navigate back
      setNavStack((stack) => [
        ...stack,
        {
          view,
          threadKey: selectedThreadKey,
          messageKey: currentMessage.message_key,
          entityFilter,
          label: `msg #${currentMessage.message_id}`
        }
      ]);
      // Pass the quoted span info so the source message can highlight it.
      // offset comes from raw entities; if missing we fall back to substring
      // search inside MessageCard.
      setQuoteHighlight({
        messageKey: target.message_key,
        offset: currentMessage.quote_offset_utf16 ?? -1,
        length: currentMessage.quote_text_length ?? 0,
        fallbackText: currentMessage.quote_text
      });
      focusMessage(target.message_key, { openRail: true });
    },
    [snapshot.messages, view, selectedThreadKey, entityFilter, focusMessage]
  );

  const handleNavigateBack = useCallback(() => {
    setNavStack((stack) => {
      if (!stack.length) return stack;
      const next = stack.slice(0, -1);
      const target = stack[stack.length - 1];
      setView(target.view);
      setSelectedThreadKey(target.threadKey);
      setHighlightedMessageKey(target.messageKey);
      setEntityFilter(target.entityFilter);
      setQuoteHighlight(null);
      return next;
    });
  }, []);

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
      const mark = document.querySelector(".tg-quote-highlight");
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

  // -------- landing (no archive) --------

  if (snapshot.messages.length === 0 && !busyLabel) {
    return (
      <div className="landing-shell">
        <div className="landing-card">
          <p className="eyebrow">VN Reader</p>
          <h1>Read your channel archive like a long-form book.</h1>
          <p className="landing-summary">
            Import your exported Telegram archive folder. Everything stays local. Use ⌘K
            to navigate.
          </p>
          <div className="landing-actions">
            <button type="button" onClick={() => void handleImportArchive()}>
              Import archive folder
            </button>
          </div>
          <div className="landing-notes">
            <p>Drop an archive folder produced by the exporter</p>
            <p>Bookmarks, read state, and graph clusters live in this browser only</p>
          </div>
        </div>
        {error ? <div className="status-banner status-error">{error}</div> : null}
      </div>
    );
  }

  if (snapshot.messages.length === 0) {
    return (
      <div className="landing-shell">
        <div className="landing-card">
          <p className="eyebrow">VN Reader</p>
          <h1>Loading local archive…</h1>
        </div>
      </div>
    );
  }

  // -------- main shell --------

  const channelTitle = snapshot.manifest?.source.chat_title ?? "Archive";
  const channelMeta = `${stats.totalMessages.toLocaleString()} messages · ${stats.totalThreads.toLocaleString()} threads · ${stats.percentRead}% read`;
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
        onSetView={setView}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {view === "read" ? (
        <ReadingView
          messages={filteredMessages}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          deferredSearch={deferredSearch}
          entityFilter={entityFilter}
          onClearEntityFilter={() => setEntityFilter(null)}
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
          onClearReadOverride={(key) => void handleClearReadOverride(key)}
          onMarkRead={(m) => void handleMarkRead(m)}
          onMarkReadTillHere={(m) => void handleMarkReadTillHere(m)}
          onMarkUnread={(m) => void handleMarkUnread(m)}
          onOpenMedia={(url, kind, caption) =>
            setLightboxMedia({ url, kind, caption })
          }
          onOpenQuoteSource={handleOpenQuoteSource}
          onReattachMedia={() => void handleReattachFolder()}
          onSaveBookmarkTags={(m, t) => void handleSaveMessageBookmarkTags(m, t)}
          onToggleBookmark={(m) => void handleToggleMessageBookmark(m)}
          onOpenThreadRail={(key) => {
            setHighlightedMessageKey(key);
            setThreadRailOpen(true);
          }}
        />
      ) : null}

      {view === "threads" ? (
        <ThreadsView
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
          onToggleThreadBookmark={(t) => void handleToggleThreadBookmark(t)}
          onClearReadOverride={(key) => void handleClearReadOverride(key)}
          onMarkRead={(m) => void handleMarkRead(m)}
          onMarkReadTillHere={(m) => void handleMarkReadTillHere(m)}
          onMarkUnread={(m) => void handleMarkUnread(m)}
          onOpenMedia={(url, kind, caption) =>
            setLightboxMedia({ url, kind, caption })
          }
          onOpenQuoteSource={handleOpenQuoteSource}
          onSaveBookmarkTags={(m, t) => void handleSaveMessageBookmarkTags(m, t)}
          onToggleBookmark={(m) => void handleToggleMessageBookmark(m)}
        />
      ) : null}

      {view === "graph" ? (
        <GraphView
          messages={snapshot.messages}
          userAliases={userAliases.map((a) => ({ match: a.match, canonical: a.canonical }))}
          entityResolutions={entityResolutions}
          onFilterByEntity={(entity) => {
            setEntityFilter(entity);
            setView("read");
            setHighlightedMessageKey(null);
          }}
          onJumpToThread={handleJumpToThreadId}
          onMergeEntities={handleMergeEntities}
        />
      ) : null}

      {view === "bookmarks" ? (
        <BookmarksView
          bookmarks={snapshot.bookmarks}
          messages={snapshot.messages}
          threads={snapshot.threads}
          onOpenMessage={(key) => focusMessage(key, { openRail: true })}
          onOpenThread={focusThread}
        />
      ) : null}

      {view === "progress" ? (
        <ProgressView
          stats={stats}
          firstUnread={firstUnreadMessage}
          importSessions={snapshot.importSessions}
        />
      ) : null}

      {view === "aliases" ? (
        <AliasReview
          proposals={aliasProposals}
          existingAliases={userAliases}
          onLoadFile={() => void handleLoadAliasProposals()}
          onApply={(accepted) => void handleApplyAliases(accepted)}
          onClear={() => setAliasProposals(null)}
          onDeleteExisting={(match) => void handleDeleteUserAlias(match)}
          onUpdateExisting={(match, canonical) => void handleUpdateUserAlias(match, canonical)}
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
        onSetView={setView}
        onImport={() => void handleImportArchive()}
        onReattachMedia={() => void handleReattachFolder()}
        onResetArchive={() => void handleResetArchive()}
        onImportAliasProposals={() => void handleLoadAliasProposals()}
        onImportEntityResolutions={() => void handleLoadEntityResolutions()}
      />

      <MediaLightbox media={lightboxMedia} onClose={() => setLightboxMedia(null)} />

      {navStack.length ? (
        <button
          type="button"
          className="nav-back-button"
          onClick={handleNavigateBack}
          aria-label="Go back"
        >
          <span className="nav-back-arrow">←</span>
          <span className="nav-back-label">
            Back to {navStack[navStack.length - 1].label}
          </span>
          {navStack.length > 1 ? (
            <span className="nav-back-depth">{navStack.length}</span>
          ) : null}
        </button>
      ) : null}

      {busyLabel ? <div className="status-banner">{busyLabel}</div> : null}
      {notice ? <div className="status-banner status-ok">{notice}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}
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

interface ReadingViewProps {
  messages: MessageRecord[];
  searchQuery: string;
  onSearchChange: (next: string) => void;
  deferredSearch: string;
  entityFilter: string | null;
  onClearEntityFilter: () => void;
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
  onReattachMedia: () => void;
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
    entityFilter,
    onClearEntityFilter,
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
    onReattachMedia,
    onSaveBookmarkTags,
    onToggleBookmark,
    onOpenThreadRail
  } = props;

  const showLaunchpad =
    !hasReadCursor && !highlightedMessageKey && !deferredSearch && !entityFilter;

  return (
    <div className="reading-stage">
      <div className="reading-header">
        <p className="eyebrow">
          {entityFilter
            ? "Topic"
            : showLaunchpad
              ? "Begin"
              : deferredSearch
                ? "Search"
                : "Reading stream"}
        </p>
        <h2>
          {entityFilter
            ? `${messages.length.toLocaleString()} messages mention ${entityFilter}`
            : deferredSearch
              ? `${messages.length.toLocaleString()} matches for "${searchQuery.trim()}"`
              : showLaunchpad
                ? "Pick a way to start"
                : `${messages.length.toLocaleString()} messages in stream`}
        </h2>
        {entityFilter ? (
          <div className="filter-chip">
            <span>Filtered by</span>
            <strong>{entityFilter}</strong>
            <button
              type="button"
              className="filter-chip-clear"
              onClick={onClearEntityFilter}
              aria-label="Clear topic filter"
            >
              ×
            </button>
          </div>
        ) : (
          <p>
            Press <span className="kbd">⌘</span><span className="kbd">K</span> or{" "}
            <span className="kbd">/</span> to jump, search, or switch views.
          </p>
        )}
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Or filter the stream right here by text…"
          style={{ marginTop: "0.5rem" }}
        />
      </div>

      {showLaunchpad ? (
        <div className="launchpad">
          <button type="button" className="launchpad-tile full" onClick={onLaunchFromStart}>
            <span className="launchpad-tile-label">From zero</span>
            <span className="launchpad-tile-title">Read from the very first message</span>
            <span className="launchpad-tile-detail">
              Walk through the archive front to back like a book
            </span>
          </button>
          <button type="button" className="launchpad-tile" onClick={onLaunchLatest}>
            <span className="launchpad-tile-label">Latest</span>
            <span className="launchpad-tile-title">Catch the newest post</span>
            <span className="launchpad-tile-detail">Jump straight to the end of the archive</span>
          </button>
          <button type="button" className="launchpad-tile" onClick={onLaunchRandom}>
            <span className="launchpad-tile-label">Shuffle</span>
            <span className="launchpad-tile-title">Open something random</span>
            <span className="launchpad-tile-detail">Wander into an unexpected message</span>
          </button>
        </div>
      ) : null}

      {hasReadCursor && !highlightedMessageKey && !deferredSearch ? (
        <div className="launchpad" style={{ marginBottom: "1.5rem" }}>
          <button type="button" className="launchpad-tile full" onClick={onLaunchResume}>
            <span className="launchpad-tile-label">Resume</span>
            <span className="launchpad-tile-title">Continue where you left off</span>
            <span className="launchpad-tile-detail">Picks up at your saved reading anchor</span>
          </button>
        </div>
      ) : null}

      <VirtualizedMessageList
        ref={timelineRef}
        messages={messages}
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
          const showUnread = firstUnreadMessage?.message_key === message.message_key;
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
                onReattachMedia={onReattachMedia}
                onSaveBookmarkTags={onSaveBookmarkTags}
                onToggleBookmark={onToggleBookmark}
                threadMessageCount={(threadMessagesMap.get(message.thread_key) ?? []).length}
                threadRootMissing={threadByKey.get(message.thread_key)?.root_missing ?? false}
              />
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
}

function BookmarksView({
  bookmarks,
  messages,
  threads,
  onOpenMessage,
  onOpenThread
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
  importSessions: AppSnapshot["importSessions"];
}

function ProgressView({ stats, firstUnread, importSessions }: ProgressViewProps) {
  return (
    <div className="progress-stage">
      <div className="reading-header">
        <p className="eyebrow">Progress</p>
        <h2>
          {stats.percentRead}% through the archive
        </h2>
        <p>
          {stats.readMessages.toLocaleString()} of {stats.totalMessages.toLocaleString()} messages
          read · {stats.unreadMessages.toLocaleString()} unread
        </p>
      </div>

      <div className="stat-grid">
        <Stat label="Read" value={`${stats.readMessages.toLocaleString()}`} />
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

        <section className="stat-panel">
          <h3>Recent imports</h3>
          {importSessions.length ? (
            <ul>
              {importSessions.slice(0, 8).map((session) => (
                <li key={session.import_id}>
                  <span>{formatDate(session.imported_at_utc)}</span>
                  <strong>{session.imported_message_count.toLocaleString()}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-panel" style={{ padding: "1rem 0" }}>
              No imports recorded
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

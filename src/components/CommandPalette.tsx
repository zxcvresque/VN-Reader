import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookmarkRecord, MessageRecord, ThreadRecord } from "../types";

interface ParsedQuery {
  text: string;                     // remaining free-text after extracting filters
  mediaKind: string | null;         // "photo" | "video" | "audio" | "sticker" | "any"
  mediaAny: boolean;                // media:any → any media
  fromDate: string | null;          // YYYY-MM-DD
  toDate: string | null;            // YYYY-MM-DD
  readState: "read" | "unread" | null;
  bookmarkedOnly: boolean;
  threadOnly: boolean;              // only quote-thread messages (is_quote_reply or part of a quote chain)
  hasFilters: boolean;
}

const FILTER_RE = /\b(media|from|to|unread|read|bookmarked|thread):(\S+)?/gi;

function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = {
    text: "",
    mediaKind: null,
    mediaAny: false,
    fromDate: null,
    toDate: null,
    readState: null,
    bookmarkedOnly: false,
    threadOnly: false,
    hasFilters: false
  };

  let cleaned = input;
  cleaned = cleaned.replace(FILTER_RE, (_match, key: string, value: string | undefined) => {
    out.hasFilters = true;
    const k = key.toLowerCase();
    const v = (value ?? "").trim();
    switch (k) {
      case "media":
        if (v === "any" || v === "" || v === "true") out.mediaAny = true;
        else out.mediaKind = v.toLowerCase();
        break;
      case "from":
        if (v) out.fromDate = v;
        break;
      case "to":
        if (v) out.toDate = v;
        break;
      case "unread":
        out.readState = "unread";
        break;
      case "read":
        out.readState = "read";
        break;
      case "bookmarked":
        out.bookmarkedOnly = true;
        break;
      case "thread":
        out.threadOnly = true;
        break;
    }
    return "";
  });
  out.text = cleaned.replace(/\s+/g, " ").trim();
  return out;
}

export type ViewName = "bookmarks" | "progress" | "read" | "threads";

export interface CommandPaletteHandlers {
  onClose: () => void;
  onFromStart: () => void;
  onResume: () => void;
  onLatest: () => void;
  onRandom: () => void;
  onJumpToFirstUnread: () => void;
  onJumpToMessage: (messageKey: string) => void;
  onJumpToThread: (threadKey: string) => void;
  onJumpToMessageId: (id: number) => void;
  onJumpToDate: (yyyyMmDd: string) => void;
  onJumpToThreadId: (id: number) => void;
  onSetView: (view: ViewName) => void;
  onImport: () => void;
  onReattachMedia: () => void;
  onResetArchive: () => void;
}

interface CommandPaletteProps extends CommandPaletteHandlers {
  open: boolean;
  messages: MessageRecord[];
  threads: ThreadRecord[];
  bookmarks: BookmarkRecord[];
  isMessageRead: (m: MessageRecord) => boolean;
  isMessageBookmarked: (m: MessageRecord) => boolean;
  isInQuoteThread: (m: MessageRecord) => boolean;
}

type InlineMode = "messageId" | "date" | "threadId" | null;

function trim(value: string, limit = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "(no text)";
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const safe = escapeRegex(query.trim());
  const parts = text.split(new RegExp(`(${safe})`, "ig"));
  return parts.map((part, idx) =>
    part.toLowerCase() === query.trim().toLowerCase() ? (
      <mark key={idx}>{part}</mark>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}

export default function CommandPalette({
  open,
  messages,
  threads,
  bookmarks,
  isMessageRead,
  isMessageBookmarked,
  isInQuoteThread,
  onClose,
  onFromStart,
  onResume,
  onLatest,
  onRandom,
  onJumpToFirstUnread,
  onJumpToMessage,
  onJumpToThread,
  onJumpToMessageId,
  onJumpToDate,
  onJumpToThreadId,
  onSetView,
  onImport,
  onReattachMedia,
  onResetArchive,
}: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [inlineMode, setInlineMode] = useState<InlineMode>(null);
  const [inlineValue, setInlineValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setInlineMode(null);
      setInlineValue("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (inlineMode) {
          setInlineMode(null);
          setInlineValue("");
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, inlineMode, onClose]);

  const parsed = useMemo(() => parseQuery(search), [search]);
  const lowerSearch = parsed.text.toLowerCase();

  const messageHits = useMemo(() => {
    // Show hits when there's any free text (>=2 chars) OR any filter set
    if (!parsed.hasFilters && lowerSearch.length < 2) return [];
    const hits: MessageRecord[] = [];

    for (const message of messages) {
      if (lowerSearch && !message.search_text.includes(lowerSearch)) continue;

      if (parsed.mediaAny && !message.media_present) continue;
      if (parsed.mediaKind && message.media_kind !== parsed.mediaKind) continue;

      if (parsed.fromDate && (!message.date_utc || message.date_utc.slice(0, 10) < parsed.fromDate)) continue;
      if (parsed.toDate && (!message.date_utc || message.date_utc.slice(0, 10) > parsed.toDate)) continue;

      if (parsed.readState === "read" && !isMessageRead(message)) continue;
      if (parsed.readState === "unread" && isMessageRead(message)) continue;

      if (parsed.bookmarkedOnly && !isMessageBookmarked(message)) continue;

      if (parsed.threadOnly && !isInQuoteThread(message)) continue;

      hits.push(message);
      if (hits.length >= 30) break;
    }
    return hits;
  }, [
    parsed,
    lowerSearch,
    messages,
    isMessageRead,
    isMessageBookmarked,
    isInQuoteThread
  ]);

  const bookmarkHits = useMemo(() => {
    if (parsed.hasFilters) return [];
    if (!lowerSearch) return bookmarks.slice(0, 6);
    return bookmarks
      .filter((bookmark) =>
        bookmark.tags.some((tag) => tag.toLowerCase().includes(lowerSearch))
      )
      .slice(0, 8);
  }, [parsed.hasFilters, lowerSearch, bookmarks]);

  const threadHits = useMemo(() => {
    if (parsed.hasFilters) return [];
    if (!lowerSearch || lowerSearch.length < 2) return [];
    return threads
      .filter((thread) => thread.preview_text.toLowerCase().includes(lowerSearch))
      .slice(0, 6);
  }, [parsed.hasFilters, lowerSearch, threads]);

  if (!open) return null;

  const handleInlineSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = inlineValue.trim();
    if (!trimmed) return;
    if (inlineMode === "messageId") {
      const id = Number(trimmed);
      if (Number.isFinite(id)) onJumpToMessageId(id);
    } else if (inlineMode === "threadId") {
      const id = Number(trimmed);
      if (Number.isFinite(id)) onJumpToThreadId(id);
    } else if (inlineMode === "date") {
      onJumpToDate(trimmed);
    }
    setInlineMode(null);
    setInlineValue("");
  };

  return (
    <div
      className="cmd-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cmd-modal" onClick={(event) => event.stopPropagation()}>
        <Command label="Reader command palette" shouldFilter={!inlineMode}>
          <Command.Input
            ref={inputRef}
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={
              inlineMode === "messageId"
                ? "Loading…"
                : "Search · try: media:photo  from:2024-01-01  unread:"
            }
            disabled={inlineMode !== null}
          />
          {parsed.hasFilters && !inlineMode ? (
            <div className="cmd-active-filters">
              {parsed.mediaKind ? <span className="cmd-filter-chip">media: {parsed.mediaKind}</span> : null}
              {parsed.mediaAny ? <span className="cmd-filter-chip">any media</span> : null}
              {parsed.fromDate ? <span className="cmd-filter-chip">from: {parsed.fromDate}</span> : null}
              {parsed.toDate ? <span className="cmd-filter-chip">to: {parsed.toDate}</span> : null}
              {parsed.readState ? <span className="cmd-filter-chip">{parsed.readState}</span> : null}
              {parsed.bookmarkedOnly ? <span className="cmd-filter-chip">bookmarked</span> : null}
              {parsed.threadOnly ? <span className="cmd-filter-chip">in quote-thread</span> : null}
            </div>
          ) : null}
          {!inlineMode ? (
            <Command.List>
              <Command.Empty>No matches. Try a message id, date, or text.</Command.Empty>

              <Command.Group heading="Reading paths">
                <Command.Item
                  value="from-start"
                  keywords={["first", "beginning", "start", "front", "page one", "zero"]}
                  onSelect={onFromStart}
                >
                  <span className="cmd-item-icon">◯</span>
                  <span className="cmd-item-body">
                    <span>From the very first message</span>
                    <span className="cmd-item-detail">Read the archive front to back</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="resume"
                  keywords={["continue", "where i left off", "anchor", "saved"]}
                  onSelect={onResume}
                >
                  <span className="cmd-item-icon">▸</span>
                  <span className="cmd-item-body">
                    <span>Resume where I left off</span>
                    <span className="cmd-item-detail">Return to the saved reading anchor</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="first-unread"
                  keywords={["unread", "next", "new", "earliest"]}
                  onSelect={onJumpToFirstUnread}
                >
                  <span className="cmd-item-icon">●</span>
                  <span className="cmd-item-body">
                    <span>Jump to first unread</span>
                    <span className="cmd-item-detail">The earliest message you haven't read</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="latest"
                  keywords={["newest", "end", "catch up", "last", "recent"]}
                  onSelect={onLatest}
                >
                  <span className="cmd-item-icon">⤓</span>
                  <span className="cmd-item-body">
                    <span>Jump to the latest post</span>
                    <span className="cmd-item-detail">Catch up with the newest message</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="random"
                  keywords={["shuffle", "random", "explore", "wander", "surprise"]}
                  onSelect={onRandom}
                >
                  <span className="cmd-item-icon">✦</span>
                  <span className="cmd-item-body">
                    <span>Open a random spot</span>
                    <span className="cmd-item-detail">Shuffle into the archive</span>
                  </span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading="Jump">
                <Command.Item
                  value="jump-message-id"
                  keywords={["jump", "go to", "message", "id", "number"]}
                  onSelect={() => {
                    setInlineMode("messageId");
                    setInlineValue("");
                  }}
                >
                  <span className="cmd-item-icon">#</span>
                  <span className="cmd-item-body">
                    <span>Jump to message id…</span>
                    <span className="cmd-item-detail">Type a numeric id like 1234</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="jump-date"
                  keywords={["date", "calendar", "day", "year", "month"]}
                  onSelect={() => {
                    setInlineMode("date");
                    setInlineValue("");
                  }}
                >
                  <span className="cmd-item-icon">◷</span>
                  <span className="cmd-item-body">
                    <span>Jump to date…</span>
                    <span className="cmd-item-detail">Format YYYY-MM-DD</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="jump-thread-id"
                  keywords={["thread", "conversation", "chain", "reply"]}
                  onSelect={() => {
                    setInlineMode("threadId");
                    setInlineValue("");
                  }}
                >
                  <span className="cmd-item-icon">⌥</span>
                  <span className="cmd-item-body">
                    <span>Open thread by root id…</span>
                    <span className="cmd-item-detail">Numeric thread root</span>
                  </span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading="Views">
                <Command.Item
                  value="view-read"
                  keywords={["timeline", "stream", "messages", "feed"]}
                  onSelect={() => onSetView("read")}
                >
                  <span className="cmd-item-icon">📖</span>
                  <span className="cmd-item-body">
                    <span>Reader timeline</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="view-threads"
                  keywords={["conversations", "replies", "chains"]}
                  onSelect={() => onSetView("threads")}
                >
                  <span className="cmd-item-icon">⇉</span>
                  <span className="cmd-item-body">
                    <span>Threads</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="view-bookmarks"
                  keywords={["saved", "favorites", "starred", "tags"]}
                  onSelect={() => onSetView("bookmarks")}
                >
                  <span className="cmd-item-icon">★</span>
                  <span className="cmd-item-body">
                    <span>Bookmarks</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="view-progress"
                  keywords={["stats", "statistics", "completion", "read", "unread"]}
                  onSelect={() => onSetView("progress")}
                >
                  <span className="cmd-item-icon">▤</span>
                  <span className="cmd-item-body">
                    <span>Reading progress</span>
                  </span>
                </Command.Item>
              </Command.Group>

              {messageHits.length > 0 ? (
                <Command.Group
                  forceMount
                  heading={
                    parsed.hasFilters && !parsed.text
                      ? `Filtered messages (${messageHits.length}${messageHits.length >= 30 ? "+" : ""})`
                      : `Messages matching "${parsed.text}"`
                  }
                >
                  {messageHits.map((message) => (
                    <Command.Item
                      forceMount
                      key={`msg-${message.message_key}`}
                      value={`msg-${message.message_key}-${message.text}`}
                      onSelect={() => onJumpToMessage(message.message_key)}
                    >
                      <span className="cmd-item-icon">#{message.message_id}</span>
                      <span className="cmd-item-body">
                        <span>
                          {highlight(
                            trim(message.text || message.quote_text || "(media)", 88),
                            parsed.text
                          )}
                        </span>
                        <span className="cmd-item-detail">
                          {message.date_utc?.slice(0, 10) ?? "Unknown date"}
                          {message.is_reply ? " · reply" : ""}
                          {message.media_present ? ` · ${message.media_kind ?? "media"}` : ""}
                        </span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {threadHits.length > 0 ? (
                <Command.Group heading="Threads">
                  {threadHits.map((thread) => (
                    <Command.Item
                      key={`th-${thread.thread_key}`}
                      value={`th-${thread.thread_key}-${thread.preview_text}`}
                      onSelect={() => onJumpToThread(thread.thread_key)}
                    >
                      <span className="cmd-item-icon">⇉</span>
                      <span className="cmd-item-body">
                        <span>{highlight(trim(thread.preview_text, 84), parsed.text)}</span>
                        <span className="cmd-item-detail">
                          Thread #{thread.root_message_id} · {thread.message_count} messages
                        </span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {bookmarkHits.length > 0 ? (
                <Command.Group heading="Bookmarks">
                  {bookmarkHits.map((bookmark) => (
                    <Command.Item
                      key={bookmark.bookmark_id}
                      value={`bm-${bookmark.bookmark_id}-${bookmark.tags.join(" ")}`}
                      onSelect={() => {
                        if (bookmark.target_type === "message" && bookmark.message_key) {
                          onJumpToMessage(bookmark.message_key);
                        } else if (bookmark.thread_key) {
                          onJumpToThread(bookmark.thread_key);
                        }
                      }}
                    >
                      <span className="cmd-item-icon">★</span>
                      <span className="cmd-item-body">
                        <span>
                          {bookmark.target_type === "message"
                            ? `Message #${bookmark.message_key?.split(":")[1] ?? "?"}`
                            : `Thread ${bookmark.thread_key ?? ""}`}
                        </span>
                        <span className="cmd-item-detail">
                          {bookmark.tags.length ? bookmark.tags.join(", ") : "untagged"}
                        </span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              <Command.Group heading="Archive">
                <Command.Item
                  value="archive-import"
                  keywords={["load", "open", "folder", "reimport"]}
                  onSelect={onImport}
                >
                  <span className="cmd-item-icon">↺</span>
                  <span className="cmd-item-body">
                    <span>Import archive folder</span>
                    <span className="cmd-item-detail">Re-import or load a different archive</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="archive-reattach"
                  keywords={["media", "files", "permission", "folder"]}
                  onSelect={onReattachMedia}
                >
                  <span className="cmd-item-icon">⚭</span>
                  <span className="cmd-item-body">
                    <span>Reattach media folder</span>
                    <span className="cmd-item-detail">Restore local media access</span>
                  </span>
                </Command.Item>
                <Command.Item
                  value="archive-reset"
                  keywords={["clear", "delete", "wipe", "erase"]}
                  onSelect={onResetArchive}
                >
                  <span className="cmd-item-icon">⊗</span>
                  <span className="cmd-item-body">
                    <span>Reset local data</span>
                    <span className="cmd-item-detail">Clear the imported archive from this browser</span>
                  </span>
                </Command.Item>
              </Command.Group>
            </Command.List>
          ) : null}
        </Command>

        {inlineMode ? (
          <form className="cmd-inline-form" onSubmit={handleInlineSubmit}>
            <input
              autoFocus
              type={inlineMode === "date" ? "date" : "number"}
              value={inlineValue}
              onChange={(event) => setInlineValue(event.target.value)}
              placeholder={
                inlineMode === "messageId"
                  ? "Message id (e.g. 1234)"
                  : inlineMode === "threadId"
                    ? "Thread root id"
                    : "YYYY-MM-DD"
              }
            />
            <button type="submit">Go</button>
          </form>
        ) : null}

        <div className="cmd-modal-footer">
          <span>
            <span className="kbd">↑↓</span> nav · <span className="kbd">↵</span> select ·{" "}
            <span className="kbd">esc</span> close · filters:{" "}
            <code>media: from: to: read: unread: bookmarked: thread:</code>
          </span>
          <span>{messages.length.toLocaleString()} indexed</span>
        </div>
      </div>
    </div>
  );
}

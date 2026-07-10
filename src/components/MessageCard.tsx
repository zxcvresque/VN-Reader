import { useEffect, useMemo, useState } from "react";
import { getMediaObjectUrl } from "../lib/media";
import type { BookmarkRecord, MessageRecord } from "../types";
import TelegramRichText, { extractMessageEntities } from "./TelegramRichText";

interface MessageCardProps {
  bookmark: BookmarkRecord | null;
  directoryHandle: FileSystemDirectoryHandle | null;
  hasManualReadOverride: boolean;
  highlighted?: boolean;
  isRead: boolean;
  message: MessageRecord;
  quoteHighlight?: {
    offset: number;
    length: number;
    fallbackText: string | null;
  } | null;
  onClearReadOverride: (messageKey: string) => void;
  onMarkRead: (message: MessageRecord) => void;
  onMarkReadTillHere: (message: MessageRecord) => void;
  onMarkUnread: (message: MessageRecord) => void;
  onOpenMedia?: (url: string, kind: string | null, caption?: string) => void;
  onOpenQuoteSource?: (replyToMsgId: number) => void;
  onOpenThread: (threadKey: string) => void;
  onReattachMedia?: () => void;
  onSaveBookmarkTags: (message: MessageRecord, tags: string[]) => void;
  onToggleBookmark: (message: MessageRecord) => void;
  threadMessageCount: number;
  threadRootMissing?: boolean;
  viewMode?: "thread" | "timeline";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function trimPreview(value: string, limit = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "No text preview available";
  }
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, limit)}...`;
}

function buildRelatedLinks(message: MessageRecord): string[] {
  const explicitUrls = Array.isArray(message.external_urls) ? message.external_urls : [];
  const visibleUrls = new Set((message.text.match(/https?:\/\/[^\s]+/gi) ?? []).map((url) => url.replace(/[).,!?]+$/g, "")));

  return Array.from(
    new Set(
      explicitUrls
        .map((url) => url.replace(/[).,!?]+$/g, ""))
        .filter(Boolean)
        .filter((url) => !visibleUrls.has(url))
    )
  );
}

function MediaPreview({
  directoryHandle,
  message,
  onReattachMedia,
  onOpenMedia
}: {
  directoryHandle: FileSystemDirectoryHandle | null;
  message: MessageRecord;
  onReattachMedia?: () => void;
  onOpenMedia?: (url: string, kind: string | null, caption?: string) => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!directoryHandle || !message.media_path) {
        setObjectUrl(null);
        return;
      }

      try {
        const url = await getMediaObjectUrl(directoryHandle, message.media_path, message.message_key);
        if (!cancelled) {
          setObjectUrl(url);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setObjectUrl(null);
          setError(
            loadError instanceof Error ? loadError.message : "Could not open the local media file."
          );
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [directoryHandle, message.media_path, message.message_key]);

  if (!message.media_present) {
    return null;
  }

  if (!directoryHandle || !message.media_path || error) {
    return (
      <div className="reader-media reader-media-placeholder">
        <div>
          <p className="reader-media-kicker">{message.media_kind ?? "Media"}</p>
          <strong>{message.media_path ?? "Metadata only"}</strong>
          {!directoryHandle && onReattachMedia ? (
            <button
              type="button"
              className="reader-media-reattach"
              onClick={onReattachMedia}
            >
              Connect archive folder to show media
            </button>
          ) : null}
        </div>
        {error ? <small>{error}</small> : null}
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div className="reader-media reader-media-placeholder">
        <div>
          <p className="reader-media-kicker">{message.media_kind ?? "Media"}</p>
          <strong>Loading local file...</strong>
        </div>
      </div>
    );
  }

  const caption = `#${message.message_id} · ${message.media_path ?? ""}`;

  if (message.media_kind === "photo" || message.media_kind === "sticker") {
    return (
      <figure
        className="reader-media"
        onClick={() => onOpenMedia?.(objectUrl, message.media_kind, caption)}
      >
        <img className="reader-media-visual" src={objectUrl} alt="" loading="lazy" />
      </figure>
    );
  }

  if (message.media_kind === "video" || message.media_kind === "animation") {
    return (
      <figure
        className="reader-media"
        onClick={(event) => {
          // Don't trigger lightbox when clicking the inline video controls
          const target = event.target as HTMLElement;
          if (target.tagName === "VIDEO") return;
          onOpenMedia?.(objectUrl, message.media_kind, caption);
        }}
      >
        <video className="reader-media-visual" src={objectUrl} controls preload="metadata" />
      </figure>
    );
  }

  if (message.media_kind === "audio") {
    return (
      <div className="reader-media reader-media-audio">
        <audio src={objectUrl} controls preload="metadata" />
      </div>
    );
  }

  return (
    <div className="reader-media reader-media-file">
      <a href={objectUrl} target="_blank" rel="noreferrer">
        Open local {message.media_kind ?? "file"}
      </a>
    </div>
  );
}

export default function MessageCard({
  bookmark,
  directoryHandle,
  hasManualReadOverride,
  highlighted = false,
  isRead,
  message,
  quoteHighlight,
  onClearReadOverride,
  onMarkRead,
  onMarkReadTillHere,
  onMarkUnread,
  onOpenMedia,
  onOpenQuoteSource,
  onOpenThread,
  onReattachMedia,
  onSaveBookmarkTags,
  onToggleBookmark,
  threadMessageCount,
  threadRootMissing = false,
  viewMode = "timeline"
}: MessageCardProps) {
  const [tagInput, setTagInput] = useState(bookmark?.tags.join(", ") ?? "");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const messageEntities = useMemo(() => extractMessageEntities(message.raw), [message.raw]);
  const allSources = useMemo(() => {
    const explicit = Array.isArray(message.external_urls) ? message.external_urls : [];
    return Array.from(
      new Set(
        explicit
          .map((u) => u.replace(/[).,!?]+$/g, ""))
          .filter(Boolean)
      )
    );
  }, [message.external_urls]);
  const hiddenSources = useMemo(() => buildRelatedLinks(message), [message]);

  // Compute the actual highlight range. Prefer raw offset; otherwise fall back
  // to substring search of the quote text inside this message.
  const effectiveHighlight = useMemo(() => {
    if (!quoteHighlight) return null;
    const text = message.text ?? "";
    if (
      quoteHighlight.offset >= 0 &&
      quoteHighlight.length > 0 &&
      quoteHighlight.offset + quoteHighlight.length <= text.length
    ) {
      return { offset: quoteHighlight.offset, length: quoteHighlight.length };
    }
    if (quoteHighlight.fallbackText) {
      const idx = text.indexOf(quoteHighlight.fallbackText);
      if (idx >= 0) {
        return { offset: idx, length: quoteHighlight.fallbackText.length };
      }
    }
    return null;
  }, [quoteHighlight, message.text]);

  useEffect(() => {
    setTagInput(bookmark?.tags.join(", ") ?? "");
  }, [bookmark?.bookmark_id, bookmark?.tags]);

  return (
    <article
      className={[
        "reader-message",
        isRead ? "reader-message-read" : "reader-message-unread",
        highlighted ? "reader-message-highlighted" : "",
        viewMode === "thread" ? "reader-message-thread" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-message-key={message.message_key}
    >
      <header className="reader-message-header">
        <div className="reader-message-identifiers">
          <p className="reader-message-kicker">
            #{message.message_id}
            {message.edit_date_utc ? "  Edited" : ""}
            {message.post_author ? `  ${message.post_author}` : ""}
          </p>
          <h3>{formatDate(message.date_utc)}</h3>
        </div>

        <div className="reader-message-badges">
          <span className={`reader-pill ${isRead ? "reader-pill-read" : "reader-pill-unread"}`}>
            {isRead ? "Read" : "Unread"}
          </span>
          {message.is_quote_reply ? <span className="reader-pill reader-pill-quote">Quote</span> : null}
          {message.media_present ? (
            <span className="reader-pill reader-pill-media">{message.media_kind ?? "Media"}</span>
          ) : null}
          {threadRootMissing ? (
            <span className="reader-pill reader-pill-warning">Missing root</span>
          ) : null}
        </div>
      </header>

      <div className="reader-message-context">
        <div className="reader-message-threadline">
          <span>
            {message.thread_root_id === message.message_id
              ? `Thread root #${message.thread_root_id}`
              : `In thread #${message.thread_root_id}`}
          </span>
          {threadMessageCount > 1 ? (
            <button type="button" className="reader-inline-button" onClick={() => onOpenThread(message.thread_key)}>
              Open thread
            </button>
          ) : null}
        </div>

        {message.reply_to_msg_id ? (
          <div className="reader-message-threadline">
            <span>Replying to #{message.reply_to_msg_id}</span>
          </div>
        ) : null}

        {threadRootMissing ? (
          <div className="reader-thread-warning">
            This conversation still exists, but the original root post is missing from the source archive.
          </div>
        ) : null}
      </div>

      {message.quote_text ? (
        <blockquote
          className={`reader-quote ${
            onOpenQuoteSource && message.reply_to_msg_id ? "is-clickable" : ""
          }`}
          onClick={() => {
            if (onOpenQuoteSource && message.reply_to_msg_id) {
              onOpenQuoteSource(message.reply_to_msg_id);
            }
          }}
          role={onOpenQuoteSource && message.reply_to_msg_id ? "button" : undefined}
          tabIndex={onOpenQuoteSource && message.reply_to_msg_id ? 0 : undefined}
          onKeyDown={(event) => {
            if (
              onOpenQuoteSource &&
              message.reply_to_msg_id &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              onOpenQuoteSource(message.reply_to_msg_id);
            }
          }}
        >
          <span className="reader-quote-label">
            Quoted from #{message.reply_to_msg_id}
            {onOpenQuoteSource && message.reply_to_msg_id ? " · click to open" : ""}
          </span>
          <TelegramRichText text={message.quote_text} entities={message.quote_entities} />
        </blockquote>
      ) : null}

      <div className="reader-message-body">
        {message.text ? (
          <TelegramRichText
            className="reader-message-text"
            text={message.text}
            entities={messageEntities}
            highlightRange={effectiveHighlight}
          />
        ) : (
          <p className="reader-empty-copy">No text content</p>
        )}
      </div>

      <MediaPreview
        directoryHandle={directoryHandle}
        message={message}
        onOpenMedia={onOpenMedia}
        onReattachMedia={onReattachMedia}
      />

      <footer className="reader-message-footer">
        <div className="reader-message-actions">
          <button type="button" className="is-primary" onClick={() => onMarkReadTillHere(message)}>
            Read till here
          </button>
          <button type="button" onClick={() => onMarkRead(message)}>
            Mark read
          </button>
          <button type="button" onClick={() => onMarkUnread(message)}>
            Mark unread
          </button>
          {hasManualReadOverride ? (
            <button
              type="button"
              className="reader-text-button"
              onClick={() => onClearReadOverride(message.message_key)}
            >
              Clear override
            </button>
          ) : null}
          <button
            type="button"
            className={bookmark ? "is-saved" : ""}
            onClick={() => onToggleBookmark(message)}
          >
            {bookmark ? "★ Saved" : "Save"}
          </button>
          {allSources.length ? (
            <button
              type="button"
              className={sourcesOpen ? "is-saved" : ""}
              onClick={() => setSourcesOpen((open) => !open)}
            >
              {allSources.length === 1
                ? "Source"
                : `Sources (${allSources.length})`}
            </button>
          ) : null}
          {message.permalink ? (
            <a className="reader-text-link" href={message.permalink} target="_blank" rel="noreferrer">
              Telegram ↗
            </a>
          ) : null}
        </div>
        {sourcesOpen && allSources.length ? (
          <div className="reader-sources-panel">
            <p className="reader-sources-label">
              {hiddenSources.length === allSources.length
                ? "Linked from anchor words above"
                : "External sources from this message"}
            </p>
            <ul>
              {allSources.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url.length > 84 ? `${url.slice(0, 84)}…` : url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {bookmark ? (
          <div className="reader-bookmark-editor">
            <label>
              Notes or labels
              <input
                type="text"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                placeholder="save for later, important thread, revisit source"
              />
            </label>
            <button type="button" onClick={() => onSaveBookmarkTags(message, tagInput.split(","))}>
              Save labels
            </button>
          </div>
        ) : null}
      </footer>
    </article>
  );
}

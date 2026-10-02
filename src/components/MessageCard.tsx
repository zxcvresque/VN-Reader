import CustomSelect from "./CustomSelect";
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {BookmarkIcon,BookmarkFilledIcon,CheckIcon,DotsHorizontalIcon} from "@radix-ui/react-icons";
import { getMediaObjectUrl } from "../lib/media";
import type { BookmarkRecord, MessageRecord } from "../types";
import TelegramRichText, { extractMessageEntities } from "./TelegramRichText";

interface MessageCardProps {
  collections?: Array<{ id: string; title: string; added: boolean }>;
  onAddToCollection?: (message: MessageRecord, collectionId: string) => void;
  onOpenCollections?: () => void;
  readingStatus?: "in-progress" | "finished" | "revisit" | null;
  onSetReadingStatus?: (message: MessageRecord, status: "in-progress" | "finished" | "revisit" | null) => void;
  queued?: boolean;
  onToggleQueue?: (message: MessageRecord) => void;
  note?: string;
  onSaveNote?: (message: MessageRecord, note: string) => void;
  savedPassages?: Array<{ id: string; text: string; note: string }>;
  onSavePassage?: (message: MessageRecord, text: string) => void;
  onRemovePassage?: (id: string) => void;
  mediaMode?: "compact" | "full" | "collapsed";
  mediaPlayback?: { time: number; rate: number } | null;
  onSaveMediaPlayback?: (message: MessageRecord, playback: { time: number; rate: number }) => void;
  searchHighlight?: string;
  onReadAround?: (message: MessageRecord) => void;
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
  onOpenMedia,
  mediaMode = "compact",
  mediaPlayback,
  onSaveMediaPlayback
}: {
  directoryHandle: FileSystemDirectoryHandle | null;
  message: MessageRecord;
  mediaMode?: "compact" | "full" | "collapsed";
  mediaPlayback?: { time: number; rate: number } | null;
  onSaveMediaPlayback?: (message: MessageRecord, playback: { time: number; rate: number }) => void;
  onOpenMedia?: (url: string, kind: string | null, caption?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const lastSavedTime = useRef(-1);
  const [playbackRate, setPlaybackRate] = useState(mediaPlayback?.rate ?? 1);
  const collapsed = mediaMode === "collapsed" && !expanded;
  const mediaClass = `reader-media reader-media-${collapsed ? "collapsed" : mediaMode === "collapsed" ? "compact" : mediaMode}`;
  useEffect(() => { setExpanded(false); }, [mediaMode, message.message_key]);
  const savePlayback = (event: SyntheticEvent<HTMLMediaElement>, force = false) => {
    const element = event.currentTarget;
    if (force || Math.abs(element.currentTime - lastSavedTime.current) >= 4) {
      lastSavedTime.current = element.currentTime;
      onSaveMediaPlayback?.(message, { time: element.currentTime, rate: element.playbackRate });
    }
  };
  const restorePlayback = (event: SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget;
    const rate = mediaPlayback?.rate ?? 1;
    element.playbackRate = Number.isFinite(rate) && rate >= 0.25 && rate <= 4 ? rate : 1;
    setPlaybackRate(element.playbackRate);
    const time = mediaPlayback?.time ?? 0;
    if (Number.isFinite(time) && time > 0) {
      element.currentTime = Number.isFinite(element.duration) ? Math.min(time, element.duration) : time;
    }
  };
  const speedControl = (
    <label className="reader-media-speed">Playback speed
      <CustomSelect value={playbackRate} onChange={(event) => {
        const rate = Number(event.target.value);
        setPlaybackRate(rate);
        if (mediaRef.current) {
          mediaRef.current.playbackRate = rate;
          onSaveMediaPlayback?.(message, { time: mediaRef.current.currentTime, rate });
        }
      }}>
        {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </CustomSelect>
    </label>
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failedMedia = () => setError("This media could not be loaded. Try again.");

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!collapsed && message.media_path && /^\/api\/media\/\d+$/.test(message.media_path)) {
        setObjectUrl(message.media_path); setError(null); return;
      }
      if (collapsed || !directoryHandle || !message.media_path) {
        setObjectUrl(null);
        return;
      }

      setError(null);
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
  }, [directoryHandle, message.media_path, message.message_key, collapsed, attempt]);

  if (!message.media_present) {
    return null;
  }

  if (collapsed) {
    return <div className="reader-media reader-media-collapsed">
      <span>{message.media_kind ?? "Media"} · hidden for focused reading</span>
      <button type="button" className="reader-inline-button" onClick={() => setExpanded(true)}>Show media</button>
    </div>;
  }

  if ((!directoryHandle && !message.media_path?.startsWith("/api/media/")) || !message.media_path || error) {
    return (
      <div className="reader-media reader-media-placeholder">
        <div>
          <p className="reader-media-kicker">{message.media_kind ?? "Media"}</p>
          <strong>{message.media_path?.startsWith("/api/media/") ? "Media temporarily unavailable" : message.media_path ?? "Metadata only"}</strong>
          {error?<button type="button" className="reader-inline-button" onClick={()=>setAttempt(v=>v+1)}>Retry media</button>:null}

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
    return <figure className={mediaClass}>
      {onOpenMedia ? <button type="button" className="reader-media-image-button" aria-label={`Expand ${message.media_kind}`} onClick={() => onOpenMedia(objectUrl, message.media_kind, caption)}>
        <img className="reader-media-visual" src={objectUrl} alt={`Attached ${message.media_kind}`} loading="lazy" onError={failedMedia}/>
      </button> : <img className="reader-media-visual" src={objectUrl} alt={`Attached ${message.media_kind}`} loading="lazy" onError={failedMedia}/>}
    </figure>;
  }

  if (message.media_kind === "video" || message.media_kind === "animation") {
    return <figure className={mediaClass}>
      <video ref={mediaRef as React.RefObject<HTMLVideoElement>} className="reader-media-visual" src={objectUrl} controls preload="metadata" onError={failedMedia}
        onLoadedMetadata={restorePlayback} onTimeUpdate={savePlayback} onPause={(event) => savePlayback(event, true)} onSeeked={(event) => savePlayback(event, true)} onRateChange={(event) => { setPlaybackRate(event.currentTarget.playbackRate); savePlayback(event, true); }} />
      {speedControl}
      {onOpenMedia ? <button type="button" className="reader-inline-button" onClick={() => onOpenMedia(objectUrl, message.media_kind, caption)}>Expand video</button> : null}
    </figure>;
  }

  if (message.media_kind === "audio" || message.media_kind === "voice") {
    return <div className={`${mediaClass} reader-media-audio`}>
      <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={objectUrl} controls preload="metadata" onError={failedMedia}
        onLoadedMetadata={restorePlayback} onTimeUpdate={savePlayback} onPause={(event) => savePlayback(event, true)} onSeeked={(event) => savePlayback(event, true)} onRateChange={(event) => { setPlaybackRate(event.currentTarget.playbackRate); savePlayback(event, true); }} />
      {speedControl}
    </div>;
  }

  return (
    <div className="reader-media reader-media-file">
      <a href={objectUrl} target="_blank" rel="noreferrer">
        Open {message.media_kind ?? "file"}
      </a>
    </div>
  );
}

export default function MessageCard({
  readingStatus = null, onSetReadingStatus, queued = false, onToggleQueue,
  note = "", onSaveNote, savedPassages = [], onSavePassage, onRemovePassage,
  mediaMode = "compact", mediaPlayback, onSaveMediaPlayback, searchHighlight, onReadAround,
  collections = [], onAddToCollection, onOpenCollections,
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
  onSaveBookmarkTags,
  onToggleBookmark,
  threadMessageCount,
  threadRootMissing = false,
  viewMode = "timeline"
}: MessageCardProps) {
  const [tagInput, setTagInput] = useState(bookmark?.tags.join(", ") ?? "");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ left: 12, top: 12, width: 260, maxHeight: 320 });
  const closeActions = () => { if(actionsRef.current){actionsRef.current.open=false;actionsRef.current.querySelector<HTMLElement>("summary")?.focus();} };
  useEffect(() => {
    if (!actionsOpen) return;
    const placePanel = () => {
      const trigger = actionsRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const margin = 12;
      const width = Math.min(280, window.innerWidth - margin * 2);
      const above = trigger.top - margin - 8;
      const below = window.innerHeight - trigger.bottom - margin - 8;
      const upwards = above > below;
      const maxHeight = Math.max(44, Math.min(460, upwards ? above : below));
      const height = Math.min(panelRef.current?.scrollHeight ?? maxHeight, maxHeight);
      setPanelPosition({ width, maxHeight, left: Math.max(margin, Math.min(trigger.left, window.innerWidth - width - margin)), top: upwards ? Math.max(margin, trigger.top - height - 8) : trigger.bottom + 8 });
    };
    placePanel();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!actionsRef.current?.contains(target) && !panelRef.current?.contains(target) && actionsRef.current) actionsRef.current.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeActions(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", placePanel);
    window.addEventListener("scroll", placePanel, true);
    const frame = requestAnimationFrame(() => { placePanel(); panelRef.current?.querySelector<HTMLElement>("select, button, a")?.focus({ preventScroll: true }); });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", placePanel);
      window.removeEventListener("scroll", placePanel, true);
    };
  }, [actionsOpen]);
  const [noteDraft, setNoteDraft] = useState(note);
  const [selectedPassage, setSelectedPassage] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setNoteDraft(note); }, [note, message.message_key]);
  const captureSelection = () => {
    const selection = window.getSelection();
    const body = bodyRef.current;
    const text = selection?.toString().trim() ?? "";
    if (!selection || !body || !selection.anchorNode || !selection.focusNode || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)
      || text.length < 3 || text.length > 20000 || !message.text.replace(/\s+/g, " ").includes(text.replace(/\s+/g, " "))) {
      setSelectedPassage("");
      return;
    }
    setSelectedPassage(text);
  };
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
          {readingStatus ? <span className={`reader-pill reader-pill-${readingStatus}`}>{readingStatus === "in-progress" ? "In progress" : readingStatus === "finished" ? "Finished" : "Revisit"}</span> : null}
          {queued ? <span className="reader-pill reader-pill-queued">Read later</span> : null}
          {message.is_quote_reply ? <span className="reader-pill reader-pill-quote">Quote</span> : null}
          {message.media_present ? (
            <span className="reader-pill reader-pill-media">{message.media_kind ?? "Media"}</span>
          ) : null}
          {threadRootMissing ? (
            <span className="reader-pill reader-pill-warning">Missing root</span>
          ) : null}
        </div>
      </header>

      {threadMessageCount > 1 || message.reply_to_msg_id || threadRootMissing ? <div className="reader-message-context" data-tour="source-context">
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
      </div> : null}

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

      <div className="reader-message-body" data-tour="passages" ref={bodyRef} onMouseUp={captureSelection} onKeyUp={captureSelection} onTouchEnd={captureSelection}>
        {message.text ? (
          <TelegramRichText
            className="reader-message-text"
            text={message.text}
            entities={messageEntities}
            highlightRange={effectiveHighlight}
            searchHighlight={searchHighlight}
            savedPassageTexts={savedPassages.map((passage) => passage.text)}
          />
        ) : (
          <p className="reader-empty-copy">No text content</p>
        )}
      </div>

      {selectedPassage && onSavePassage ? <div className="reader-selection-bar" role="status">
        <span>Save this passage to your library</span>
        <button type="button" onClick={() => { onSavePassage(message, selectedPassage); setSelectedPassage(""); window.getSelection()?.removeAllRanges(); }}>Save passage</button>
        <button type="button" className="reader-text-button" onClick={() => setSelectedPassage("")}>Dismiss</button>
      </div> : null}

      <MediaPreview
        directoryHandle={directoryHandle}
        message={message}
        onOpenMedia={onOpenMedia}
        mediaMode={mediaMode}
        mediaPlayback={mediaPlayback}
        onSaveMediaPlayback={onSaveMediaPlayback}
      />

      <footer className="reader-message-footer">
        <div className="reader-study-controls reader-compact-controls" data-tour="reading-state">
          <div className="reader-compact-buttons">
            <button type="button" className={`post-icon-button ${bookmark?"is-saved":""}`} aria-label={bookmark?"Remove bookmark":"Save post"} title={bookmark?"Remove bookmark":"Save post"} aria-pressed={!!bookmark} onClick={()=>onToggleBookmark(message)}>{bookmark?<BookmarkFilledIcon aria-hidden/>:<BookmarkIcon aria-hidden/>}<span>{bookmark?"Saved":"Save"}</span></button>
            <button type="button" className={`post-icon-button ${isRead?"is-saved":""}`} aria-label={isRead?"Mark unseen":"Mark seen"} title={isRead?"Mark unseen":"Mark seen"} aria-pressed={isRead} onClick={()=>isRead?onMarkUnread(message):onMarkRead(message)}><CheckIcon aria-hidden/><span>{isRead?"Seen":"Mark seen"}</span></button>
            <details ref={actionsRef} className="post-more-actions" onToggle={event=>setActionsOpen(event.currentTarget.open)}><summary aria-label={`More actions for post ${message.message_id}`} aria-expanded={actionsOpen} aria-controls={`post-actions-${message.message_key}`} title="More actions"><DotsHorizontalIcon aria-hidden/><span>More</span></summary>
              {actionsOpen && createPortal(<div ref={panelRef} id={`post-actions-${message.message_key}`} className="post-more-panel post-more-portal" style={panelPosition} role="group" aria-label={`Additional actions for post ${message.message_id}`}>
                {onSetReadingStatus&&<label className="reader-status-control">Reading state<CustomSelect aria-label={`Reading state for post ${message.message_id}`} value={readingStatus??""} onChange={e=>onSetReadingStatus(message,e.target.value?e.target.value as "in-progress"|"finished"|"revisit":null)}><option value="">Not started</option><option value="in-progress">In progress</option><option value="finished">Finished</option><option value="revisit">Revisit</option></CustomSelect></label>}
                {onToggleQueue&&<button type="button" onClick={()=>{onToggleQueue(message);closeActions();}}>{queued?"Remove from queue":"Read later"}</button>}
                {onAddToCollection && <button type="button" onClick={()=>{setCollectionOpen(true);closeActions();}}>Add to collection</button>}
                {onSaveNote?<button type="button" onClick={()=>{setNoteOpen(o=>!o);closeActions();}}>{note?"Edit note":"Add note"}</button>:null}
                {onReadAround?<button type="button" onClick={()=>{closeActions();onReadAround(message);}}>Read nearby posts</button>:null}
                <button type="button" onClick={()=>{closeActions();onMarkReadTillHere(message);}}>Mark everything up to here seen</button>
                {hasManualReadOverride?<button type="button" onClick={()=>{closeActions();onClearReadOverride(message.message_key);}}>Use normal seen status</button>:null}
                {bookmark?<button type="button" onClick={()=>{setLabelsOpen(o=>!o);closeActions();}}>Edit bookmark labels</button>:null}
                {allSources.length?<button type="button" onClick={()=>{setSourcesOpen(o=>!o);closeActions();}}>{allSources.length===1?"Reference":`References (${allSources.length})`}</button>:null}
                {message.permalink?<a href={message.permalink} target="_blank" rel="noreferrer" onClick={closeActions}>Open in Telegram ↗</a>:null}
              </div>, document.body)}
            </details>
          </div>
        </div>
        {collectionOpen && onAddToCollection && <section className="reader-collection-picker reader-note-editor" aria-label={`Add post ${message.message_id} to a collection`}>
          <header><strong>Add to collection</strong><button type="button" className="reader-text-button" aria-label="Close collection picker" onClick={()=>setCollectionOpen(false)}>×</button></header>
          {collections.length ? <div className="reader-collection-choices">{collections.map(collection=><button type="button" key={collection.id} disabled={collection.added} onClick={()=>{onAddToCollection(message,collection.id);setCollectionOpen(false);}}><span>{collection.title}</span><small>{collection.added ? "Already added" : "Add post"}</small></button>)}</div> : <><p>Create your first collection in <strong>My library → Collections → New collection</strong>, then add posts here.</p>{onOpenCollections && <button type="button" onClick={()=>{setCollectionOpen(false);onOpenCollections();}}>Create your first collection</button>}</>}
        </section>}
        {noteOpen && onSaveNote ? <div className="reader-note-editor">
          <label>Personal note<textarea autoFocus aria-label={`Note for post ${message.message_id}`} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="What do you want to remember?" rows={3} /></label>
          <button type="button" onClick={() => { onSaveNote(message, noteDraft.trim()); setNoteOpen(false); }}>Save note</button>
          <button type="button" className="reader-text-button" onClick={() => { setNoteDraft(note); setNoteOpen(false); }}>Cancel</button>
        </div> : note ? <div className="reader-personal-note"><small>Your note</small><p>{note}</p></div> : null}
        {savedPassages.length ? <details className="reader-saved-passages"><summary>{savedPassages.length} saved {savedPassages.length === 1 ? "passage" : "passages"}</summary>
          {savedPassages.map((passage) => <div className="reader-saved-passage" key={passage.id}><blockquote>{passage.text}</blockquote>{passage.note ? <p>{passage.note}</p> : null}
            {onRemovePassage ? <button type="button" className="reader-text-button" onClick={() => onRemovePassage(passage.id)}>Remove passage</button> : null}
          </div>)}
        </details> : null}
        {sourcesOpen && allSources.length ? (
          <div className="reader-sources-panel">
            <p className="reader-sources-label">
              {hiddenSources.length === allSources.length
                ? "Linked from anchor words above"
                : "References from this post"}
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

        {bookmark && labelsOpen ? (
          <div className="reader-bookmark-editor">
            <label>
              Notes or labels
              <input
                type="text"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                placeholder="save for later, important thread, revisit reference"
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

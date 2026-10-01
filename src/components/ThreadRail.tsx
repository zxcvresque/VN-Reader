import { useEffect, useRef } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import type { MessageRecord } from "../types";
import { useTouchLayout } from "../lib/useTouchLayout";

interface ThreadRailProps {
  open: boolean;
  threadMessages: MessageRecord[];
  currentMessageKey: string | null;
  onSelectMessage: (messageKey: string) => void;
  onClose: () => void;
}

function preview(message: MessageRecord): string {
  const text = (message.text || message.quote_text || "").replace(/\s+/g, " ").trim();
  if (!text) return message.media_kind ? `Post with ${message.media_kind}` : "Post without text";
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

export default function ThreadRail({ open, threadMessages, currentMessageKey, onSelectMessage, onClose }: ThreadRailProps) {
  const rail = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const touch = useTouchLayout();
  useEffect(() => {
    if (!open) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && rail.current?.contains(document.activeElement)) {
        event.preventDefault(); onClose();
      }
    };
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [open, onClose]);
  useEffect(() => {
    if (!open || !list.current) return;
    const current = list.current.querySelector<HTMLElement>('[aria-current="location"]');
    if (!current) return;
    const bounds = list.current.getBoundingClientRect(), item = current.getBoundingClientRect();
    if (item.top < bounds.top) list.current.scrollTop += item.top - bounds.top - 12;
    else if (item.bottom > bounds.bottom) list.current.scrollTop += item.bottom - bounds.bottom + 12;
  }, [open, currentMessageKey]);
  if (!open || !threadMessages.length) return null;
  const rootId = threadMessages[0].thread_root_id;
  return <aside ref={rail} className="thread-rail is-open" aria-labelledby="thread-rail-title">
    <header className="thread-rail-header">
      <div><h3 id="thread-rail-title">In this thread</h3><p>{threadMessages.length} posts{rootId ? ` · #${rootId}` : ""}</p></div>
      <button type="button" className="thread-rail-close" aria-label="Close thread panel" onClick={onClose}><Cross2Icon aria-hidden="true" /></button>
    </header>
    <ol ref={list} className="thread-rail-list" aria-label="Posts in this conversation">
      {threadMessages.map(message => {
        const current = message.message_key === currentMessageKey;
        const kind = message.message_id === rootId ? "First post" : message.is_quote_reply ? "Quoted reply" : message.is_reply ? "Reply" : "Post";
        return <li key={message.message_key}><button type="button" className={`thread-rail-item ${current ? "is-current" : ""}`} aria-current={current ? "location" : undefined} onClick={() => { onSelectMessage(message.message_key); if (touch) onClose(); }}>
          <span className="thread-rail-item-head"><span>#{message.message_id}</span><span>{kind}</span>{current && <span className="thread-rail-current">You’re here</span>}</span>
          <span className="thread-rail-item-preview">{preview(message)}</span>
        </button></li>;
      })}
    </ol>
    <p className="thread-rail-hint">Choose a post to read it.</p>
  </aside>;
}

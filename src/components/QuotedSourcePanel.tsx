import { useLayoutEffect, useRef } from "react";
import { ArrowRightIcon, Cross2Icon } from "@radix-ui/react-icons";
import type { MessageRecord } from "../types";
import { resolveQuoteRange, type QuoteRangeRequest } from "../lib/quoteHighlight";
import TelegramRichText, { extractMessageEntities } from "./TelegramRichText";

interface QuotedSourcePanelProps {
  source: MessageRecord;
  origin: MessageRecord;
  onClose: () => void;
  onGoToPost: (messageKey: string, highlight: QuoteRangeRequest) => void;
  onReadAround: (messageKey: string) => void;
}

export default function QuotedSourcePanel({ source, origin, onClose, onGoToPost, onReadAround }: QuotedSourcePanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const highlight = {
    offset: origin.quote_offset_utf16 ?? -1,
    length: origin.quote_text_length ?? 0,
    fallbackText: origin.quote_text
  };
  const range = resolveQuoteRange(source.text, highlight);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollTop = 0;
    const mark = panel.querySelector<HTMLElement>(".tg-quote-highlight");
    const header = panel.querySelector<HTMLElement>("header");
    if (!mark || !header) return;
    const markRect = mark.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const availableTop = header.getBoundingClientRect().bottom + 20;
    if (markRect.bottom > panelRect.bottom || markRect.top < availableTop) {
      panel.scrollTop = Math.max(0, markRect.top - availableTop);
    }
  }, [source.message_key, origin.message_key]);

  return <aside ref={panelRef} className="reader-side-panel reader-source-peek" role="dialog" aria-label="Quoted source preview">
    <header>
      <div><p className="eyebrow">Quoted source</p><h2>Post #{source.message_id}</h2></div>
      <div className="reader-source-actions">
        <button type="button" className="reader-source-go" onClick={() => { onClose(); onGoToPost(source.message_key, highlight); }}>
          Go to post <ArrowRightIcon aria-hidden="true" />
        </button>
        <button type="button" className="reader-source-close" onClick={onClose} aria-label="Close quoted source"><Cross2Icon aria-hidden="true" /></button>
      </div>
    </header>
    <p>Your place in post #{origin.message_id} is preserved.</p>
    {source.text ? <TelegramRichText className="reader-message-text" text={source.text} entities={extractMessageEntities(source.raw)} highlightRange={range} /> : <p className="reader-message-text">This source contains media without text.</p>}
    <div className="library-actions"><button type="button" onClick={() => { onClose(); onReadAround(source.message_key); }}>Read surrounding posts</button></div>
  </aside>;
}

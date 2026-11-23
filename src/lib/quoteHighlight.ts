export interface QuoteRangeRequest {
  offset: number;
  length: number;
  fallbackText: string | null;
}

/** Telegram's offsets and JavaScript string indices both count UTF-16 units. */
export function resolveQuoteRange(text: string, quote: QuoteRangeRequest | null | undefined): { offset: number; length: number } | null {
  if (!quote) return null;
  const quotedText = quote.fallbackText;
  const validOffset = Number.isInteger(quote.offset) && quote.offset >= 0;
  if (quotedText) {
    if (validOffset && text.slice(quote.offset, quote.offset + quotedText.length) === quotedText) {
      return { offset: quote.offset, length: quotedText.length };
    }
    // A stale offset must not highlight unrelated words. If a passage repeats,
    // use the occurrence closest to Telegram's supplied position.
    let best = -1;
    let cursor = 0;
    while (cursor <= text.length) {
      const found = text.indexOf(quotedText, cursor);
      if (found < 0) break;
      if (best < 0 || (validOffset && Math.abs(found - quote.offset) < Math.abs(best - quote.offset))) best = found;
      cursor = found + Math.max(1, quotedText.length);
    }
    return best < 0 ? null : { offset: best, length: quotedText.length };
  }
  if (validOffset && Number.isInteger(quote.length) && quote.length > 0 && quote.offset + quote.length <= text.length) {
    return { offset: quote.offset, length: quote.length };
  }
  return null;
}

/** Resolve DOM endpoints against the original Telegram text, including the
 * blank-line separators that are represented by separate HTML paragraphs. */
export function selectedPassageRange(body: HTMLElement, selection: Selection | null, text: string) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return null;

  function sourceOffset(node: Node, offset: number): number | null {
    const element = node instanceof Element ? node : node.parentElement;
    const paragraph = element?.closest<HTMLElement>("[data-paragraph-offset]");
    if (paragraph && body.contains(paragraph)) {
      const prefix = document.createRange();
      prefix.selectNodeContents(paragraph);
      prefix.setEnd(node, offset);
      return Number(paragraph.dataset.paragraphOffset) + prefix.toString().length;
    }
    // Select-all and dragging outside a paragraph can end on its container.
    const next = node.childNodes[offset];
    if (!next) return text.length;
    const nextElement = next instanceof Element ? next : null;
    const first = nextElement?.matches("[data-paragraph-offset]") ? nextElement : nextElement?.querySelector("[data-paragraph-offset]");
    return first ? Number(first.getAttribute("data-paragraph-offset")) : null;
  }

  const start = sourceOffset(range.startContainer, range.startOffset);
  const end = sourceOffset(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const raw = text.slice(start, end);
  const selected = raw.trim();
  if (!selected) return null;
  return { offset: start + raw.length - raw.trimStart().length, length: selected.length, text: selected };
}

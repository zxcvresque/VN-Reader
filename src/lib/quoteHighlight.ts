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

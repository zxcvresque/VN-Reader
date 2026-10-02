import type { MessageRecord } from "../types";

/** A standalone #number searches the post ID, rather than references in its text. */
export function matchesMessageSearch(message: Pick<MessageRecord, "message_id" | "search_text">, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (/^#\d+$/.test(normalized)) {
    const id = Number(normalized.slice(1));
    return Number.isSafeInteger(id) && message.message_id === id;
  }
  return message.search_text.includes(normalized);
}

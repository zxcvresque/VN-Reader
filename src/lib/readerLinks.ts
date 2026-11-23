import type { MessageRecord } from "../types";

type TextRange = { offset: number; length: number };
type LinkedRange = TextRange & { fingerprint: string };

// Keep even a long selection shareable in a short URL. Check its contents
// before highlighting so an edited post can't silently point to other words.
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export function readerLink(origin: string, message: MessageRecord, range?: TextRange): string {
  const url = new URL(`/read/${message.chat_id}/${message.message_id}`, origin);
  if (range) {
    const text = message.text.slice(range.offset, range.offset + range.length);
    url.hash = `passage=${range.offset}.${range.length}.${fingerprint(text)}`;
  }
  return url.href;
}

export function parseReaderLink(location: Pick<Location, "pathname" | "hash">) {
  const post = /^\/read\/(-?\d+)\/([1-9]\d*)\/?$/.exec(location.pathname);
  if (!post || !post.slice(1).every(id => Number.isSafeInteger(Number(id)))) return null;
  const value = new URLSearchParams(location.hash.slice(1)).get("passage");
  const match = value && /^(\d+)\.([1-9]\d*)\.([a-z0-9]{1,7})$/.exec(value);
  const range: LinkedRange | null = match
    ? { offset: Number(match[1]), length: Number(match[2]), fingerprint: match[3] }
    : null;
  return { messageKey: `${post[1]}:${post[2]}`, postId: post[2], range, hasPassage: value !== null };
}

export function linkedPassage(text: string, range: LinkedRange | null): TextRange | null {
  if (!range || !Number.isSafeInteger(range.offset + range.length) || range.offset + range.length > text.length) return null;
  const selected = text.slice(range.offset, range.offset + range.length);
  return fingerprint(selected) === range.fingerprint ? { offset: range.offset, length: range.length } : null;
}

export function indexQuotingPosts(messages: MessageRecord[]): Map<string, MessageRecord[]> {
  const bySource = new Map<string, MessageRecord[]>();
  for (const message of messages) {
    const parent = message.reply_to_msg_id;
    if (!message.is_quote_reply || !parent || parent === message.message_id) continue;
    // Telegram can explicitly reference a post in a different channel using
    // the same numeric post ID. Archive chat IDs may be raw or marked (-100…).
    const peer = message.reply_to_peer_id;
    if (peer != null) {
      const channel = typeof peer === "object" && "channel_id" in peer ? peer.channel_id : null;
      if (typeof channel !== "number" || !Number.isSafeInteger(channel)) continue;
      if (message.chat_id !== channel && message.chat_id !== -1_000_000_000_000 - channel) continue;
    }
    const key = `${message.chat_id}:${parent}`;
    const replies = bySource.get(key);
    if (replies) replies.push(message);
    else bySource.set(key, [message]);
  }
  return bySource;
}

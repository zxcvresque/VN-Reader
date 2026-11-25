import type { MessageRecord } from "../types";

export function postMembers(post: MessageRecord): MessageRecord[] {
  return post.album_members ?? [post];
}

/** Telegram stores an album as individual messages. Only the reader presentation groups them. */
export function groupAlbumMessages(messages: MessageRecord[]): MessageRecord[] {
  const albums = new Map<string, MessageRecord[]>();
  for (const message of messages) {
    if (message.grouped_id == null) continue;
    const key = `${message.chat_id}:${message.grouped_id}`;
    const members = albums.get(key) ?? [];
    members.push(message);
    albums.set(key, members);
  }
  const emitted = new Set<string>();
  return messages.flatMap(message => {
    if (message.grouped_id == null) return [message];
    const key = `${message.chat_id}:${message.grouped_id}`;
    if (emitted.has(key)) return [];
    emitted.add(key);
    const members = albums.get(key)!.slice().sort((a, b) => a.message_id - b.message_id);
    if (members.length === 1) return [message];
    const first = members[0];
    const caption = members.find(member => member.text.trim()) ?? first;
    let text = "";
    const entities: unknown[] = [];
    for (const member of members) {
      if (!member.text) continue;
      if (text) text += "\n\n";
      const offset = text.length;
      const raw = member.raw as { entities?: Array<Record<string, unknown>> } | undefined;
      for (const entity of raw?.entities ?? []) {
        if (typeof entity.offset === "number") entities.push({ ...entity, offset: entity.offset + offset });
      }
      text += member.text;
    }
    return [{
      ...first,
      text,
      text_length: text.length,
      raw: { entities },
      album_members: members,
      external_urls: [...new Set(members.flatMap(member => member.external_urls ?? []))],
      search_text: members.map(member => member.search_text).join(" "),
      is_reply: caption.is_reply,
      is_quote_reply: caption.is_quote_reply,
      reply_to_msg_id: caption.reply_to_msg_id,
      reply_parent_id: caption.reply_parent_id,
      reply_parent_key: caption.reply_parent_key,
      quote_text: caption.quote_text,
      quote_text_length: caption.quote_text_length,
      quote_offset_utf16: caption.quote_offset_utf16,
      quote_entities: caption.quote_entities,
      thread_root_id: caption.thread_root_id,
      thread_key: caption.thread_key
    }];
  });
}

/** Keep links and saved work attached to any photo addressable through the complete post. */
export function indexReaderPosts(posts: MessageRecord[]): Map<string, MessageRecord> {
  return new Map(posts.flatMap(post => postMembers(post).map(member => [member.message_key, post] as const)));
}

export function albumCaptionOffset(post: MessageRecord, messageKey: string): number {
  let offset = 0;
  for (const member of postMembers(post)) {
    if (member.message_key === messageKey) return member.text ? offset : 0;
    if (member.text) offset += member.text.length + 2;
  }
  return 0;
}

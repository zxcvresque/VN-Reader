import { resetArchiveData } from "./idb";
import {
  getManifest,
  getMessageRecords,
  putImportSession,
  replaceAllMessages,
  replaceAllThreads,
  saveDirectoryHandle,
  saveManifest
} from "./idb";
import type {
  ArchiveManifest,
  ArchiveMessage,
  ImportArchiveResult,
  ImportSessionRecord,
  MessageRecord,
  ThreadRecord
} from "../types";

type MessageSeed = Omit<MessageRecord, "reply_parent_key" | "search_text" | "thread_key" | "thread_root_id">;

function nowIso(): string {
  return new Date().toISOString();
}

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

async function readJsonFile<T>(directoryHandle: FileSystemDirectoryHandle, name: string): Promise<T> {
  const fileHandle = await directoryHandle.getFileHandle(name);
  const file = await fileHandle.getFile();
  return JSON.parse(await file.text()) as T;
}

async function* iterateJsonlFile(file: File): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = file.stream().getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/g);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        yield trimmed;
      }
    }
  }

  buffer += decoder.decode();
  const finalLine = buffer.trim();
  if (finalLine) {
    yield finalLine;
  }
}

function toMessageSeed(input: ArchiveMessage | MessageRecord): MessageSeed {
  return {
    archive_version: input.archive_version,
    chat_id: input.chat_id,
    chat_username: input.chat_username,
    chat_title: input.chat_title,
    chat_type: input.chat_type,
    message_key: input.message_key || messageKey(input.chat_id, input.message_id),
    message_id: input.message_id,
    message_type: input.message_type,
    date_utc: input.date_utc,
    edit_date_utc: input.edit_date_utc,
    text: input.text ?? "",
    text_length: input.text_length ?? (input.text?.length ?? 0),
    post_author: input.post_author,
    sender_id: input.sender_id,
    from_id: input.from_id,
    grouped_id: input.grouped_id,
    views: input.views,
    forwards: input.forwards,
    permalink: input.permalink,
    media_kind: input.media_kind,
    media_present: input.media_present,
    media_path: input.media_path,
    media_download_error: input.media_download_error,
    external_urls: Array.isArray(input.external_urls) ? input.external_urls : [],
    media_raw: input.media_raw,
    reply_parent_id: input.reply_parent_id ?? input.reply_to_msg_id,
    reply_to_msg_id: input.reply_to_msg_id,
    reply_to_top_id: input.reply_to_top_id,
    reply_to_peer_id: input.reply_to_peer_id,
    is_reply: input.is_reply,
    is_quote_reply: input.is_quote_reply,
    quote_text: input.quote_text,
    quote_text_length: input.quote_text_length ?? (input.quote_text?.length ?? 0),
    quote_offset_utf16: input.quote_offset_utf16,
    quote_entities: input.quote_entities ?? [],
    reply_header: input.reply_header,
    reply_counts: input.reply_counts,
    raw: input.raw
  };
}

export function recomputeThreadLinks(messages: MessageSeed[]): MessageRecord[] {
  const ordered = [...messages].sort((left, right) => left.message_id - right.message_id);
  const threadRootByMessageId = new Map<number, number>();

  return ordered.map((message) => {
    let threadRootId = message.message_id;

    if (message.reply_to_top_id) {
      threadRootId = message.reply_to_top_id;
    } else if (message.reply_to_msg_id) {
      threadRootId = threadRootByMessageId.get(message.reply_to_msg_id) ?? message.reply_to_msg_id;
    }

    threadRootByMessageId.set(message.message_id, threadRootId);

    const replyParentKey = message.reply_to_msg_id
      ? messageKey(message.chat_id, message.reply_to_msg_id)
      : null;

    return {
      ...message,
      reply_parent_key: replyParentKey,
      search_text: `${message.text ?? ""} ${message.quote_text ?? ""} ${(message.external_urls ?? []).join(" ")}`
        .trim()
        .toLowerCase(),
      thread_root_id: threadRootId,
      thread_key: messageKey(message.chat_id, threadRootId)
    };
  });
}

export function buildThreadRecords(messages: MessageRecord[]): ThreadRecord[] {
  const byThread = new Map<string, ThreadRecord>();

  for (const message of messages) {
    const previewText = (message.text || message.quote_text || "").trim();
    const rootMessageKey = messageKey(message.chat_id, message.thread_root_id);
    const existing = byThread.get(message.thread_key);

    if (!existing) {
      byThread.set(message.thread_key, {
        thread_key: message.thread_key,
        chat_id: message.chat_id,
        root_message_id: message.thread_root_id,
        root_message_key: rootMessageKey,
        root_missing: true,
        first_message_id: message.message_id,
        first_message_date_utc: message.date_utc,
        last_message_id: message.message_id,
        last_message_date_utc: message.date_utc,
        message_count: 1,
        preview_text: previewText || `Message ${message.thread_root_id}`,
        has_media: message.media_present,
        has_quote_replies: message.is_quote_reply,
        has_replies: message.is_reply
      });
      if (message.message_id === message.thread_root_id) {
        byThread.get(message.thread_key)!.root_missing = false;
        byThread.get(message.thread_key)!.preview_text = previewText || `Message ${message.thread_root_id}`;
      }
      continue;
    }

    existing.message_count += 1;
    if (message.message_id < existing.first_message_id) {
      existing.first_message_id = message.message_id;
      existing.first_message_date_utc = message.date_utc;
    }
    if (message.message_id > existing.last_message_id) {
      existing.last_message_id = message.message_id;
      existing.last_message_date_utc = message.date_utc;
    }
    existing.has_media = existing.has_media || message.media_present;
    existing.has_quote_replies = existing.has_quote_replies || message.is_quote_reply;
    existing.has_replies = existing.has_replies || message.is_reply;
    if (message.message_id === existing.root_message_id) {
      existing.root_missing = false;
      existing.preview_text = previewText || existing.preview_text;
    }
  }

  return Array.from(byThread.values()).sort(
    (left, right) => left.first_message_id - right.first_message_id
  );
}

function buildImportSession(
  manifest: ArchiveManifest,
  importedMessageCount: number,
  totalMessageCount: number,
  totalThreadCount: number
): ImportSessionRecord {
  const importedAt = nowIso();
  return {
    import_id: `${manifest.source.chat_id}:${importedAt}`,
    archive_version: manifest.archive_version,
    chat_id: manifest.source.chat_id,
    imported_at_utc: importedAt,
    imported_message_count: importedMessageCount,
    total_message_count: totalMessageCount,
    total_thread_count: totalThreadCount,
    source_exported_at_utc: manifest.exported_at_utc
  };
}

export async function pickArchiveDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error("This browser does not support folder import. Use a Chromium-based browser.");
  }

  return window.showDirectoryPicker({ mode: "read" });
}

export async function readArchiveManifest(
  directoryHandle: FileSystemDirectoryHandle
): Promise<ArchiveManifest> {
  return readJsonFile<ArchiveManifest>(directoryHandle, "manifest.json");
}

export async function getDirectoryPermission(
  directoryHandle: FileSystemDirectoryHandle | null
): Promise<"granted" | "needs-reattach" | "unsupported"> {
  if (!directoryHandle) {
    return "needs-reattach";
  }

  const permissionAwareHandle = directoryHandle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };

  if (typeof permissionAwareHandle.queryPermission !== "function") {
    return "unsupported";
  }

  const status = await permissionAwareHandle.queryPermission({ mode: "read" });
  return status === "granted" ? "granted" : "needs-reattach";
}

export async function reattachArchiveDirectory(
  directoryHandle: FileSystemDirectoryHandle
): Promise<ArchiveManifest> {
  const currentManifest = await getManifest();
  const nextManifest = await readArchiveManifest(directoryHandle);

  if (
    currentManifest &&
    currentManifest.source.chat_id !== nextManifest.source.chat_id
  ) {
    throw new Error("Selected folder belongs to a different channel.");
  }

  await saveDirectoryHandle(directoryHandle);
  return nextManifest;
}

export async function importArchiveDirectory(
  directoryHandle: FileSystemDirectoryHandle
): Promise<ImportArchiveResult> {
  const manifest = await readArchiveManifest(directoryHandle);
  const existingManifest = await getManifest();

  if (
    existingManifest &&
    existingManifest.source.chat_id !== manifest.source.chat_id && existingManifest.source.chat_id !== -90001
  ) {
    throw new Error(
      "This reader is single-channel for v1. Reset local data before importing another channel."
    );
  }

  const fileHandle = await directoryHandle.getFileHandle(manifest.files.messages);
  const file = await fileHandle.getFile();

  const replacingSample = existingManifest?.source.chat_id === -90001 && manifest.source.chat_id !== -90001;
  const existingMessages = replacingSample ? [] : await getMessageRecords();
  const merged = new Map<string, MessageSeed>(
    existingMessages.map((message) => [message.message_key, toMessageSeed(message)])
  );

  let importedMessageCount = 0;
  for await (const line of iterateJsonlFile(file)) {
    const archiveMessage = JSON.parse(line) as ArchiveMessage;
    merged.set(archiveMessage.message_key, toMessageSeed(archiveMessage));
    importedMessageCount += 1;
  }

  const normalizedMessages = recomputeThreadLinks(Array.from(merged.values()));
  const threads = buildThreadRecords(normalizedMessages);

  if (replacingSample) await resetArchiveData();
  await replaceAllMessages(normalizedMessages);
  await replaceAllThreads(threads);
  await saveManifest(manifest);
  await saveDirectoryHandle(directoryHandle);

  const session = buildImportSession(
    manifest,
    importedMessageCount,
    normalizedMessages.length,
    threads.length
  );
  await putImportSession(session);

  return {
    manifest,
    importedMessageCount,
    totalMessageCount: normalizedMessages.length,
    totalThreadCount: threads.length
  };
}

export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(","));
}

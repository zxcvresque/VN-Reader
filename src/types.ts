export interface ArchiveManifest {
  archive_version: number;
  exported_at_utc: string;
  source: {
    chat_input: string;
    chat_id: number;
    chat_title: string | null;
    chat_username: string | null;
    chat_type: string;
    session_name: string;
  };
  files: {
    messages: string;
    media_dir: string | null;
  };
  counts: {
    messages: number;
    media_downloaded: number;
    media_download_failures: number;
  };
  range: {
    first_message_id: number | null;
    first_message_date_utc: string | null;
    last_message_id: number | null;
    last_message_date_utc: string | null;
  };
  options: {
    download_media: boolean;
    include_raw: boolean;
    limit: number | null;
  };
  chat_raw?: unknown;
}

export interface ArchiveMessage {
  archive_version: number;
  chat_id: number;
  chat_username: string | null;
  chat_title: string | null;
  chat_type: string;
  message_key: string;
  message_id: number;
  message_type: string;
  date_utc: string | null;
  edit_date_utc: string | null;
  text: string;
  text_length: number;
  post_author: string | null;
  sender_id: number | null;
  from_id: unknown;
  grouped_id: number | null;
  views: number | null;
  forwards: number | null;
  permalink: string | null;
  media_kind: string | null;
  media_present: boolean;
  media_path: string | null;
  media_download_error: string | null;
  media_preview?: {
    url?: string | null;
    title?: string | null;
    description?: string | null;
    site_name?: string | null;
  } | null;
  external_urls: string[];
  media_raw: unknown;
  reply_parent_id: number | null;
  reply_to_msg_id: number | null;
  reply_to_top_id: number | null;
  reply_to_peer_id: unknown;
  is_reply: boolean;
  is_quote_reply: boolean;
  quote_text: string | null;
  quote_text_length: number;
  quote_offset_utf16: number | null;
  quote_entities: unknown[];
  reply_header: unknown;
  reply_counts: {
    replies: number | null;
    channel_id: number | null;
    recent_repliers: unknown;
  };
  raw?: unknown;
}

export interface MessageRecord extends ArchiveMessage {
  thread_root_id: number;
  thread_key: string;
  reply_parent_key: string | null;
  search_text: string;
}

export interface ThreadRecord {
  thread_key: string;
  chat_id: number;
  root_message_id: number;
  root_message_key: string;
  root_missing: boolean;
  first_message_id: number;
  first_message_date_utc: string | null;
  last_message_id: number;
  last_message_date_utc: string | null;
  message_count: number;
  preview_text: string;
  has_media: boolean;
  has_quote_replies: boolean;
  has_replies: boolean;
}

export interface ReadCursor {
  chat_id: number;
  message_key: string;
  message_id: number;
  date_utc: string | null;
  updated_at_utc: string;
}

export interface MessageReadOverride {
  message_key: string;
  status: "read" | "unread";
  updated_at_utc: string;
}

export interface BookmarkRecord {
  bookmark_id: string;
  target_type: "message" | "thread";
  target_key: string;
  chat_id: number;
  message_key: string | null;
  thread_key: string | null;
  tags: string[];
  updated_at_utc: string;
}

export interface ImportSessionRecord {
  import_id: string;
  archive_version: number;
  chat_id: number;
  imported_at_utc: string;
  imported_message_count: number;
  total_message_count: number;
  total_thread_count: number;
  source_exported_at_utc: string;
}

export interface AppSnapshot {
  manifest: ArchiveManifest | null;
  messages: MessageRecord[];
  threads: ThreadRecord[];
  bookmarks: BookmarkRecord[];
  readOverrides: MessageReadOverride[];
  readCursor: ReadCursor | null;
  importSessions: ImportSessionRecord[];
  directoryHandle: FileSystemDirectoryHandle | null;
}

export interface ImportArchiveResult {
  manifest: ArchiveManifest;
  importedMessageCount: number;
  totalMessageCount: number;
  totalThreadCount: number;
}

export interface ReaderStats {
  totalMessages: number;
  totalThreads: number;
  readMessages: number;
  unreadMessages: number;
  bookmarkedItems: number;
  percentRead: number;
  bookmarksByTag: Array<{ tag: string; count: number }>;
}

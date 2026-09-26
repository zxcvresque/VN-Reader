import type {
  AppSnapshot,
  ArchiveManifest,
  BookmarkRecord,
  ImportSessionRecord,
  MessageReadOverride,
  MessageRecord,
  ReadCursor,
  ThreadRecord
} from "../types";

const DB_NAME = "vn-reader";
const DB_VERSION = 4;

type AppMetaRecord = {
  key: string;
  value: unknown;
};

type StoreMap = {
  app_meta: AppMetaRecord;
  bookmarks: BookmarkRecord;
  import_sessions: ImportSessionRecord;
  messages: MessageRecord;
  read_cursors: ReadCursor;
  read_overrides: MessageReadOverride;
  threads: ThreadRecord;
};

type StoreName = keyof StoreMap;

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("app_meta")) {
        database.createObjectStore("app_meta", { keyPath: "key" });
      }

      if (!database.objectStoreNames.contains("messages")) {
        const store = database.createObjectStore("messages", { keyPath: "message_key" });
        store.createIndex("by_chat_id", "chat_id", { unique: false });
        store.createIndex("by_message_id", "message_id", { unique: false });
        store.createIndex("by_date_utc", "date_utc", { unique: false });
        store.createIndex("by_thread_key", "thread_key", { unique: false });
        store.createIndex("by_reply_parent_id", "reply_parent_id", { unique: false });
        store.createIndex("by_is_quote_reply", "is_quote_reply", { unique: false });
        store.createIndex("by_media_present", "media_present", { unique: false });
      }

      if (!database.objectStoreNames.contains("threads")) {
        const store = database.createObjectStore("threads", { keyPath: "thread_key" });
        store.createIndex("by_root_message_id", "root_message_id", { unique: false });
        store.createIndex("by_first_message_id", "first_message_id", { unique: false });
      }

      if (!database.objectStoreNames.contains("bookmarks")) {
        const store = database.createObjectStore("bookmarks", { keyPath: "bookmark_id" });
        store.createIndex("by_target_key", "target_key", { unique: false });
        store.createIndex("by_target_type", "target_type", { unique: false });
        store.createIndex("by_tags", "tags", { unique: false, multiEntry: true });
      }

      if (!database.objectStoreNames.contains("read_overrides")) {
        const store = database.createObjectStore("read_overrides", { keyPath: "message_key" });
        store.createIndex("by_status", "status", { unique: false });
      }

      if (!database.objectStoreNames.contains("read_cursors")) {
        database.createObjectStore("read_cursors", { keyPath: "chat_id" });
      }

      if (!database.objectStoreNames.contains("import_sessions")) {
        const store = database.createObjectStore("import_sessions", { keyPath: "import_id" });
        store.createIndex("by_chat_id", "chat_id", { unique: false });
        store.createIndex("by_imported_at_utc", "imported_at_utc", { unique: false });
      }

      // Remove only retired feature stores; preserve the archive and reading state.
      for (const retiredStore of ["user_aliases", "entity_resolutions"]) {
        if (database.objectStoreNames.contains(retiredStore)) {
          database.deleteObjectStore(retiredStore);
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function getStore(storeName: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  return transaction.objectStore(storeName);
}

async function getAllFromStore<T>(storeName: StoreName): Promise<T[]> {
  const store = await getStore(storeName, "readonly");
  return requestToPromise(store.getAll()) as Promise<T[]>;
}

async function putMany<T>(storeName: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  values.forEach((value) => {
    store.put(value);
  });

  await transactionDone(transaction);
}

async function putOne<T>(storeName: StoreName, value: T): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function getOne<T>(storeName: StoreName, key: IDBValidKey): Promise<T | null> {
  const store = await getStore(storeName, "readonly");
  const result = await requestToPromise(store.get(key));
  return (result as T | undefined) ?? null;
}

async function deleteOne(storeName: StoreName, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

async function clearStore(storeName: StoreName): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
}

export async function replaceAllMessages(messages: MessageRecord[]): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction("messages", "readwrite");
  const store = transaction.objectStore("messages");
  store.clear();
  messages.forEach((message) => store.put(message));
  await transactionDone(transaction);
}

export async function replaceAllThreads(threads: ThreadRecord[]): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction("threads", "readwrite");
  const store = transaction.objectStore("threads");
  store.clear();
  threads.forEach((thread) => store.put(thread));
  await transactionDone(transaction);
}

export async function getMessageRecords(): Promise<MessageRecord[]> {
  const records = await getAllFromStore<MessageRecord>("messages");
  return records.sort((left, right) => left.message_id - right.message_id);
}

export async function getThreadRecords(): Promise<ThreadRecord[]> {
  const records = await getAllFromStore<ThreadRecord>("threads");
  return records.sort((left, right) => left.first_message_id - right.first_message_id);
}

export async function getBookmarks(): Promise<BookmarkRecord[]> {
  const records = await getAllFromStore<BookmarkRecord>("bookmarks");
  return records.sort((left, right) => left.target_key.localeCompare(right.target_key));
}

export async function getReadOverrides(): Promise<MessageReadOverride[]> {
  return getAllFromStore<MessageReadOverride>("read_overrides");
}

export async function getReadCursor(chatId: number | null): Promise<ReadCursor | null> {
  if (chatId === null) {
    return null;
  }
  return getOne<ReadCursor>("read_cursors", chatId);
}

export async function getImportSessions(): Promise<ImportSessionRecord[]> {
  const records = await getAllFromStore<ImportSessionRecord>("import_sessions");
  return records.sort((left, right) => right.imported_at_utc.localeCompare(left.imported_at_utc));
}

export async function setMetaValue(key: string, value: unknown): Promise<void> {
  await putOne<AppMetaRecord>("app_meta", { key, value });
}

export async function getMetaValue<T>(key: string): Promise<T | null> {
  const record = await getOne<AppMetaRecord>("app_meta", key);
  return (record?.value as T | undefined) ?? null;
}

export async function saveManifest(manifest: ArchiveManifest): Promise<void> {
  await setMetaValue("manifest", manifest);
}

export async function getManifest(): Promise<ArchiveManifest | null> {
  return getMetaValue<ArchiveManifest>("manifest");
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
  await setMetaValue("archiveDirectoryHandle", handle);
}

export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return getMetaValue<FileSystemDirectoryHandle>("archiveDirectoryHandle");
}

export async function putReadCursor(cursor: ReadCursor): Promise<void> {
  await putOne<ReadCursor>("read_cursors", cursor);
}

export async function putReadOverride(override: MessageReadOverride): Promise<void> {
  await putOne<MessageReadOverride>("read_overrides", override);
}

export async function deleteReadOverride(messageKey: string): Promise<void> {
  await deleteOne("read_overrides", messageKey);
}

export async function putBookmark(bookmark: BookmarkRecord): Promise<void> {
  await putOne<BookmarkRecord>("bookmarks", bookmark);
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  await deleteOne("bookmarks", bookmarkId);
}

export async function putImportSession(session: ImportSessionRecord): Promise<void> {
  await putOne<ImportSessionRecord>("import_sessions", session);
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const manifest = await getManifest();
  const chatId = manifest?.source.chat_id ?? null;
  const [messages, threads, bookmarks, readOverrides, readCursor, importSessions, directoryHandle] =
    await Promise.all([
      getMessageRecords(),
      getThreadRecords(),
      getBookmarks(),
      getReadOverrides(),
      getReadCursor(chatId),
      getImportSessions(),
      getDirectoryHandle()
    ]);

  return {
    manifest,
    messages,
    threads,
    bookmarks,
    readOverrides,
    readCursor,
    importSessions,
    directoryHandle
  };
}

export async function resetArchiveData(): Promise<void> {
  await Promise.all([
    clearStore("messages"),
    clearStore("threads"),
    clearStore("bookmarks"),
    clearStore("read_overrides"),
    clearStore("read_cursors"),
    clearStore("import_sessions"),
    clearStore("app_meta")
  ]);
}

export async function putImportSessions(sessions: ImportSessionRecord[]): Promise<void> {
  await putMany<ImportSessionRecord>("import_sessions", sessions);
}

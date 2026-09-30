export type ReadingStatus = "in-progress" | "finished" | "revisit";

export interface SavedPassage {
  id: string;
  messageKey: string;
  text: string;
  note: string;
  createdAt: string;
}

export interface ReadingCollection {
  id: string;
  title: string;
  introduction: string;
  items: Array<{ id: string; messageKey: string; passageId?: string }>;
}

export interface ReadingState {
  version: 1;
  chatId: number | null;
  positions: Record<string, { offset: number; updatedAt: string; paragraphOffset?: number; paragraphRatio?: number }>;
  statuses: Record<string, ReadingStatus>;
  queue: string[];
  notes: Record<string, string>;
  passages: SavedPassage[];
  collections: ReadingCollection[];
  media: Record<string, { time: number; rate: number }>;
}

export function createReadingState(chatId: number | null): ReadingState {
  return { version: 1, chatId, positions: {}, statuses: {}, queue: [], notes: {}, passages: [], collections: [], media: {} };
}

const MAX_ITEMS = 100_000;
const MAX_TEXT = 2_000_000;

function fail(path: string, detail: string): never {
  throw new Error(`Reading data ${path}: ${detail}.`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "unsupported object type");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected a list");
  if (value.length > MAX_ITEMS) fail(path, "too many entries");
  return value;
}

function string(value: unknown, path: string, nonempty = false): string {
  if (typeof value !== "string") fail(path, "expected text");
  if (value.length > MAX_TEXT) fail(path, "text is too long");
  if (nonempty && !value.trim()) fail(path, "cannot be empty");
  return value;
}

function number(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail(path, `expected a finite number of at least ${minimum}`);
  return value;
}

function date(value: unknown, path: string): string {
  const result = string(value, path, true);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) fail(path, "expected an ISO timestamp");
  return result;
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "contains duplicate entries");
}

/** Validate and copy untrusted backup data; never spread its objects into live state. */
export function validateReadingState(value: unknown, chatId: number | null): ReadingState {
  if (chatId !== null && !Number.isSafeInteger(chatId)) fail("archive", "invalid archive ID");
  const input = object(value, "backup");
  if (input.version !== 1) fail("version", "unsupported backup version");
  if (input.chatId !== chatId) fail("archive", "this backup belongs to a different archive");
  const key = (value: unknown, path: string): string => {
    const result = string(value, path, true);
    const match = /^(-?\d+):(\d+)$/.exec(result);
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) fail(path, "invalid post identifier");
    if (chatId !== null && Number(match[1]) !== chatId) fail(path, "post belongs to a different archive");
    return result;
  };
  const map = <T>(value: unknown, path: string, parse: (entry: unknown, path: string) => T): Record<string, T> => {
    const entries = Object.entries(object(value, path));
    if (entries.length > MAX_ITEMS) fail(path, "too many entries");
    return Object.fromEntries(entries.map(([messageKey, entry]) => [key(messageKey, `${path} key`), parse(entry, `${path}[${messageKey}]`)]));
  };
  const result = createReadingState(chatId);
  result.positions = map(input.positions, "positions", (entry, path) => {
    const item = object(entry, path);
    const position: ReadingState["positions"][string] = {
      offset: number(item.offset, `${path}.offset`), updatedAt: date(item.updatedAt, `${path}.updatedAt`)
    };
    if (item.paragraphOffset !== undefined) {
      const offset = number(item.paragraphOffset, `${path}.paragraphOffset`);
      if (!Number.isSafeInteger(offset)) fail(`${path}.paragraphOffset`, "expected a nonnegative integer");
      position.paragraphOffset = offset;
    }
    if (item.paragraphRatio !== undefined) {
      const ratio = number(item.paragraphRatio, `${path}.paragraphRatio`);
      if (ratio > 1) fail(`${path}.paragraphRatio`, "expected a number between 0 and 1");
      position.paragraphRatio = ratio;
    }
    return position;
  });
  result.statuses = map(input.statuses, "statuses", (entry, path) => {
    if (entry !== "in-progress" && entry !== "finished" && entry !== "revisit") fail(path, "unknown reading status");
    return entry;
  });
  result.queue = array(input.queue, "queue").map((entry, index) => key(entry, `queue[${index}]`));
  unique(result.queue, "queue");
  result.notes = map(input.notes, "notes", (entry, path) => string(entry, path));
  result.passages = array(input.passages, "passages").map((entry, index) => {
    const path = `passages[${index}]`;
    const item = object(entry, path);
    return {
      id: string(item.id, `${path}.id`, true), messageKey: key(item.messageKey, `${path}.messageKey`),
      text: string(item.text, `${path}.text`, true), note: string(item.note, `${path}.note`), createdAt: date(item.createdAt, `${path}.createdAt`)
    };
  });
  unique(result.passages.map((item) => item.id), "passages");
  const passages = new Map(result.passages.map((item) => [item.id, item]));
  result.collections = array(input.collections, "collections").map((entry, index) => {
    const path = `collections[${index}]`;
    const item = object(entry, path);
    const items = array(item.items, `${path}.items`).map((entry, itemIndex) => {
      const itemPath = `${path}.items[${itemIndex}]`;
      const collectionItem = object(entry, itemPath);
      const result: ReadingCollection["items"][number] = {
        id: string(collectionItem.id, `${itemPath}.id`, true), messageKey: key(collectionItem.messageKey, `${itemPath}.messageKey`)
      };
      if (collectionItem.passageId !== undefined) {
        result.passageId = string(collectionItem.passageId, `${itemPath}.passageId`, true);
        const passage = passages.get(result.passageId);
        if (!passage || passage.messageKey !== result.messageKey) fail(itemPath, "saved passage is missing or belongs to another post");
      }
      return result;
    });
    unique(items.map((entry) => entry.id), `${path}.items`);
    return { id: string(item.id, `${path}.id`, true), title: string(item.title, `${path}.title`, true), introduction: string(item.introduction, `${path}.introduction`), items };
  });
  unique(result.collections.map((item) => item.id), "collections");
  result.media = map(input.media, "media", (entry, path) => {
    const item = object(entry, path);
    const rate = number(item.rate, `${path}.rate`, 0.1);
    if (rate > 16) fail(`${path}.rate`, "playback speed is too high");
    return { time: number(item.time, `${path}.time`), rate };
  });
  return result;
}

function storageKey(chatId: number | null): string {
  return `vn-reader:reading-state:v1:${chatId ?? "unassigned"}`;
}

function storage(): Storage {
  if (typeof window === "undefined") throw new Error("Reading data cannot be saved outside the browser.");
  try { return window.localStorage; }
  catch { throw new Error("Browser storage is unavailable. Enable local storage to keep your reading data."); }
}

export function loadReadingState(chatId: number | null): ReadingState {
  let raw: string | null;
  try { raw = storage().getItem(storageKey(chatId)); }
  catch (error) { throw new Error(`Could not load your reading data: ${error instanceof Error ? error.message : "browser storage is unavailable"}`); }
  if (raw === null) return createReadingState(chatId);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Your saved reading data is damaged. Restore a reading-state backup to recover it."); }
  return validateReadingState(value, chatId);
}

export function saveReadingState(state: ReadingState): void {
  const safeState = validateReadingState(state, state.chatId);
  try { storage().setItem(storageKey(state.chatId), JSON.stringify(safeState)); }
  catch (error) {
    throw new Error(`Could not save your reading data. Export a backup before closing this page. ${error instanceof Error ? error.message : "Browser storage is unavailable or full."}`);
  }
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const result = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return result;
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

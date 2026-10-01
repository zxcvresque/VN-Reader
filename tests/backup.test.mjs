import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function moduleUrl(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: path
  }).outputText;
  for (const [specifier, replacement] of Object.entries(dependencies)) {
    compiled = compiled.replaceAll(`from "${specifier}"`, `from "${replacement}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}

const preferencesUrl = await moduleUrl("../src/lib/preferences.ts");
const readingStateUrl = await moduleUrl("../src/lib/readingState.ts");
const backupUrl = await moduleUrl("../src/lib/backup.ts", { "./preferences": preferencesUrl, "./readingState": readingStateUrl });
const { DEFAULT_PREFERENCES } = await import(preferencesUrl);
const { createReadingState } = await import(readingStateUrl);
const { createBackup, parseBackup } = await import(backupUrl);

const TIMESTAMP = "2026-09-30T09:30:00.000Z";
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const snapshot = {
    manifest: { source: { chat_id: -100 } },
    messages: [
      { message_key: "-100:1", message_id: 1, date_utc: "2026-09-29T00:00:00.000Z", thread_key: "-100:1" },
      { message_key: "-100:2", message_id: 2, date_utc: "2026-09-30T00:00:00.000Z", thread_key: "-100:1" },
      { message_key: "-100:3", message_id: 3, date_utc: null, thread_key: "-100:99" }
    ],
    threads: [{ thread_key: "-100:1" }],
    bookmarks: [
      { bookmark_id: "message:-100:2", target_type: "message", target_key: "-100:2", chat_id: -100, message_key: "-100:2", thread_key: "-100:1", tags: ["keep", "context"], updated_at_utc: TIMESTAMP },
      { bookmark_id: "thread:-100:1", target_type: "thread", target_key: "-100:1", chat_id: -100, message_key: null, thread_key: "-100:1", tags: [], updated_at_utc: TIMESTAMP }
    ],
    readOverrides: [{ message_key: "-100:1", status: "unread", updated_at_utc: TIMESTAMP }],
    readCursor: { chat_id: -100, message_key: "-100:2", message_id: 2, date_utc: "2026-09-30T00:00:00.000Z", updated_at_utc: TIMESTAMP },
    importSessions: [], directoryHandle: null
  };
  const state = createReadingState(-100);
  state.positions["-100:2"] = { offset: 190, updatedAt: TIMESTAMP, paragraphOffset: 425, paragraphRatio: 0.6 };
  state.statuses["-100:1"] = "finished";
  state.queue = ["-100:3", "-100:2"];
  state.notes["-100:1"] = "An observation";
  state.passages = [{ id: "p1", messageKey: "-100:1", text: "Remember this", note: "A passage note", createdAt: TIMESTAMP }];
  state.collections = [{ id: "c1", title: "Questions", introduction: "A path through the ideas", items: [{ id: "i1", messageKey: "-100:1", passageId: "p1" }, { id: "i2", messageKey: "-100:3" }] }];
  state.media["-100:3"] = { time: 32, rate: 1.25 };
  const preferences = clone(DEFAULT_PREFERENCES);
  preferences.theme = "editorial";
  preferences.presets = [{ id: "preset-1", name: "Evening", preferences: { ...preferences, presets: undefined, paper: "sepia", fontSize: 20 } }];
  const backup = clone(createBackup(snapshot, state, preferences));
  return { snapshot, state, preferences, backup };
}

test("all reading records, appearance choices, and presets roundtrip through exported JSON", () => {
  const { snapshot, backup } = fixture();
  assert.deepEqual(parseBackup(backup, snapshot), backup);
  assert.equal(backup.format, "vn-reader-reading-state");
  assert.equal(backup.version, 1);
  assert.ok(Number.isFinite(Date.parse(backup.exportedAt)));
});

test("null cursors and empty archive state roundtrip without manufacturing progress", () => {
  const snapshot = { manifest: null, messages: [], threads: [], bookmarks: [], readOverrides: [], readCursor: null };
  const backup = clone(createBackup(snapshot, createReadingState(null), DEFAULT_PREFERENCES));
  assert.deepEqual(parseBackup(backup, snapshot), backup);
});

test("derived message thread keys remain valid even when absent from the persisted thread index", () => {
  const { snapshot, backup } = fixture();
  backup.bookmarks.push({ bookmark_id: "thread:-100:99", target_type: "thread", target_key: "-100:99", chat_id: -100, message_key: null, thread_key: "-100:99", tags: ["quote"], updated_at_utc: TIMESTAMP });
  assert.equal(parseBackup(backup, snapshot).bookmarks.at(-1).thread_key, "-100:99");
});

test("foreign archives, unknown formats, and unsupported versions fail before restoration", () => {
  const { snapshot, backup } = fixture();
  for (const invalid of [null, [], { ...backup, format: "another-app" }, { ...backup, version: 2 }]) {
    assert.throws(() => parseBackup(invalid, snapshot), /not a reading-state backup|Unsupported/);
  }
  assert.throws(() => parseBackup({ ...backup, chatId: 200 }, snapshot), /different archive/);
  assert.throws(() => parseBackup(backup, { ...snapshot, manifest: null }), /different archive/);
});

test("missing archive posts are rejected in every personal-data category", () => {
  const { snapshot, backup } = fixture();
  const missing = "-100:404";
  const cases = [
    (state) => { state.positions[missing] = { offset: 0, updatedAt: TIMESTAMP }; },
    (state) => { state.statuses[missing] = "revisit"; },
    (state) => { state.queue.push(missing); },
    (state) => { state.notes[missing] = "A note"; },
    (state) => { state.passages.push({ id: "missing-passage", messageKey: missing, text: "Text", note: "", createdAt: TIMESTAMP }); },
    (state) => { state.collections[0].items.push({ id: "missing-item", messageKey: missing }); },
    (state) => { state.media[missing] = { time: 0, rate: 1 }; }
  ];
  for (const mutate of cases) {
    const input = clone(backup);
    mutate(input.readingState);
    assert.throws(() => parseBackup(input, snapshot), /post missing from this archive/);
  }
});

test("bookmarks must reference known posts or threads and use consistent identifiers", () => {
  const { snapshot, backup } = fixture();
  const cases = [
    [{ ...backup.bookmarks[0], chat_id: 200 }, /invalid bookmark/],
    [{ ...backup.bookmarks[0], message_key: "-100:404" }, /post missing/],
    [{ ...backup.bookmarks[1], thread_key: "-100:404" }, /thread missing/],
    [{ ...backup.bookmarks[0], target_key: "-100:3" }, /inconsistent bookmark identifiers/],
    [{ ...backup.bookmarks[0], bookmark_id: "wrong" }, /inconsistent bookmark identifiers/],
    [{ ...backup.bookmarks[0], target_type: "passage" }, /invalid bookmark/],
    [{ ...backup.bookmarks[0], tags: [123] }, /invalid bookmark/]
  ];
  for (const [bookmark, expected] of cases) assert.throws(() => parseBackup({ ...backup, bookmarks: [bookmark] }, snapshot), expected);
});

test("seen overrides must have known post keys and explicit read or unread statuses", () => {
  const { snapshot, backup } = fixture();
  assert.throws(() => parseBackup({ ...backup, readOverrides: [{ ...backup.readOverrides[0], status: "finished" }] }, snapshot), /invalid seen progress/);
  assert.throws(() => parseBackup({ ...backup, readOverrides: [{ ...backup.readOverrides[0], message_key: "-100:404" }] }, snapshot), /post missing/);
  assert.throws(() => parseBackup({ ...backup, readOverrides: {} }, snapshot), /bookmarks or progress are invalid/);
});

test("duplicate legacy records cannot overwrite one another silently on import", () => {
  const { snapshot, backup } = fixture();
  assert.throws(() => parseBackup({ ...backup, bookmarks: [...backup.bookmarks, backup.bookmarks[0]] }, snapshot), /duplicate reading records/);
  assert.throws(() => parseBackup({ ...backup, readOverrides: [...backup.readOverrides, { ...backup.readOverrides[0], status: "read" }] }, snapshot), /duplicate reading records/);
});

test("cursor identity and original archive dates must agree before restoring a place", () => {
  const { snapshot, backup } = fixture();
  for (const changed of [{ chat_id: 200 }, { message_id: 3 }, { date_utc: TIMESTAMP }]) {
    assert.throws(() => parseBackup({ ...backup, readCursor: { ...backup.readCursor, ...changed } }, snapshot), /inconsistent reading cursor/);
  }
  assert.throws(() => parseBackup({ ...backup, readCursor: { ...backup.readCursor, message_key: "-100:404" } }, snapshot), /post missing/);
  const withNullDate = { ...backup, readCursor: { chat_id: -100, message_key: "-100:3", message_id: 3, date_utc: null, updated_at_utc: TIMESTAMP } };
  assert.deepEqual(parseBackup(withNullDate, snapshot).readCursor, withNullDate.readCursor);
});

test("invalid timestamp or appearance data cannot reach the live reader", () => {
  const { snapshot, backup } = fixture();
  assert.throws(() => parseBackup({ ...backup, exportedAt: "not a date" }, snapshot), /invalid timestamp/);
  assert.throws(() => parseBackup({ ...backup, bookmarks: [{ ...backup.bookmarks[0], updated_at_utc: 123 }] }, snapshot), /invalid timestamp/);
  assert.throws(() => parseBackup({ ...backup, preferences: { ...backup.preferences, theme: "missing-theme" } }, snapshot), /Invalid theme/);
  assert.throws(() => parseBackup({ ...backup, preferences: { ...backup.preferences, readingWidth: 100_000 } }, snapshot), /Invalid readingWidth/);
  assert.throws(() => parseBackup({ ...backup, preferences: { ...backup.preferences, presets: [{ id: "p", name: "Bad", preferences: {} }] } }, snapshot), /Invalid theme/);
});

test("broken collection passage links fail validation before restore", () => {
  const { snapshot, backup } = fixture();
  const missing = clone(backup);
  missing.readingState.passages = [];
  assert.throws(() => parseBackup(missing, snapshot), /saved passage is missing/);
  const mismatch = clone(backup);
  mismatch.readingState.collections[0].items[0].messageKey = "-100:2";
  assert.throws(() => parseBackup(mismatch, snapshot), /belongs to another post/);
});

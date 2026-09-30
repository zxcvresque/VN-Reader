import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import ts from "typescript";

// Exercise the actual TypeScript module without writing generated files into the repository.
const source = await readFile(new URL("../src/lib/readingState.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  fileName: "readingState.ts"
}).outputText;
const { createReadingState, validateReadingState, saveReadingState, loadReadingState, moveItem } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const TIMESTAMP = "2026-09-30T09:30:00.000Z";
const clone = (value) => JSON.parse(JSON.stringify(value));
let storage;
let previousWindow;

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true, writable: true });
});

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
});

function fixture(chatId = -100) {
  const state = createReadingState(chatId);
  const messageKey = `${chatId}:1`;
  state.positions[messageKey] = { offset: 245.5, updatedAt: TIMESTAMP };
  state.statuses[messageKey] = "revisit";
  state.queue = [messageKey, `${chatId}:2`];
  state.notes[messageKey] = "Compare this idea with the previous post.";
  state.passages = [{ id: "passage-1", messageKey, text: "An idea worth keeping.", note: "Follow up later", createdAt: TIMESTAMP }];
  state.collections = [{ id: "collection-1", title: "Connections", introduction: "A personal reading path", items: [{ id: "item-1", messageKey, passageId: "passage-1" }, { id: "item-2", messageKey: `${chatId}:2` }] }];
  state.media[messageKey] = { time: 82.75, rate: 1.5 };
  return state;
}

test("a full reading state survives save/load, without mixing archive data", () => {
  const first = fixture(-100);
  const second = fixture(200);
  second.notes["200:1"] = "A different archive's note";
  saveReadingState(first);
  saveReadingState(second);
  assert.equal(storage.values.size, 2);
  assert.deepEqual(loadReadingState(-100), first);
  assert.deepEqual(loadReadingState(200), second);
  assert.deepEqual(loadReadingState(300), createReadingState(300));
});

test("missing state is fresh and mutable without sharing its maps or lists", () => {
  const first = loadReadingState(null);
  const second = loadReadingState(null);
  first.queue.push("-100:1");
  first.notes["-100:1"] = "Private draft";
  assert.deepEqual(second, createReadingState(null));
  assert.equal(storage.values.size, 0);
});

test("paragraph resume metadata roundtrips while older pixel-only positions remain compatible", () => {
  const state = fixture();
  state.positions["-100:1"].paragraphOffset = 1234;
  state.positions["-100:1"].paragraphRatio = 0.45;
  state.positions["-100:2"] = { offset: 12, updatedAt: TIMESTAMP };
  saveReadingState(state);
  assert.deepEqual(loadReadingState(-100).positions, state.positions);
  assert.deepEqual(validateReadingState(clone(state), -100).positions, state.positions);
  assert.equal(Object.hasOwn(loadReadingState(-100).positions["-100:2"], "paragraphOffset"), false);
  assert.equal(Object.hasOwn(loadReadingState(-100).positions["-100:2"], "paragraphRatio"), false);
});

test("paragraph resume metadata rejects noninteger offsets and ratios outside the paragraph", () => {
  const position = fixture().positions["-100:1"];
  for (const paragraphOffset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", null]) {
    assert.throws(() => validateReadingState({ ...fixture(), positions: { "-100:1": { ...position, paragraphOffset } } }, -100), /paragraphOffset/);
  }
  for (const paragraphRatio of [-0.1, 1.01, NaN, Infinity, "0.5", null]) {
    assert.throws(() => validateReadingState({ ...fixture(), positions: { "-100:1": { ...position, paragraphRatio } } }, -100), /paragraphRatio/);
  }
  for (const paragraphRatio of [0, 1]) {
    const input = { ...fixture(), positions: { "-100:1": { ...position, paragraphOffset: 0, paragraphRatio } } };
    assert.equal(validateReadingState(input, -100).positions["-100:1"].paragraphRatio, paragraphRatio);
  }
});

test("saving validates before writing and leaves the previous durable state intact on failure", () => {
  const state = fixture();
  saveReadingState(state);
  assert.throws(() => saveReadingState({ ...state, statuses: { "-100:1": "read" } }), /unknown reading status/);
  assert.deepEqual(loadReadingState(-100), state);
});

test("storage denial and quota failures reach the caller with recovery guidance", () => {
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Access denied"); } });
  assert.throws(() => loadReadingState(-100), /Could not load.*storage is unavailable/);
  assert.throws(() => saveReadingState(fixture()), /Export a backup/);
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.throws(() => saveReadingState(fixture()), /Could not save.*Export a backup.*Quota exceeded/);
});

test("damaged stored JSON fails visibly instead of discarding the reader's data", () => {
  saveReadingState(fixture());
  const key = [...storage.values.keys()][0];
  storage.values.set(key, "{ broken json");
  assert.throws(() => loadReadingState(-100), /damaged.*Restore a reading-state backup/);
  assert.equal(storage.values.get(key), "{ broken json");
});

test("backup validation returns an independent, schema-limited copy", () => {
  const original = fixture();
  original.unexpected = "Ignore unrelated backup properties";
  const validated = validateReadingState(original, -100);
  assert.equal(Object.hasOwn(validated, "unexpected"), false);
  validated.positions["-100:1"].offset = 0;
  validated.queue.push("-100:3");
  validated.passages[0].text = "Changed text";
  validated.collections[0].items[0].messageKey = "-100:3";
  assert.equal(original.positions["-100:1"].offset, 245.5);
  assert.equal(original.queue.length, 2);
  assert.equal(original.passages[0].text, "An idea worth keeping.");
  assert.equal(original.collections[0].items[0].messageKey, "-100:1");
});

test("foreign archives and malformed or foreign post identifiers are rejected", () => {
  assert.throws(() => validateReadingState(fixture(), 200), /different archive/);
  for (const key of ["200:1", "-100:abc", "__proto__", "-100:9007199254740992", "NaN:1"]) {
    const input = fixture();
    input.notes = { [key]: "A note" };
    assert.throws(() => validateReadingState(input, -100), /different archive|invalid post identifier/, key);
  }
  assert.throws(() => validateReadingState(fixture(), NaN), /invalid archive ID/);
});

test("unsupported versions, incomplete schemas, and invalid data types are rejected", () => {
  const cases = [
    [null, /expected an object/],
    [[], /expected an object/],
    [{ ...fixture(), version: 2 }, /unsupported backup version/],
    [{ version: 1, chatId: -100 }, /expected an object/],
    [{ ...fixture(), queue: {} }, /expected a list/],
    [{ ...fixture(), notes: { "-100:1": 123 } }, /expected text/],
    [{ ...fixture(), statuses: { "-100:1": "seen" } }, /unknown reading status/],
    [{ ...fixture(), collections: [{ id: "c1", title: "   ", introduction: "", items: [] }] }, /cannot be empty/]
  ];
  for (const [input, expected] of cases) assert.throws(() => validateReadingState(input, -100), expected);
});

test("invalid offsets, timestamps, media times, and playback rates cannot enter live state", () => {
  for (const offset of [-1, NaN, Infinity, "12"]) {
    assert.throws(() => validateReadingState({ ...fixture(), positions: { "-100:1": { offset, updatedAt: TIMESTAMP } } }, -100), /finite number/);
  }
  for (const updatedAt of ["yesterday", "2026-99-99T99:99:99Z", 100]) {
    assert.throws(() => validateReadingState({ ...fixture(), positions: { "-100:1": { offset: 0, updatedAt } } }, -100), /ISO timestamp|expected text/);
  }
  for (const media of [{ time: -1, rate: 1 }, { time: Infinity, rate: 1 }, { time: 1, rate: 0 }, { time: 1, rate: 17 }]) {
    assert.throws(() => validateReadingState({ ...fixture(), media: { "-100:1": media } }, -100), /finite number|playback speed is too high/);
  }
});

test("duplicates cannot produce ambiguous queue, passage, collection, or item identities", () => {
  const queue = fixture();
  queue.queue.push(queue.queue[0]);
  const passages = fixture();
  passages.passages.push({ ...passages.passages[0] });
  const collections = fixture();
  collections.collections.push({ ...collections.collections[0] });
  const items = fixture();
  items.collections[0].items.push({ ...items.collections[0].items[0] });
  for (const input of [queue, passages, collections, items]) assert.throws(() => validateReadingState(input, -100), /duplicate entries/);
});

test("collection passages must exist and belong to the same referenced post", () => {
  const missing = fixture();
  missing.passages = [];
  assert.throws(() => validateReadingState(missing, -100), /saved passage is missing/);
  const mismatched = fixture();
  mismatched.collections[0].items[0].messageKey = "-100:2";
  assert.throws(() => validateReadingState(mismatched, -100), /belongs to another post/);
  const valid = fixture();
  assert.deepEqual(validateReadingState(valid, -100).collections, valid.collections);
});

test("reordering preserves all items and never mutates the caller's list", () => {
  const first = { id: "a" };
  const second = { id: "b" };
  const third = { id: "c" };
  const input = [first, second, third];
  assert.deepEqual(moveItem(input, 0, 2), [second, third, first]);
  assert.deepEqual(moveItem(input, 2, 0), [third, first, second]);
  assert.deepEqual(moveItem(input, 1, 2), [first, third, second]);
  assert.deepEqual(input, [first, second, third]);
  assert.equal(moveItem(input, 0, 2)[2], first);
});

test("invalid or unchanged reorder requests produce a safe independent list", () => {
  const input = ["a", "b"];
  for (const [from, to] of [[-1, 0], [0, -1], [2, 0], [0, 2], [0.5, 1], [0, NaN], [0, 0]]) {
    const output = moveItem(input, from, to);
    assert.deepEqual(output, input);
    assert.notEqual(output, input);
  }
  assert.deepEqual(moveItem([], 0, 0), []);
  assert.deepEqual(moveItem(["a"], 0, 0), ["a"]);
});

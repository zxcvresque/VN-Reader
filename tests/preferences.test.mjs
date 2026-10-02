import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/preferences.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DEFAULT_PREFERENCES, PREFERENCES_KEY, THEMES, normalizePreferences, validatePreferences, applyPreferences, savePreferences, loadPreferences } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("the first visit chooses Vercel for system dark and Liquid Opal for system light, then remembers it", () => {
  for (const dark of [true, false]) {
    const storage = new Map();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    globalThis.window = { matchMedia: query => { assert.equal(query, "(prefers-color-scheme: dark)"); return { matches: dark }; } };
    try {
      const preferences = loadPreferences();
      assert.equal(preferences.theme, dark ? "vercel" : "opal");
      assert.equal(preferences.fontFamily, "sans");
      assert.equal(JSON.parse(storage.get(PREFERENCES_KEY)).theme, preferences.theme);
      window.matchMedia = () => ({ matches: !dark });
      assert.equal(loadPreferences().theme, preferences.theme);
    } finally { delete globalThis.localStorage; delete globalThis.window; }
  }
});

test("system appearance never overwrites a saved theme or an older saved preference", () => {
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const { navPosition: _position, ...older } = { ...DEFAULT_PREFERENCES, theme: "editorial" };
  globalThis.localStorage = { getItem: key => key === PREFERENCES_KEY ? JSON.stringify(older) : null };
  try {
    assert.equal(loadPreferences().theme, "editorial");
    assert.equal(loadPreferences().navPosition, "top");
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});

test("system defaults still work when storage is blocked and legacy column width is retained", () => {
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  globalThis.localStorage = { getItem: key => key === "vn-reader-reading-width" ? "96" : null, setItem: () => { throw new Error("blocked"); } };
  try {
    assert.equal(loadPreferences().theme, "vercel");
    assert.equal(loadPreferences().readingWidth, 96);
    localStorage.getItem = () => { throw new Error("blocked"); };
    assert.equal(loadPreferences().theme, "vercel");
  } finally { delete globalThis.localStorage; delete globalThis.window; }
});

test("navigation placement stays independent of every theme and persists across reloads", () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  try {
    for (const theme of THEMES) for (const navPosition of ["top", "bottom", "left", "right"]) {
      const preferences = { ...DEFAULT_PREFERENCES, theme: theme.id, navPosition };
      savePreferences(preferences);
      assert.deepEqual(loadPreferences(), preferences);
    }
  } finally { delete globalThis.localStorage; }
});

test("older reading backups and presets gain a top navigation without losing appearance", () => {
  const { navPosition: _position, ...legacy } = DEFAULT_PREFERENCES;
  const restored = validatePreferences({ ...legacy, theme: "niti", presets: [{ id: "old", name: "Old paper", preferences: { ...legacy, paper: "sepia" } }] });
  assert.equal(restored.navPosition, "top");
  assert.equal(restored.theme, "opal");
  assert.equal(restored.presets[0].preferences.navPosition, "top");
  assert.equal(restored.presets[0].preferences.paper, "sepia");
});

test("invalid explicit placements are rejected by backup validation including inside presets", () => {
  for (const navPosition of [undefined, null, "center", 1, [], {}]) {
    assert.throws(() => validatePreferences({ ...DEFAULT_PREFERENCES, navPosition }), /Invalid navPosition/);
    assert.throws(() => validatePreferences({ ...DEFAULT_PREFERENCES, presets: [{ id: "p", name: "Bad", preferences: { ...DEFAULT_PREFERENCES, navPosition } }] }), /Invalid navPosition/);
  }
  assert.equal(normalizePreferences({ navPosition: "center" }).navPosition, "top");
});

test("applying preferences updates navigation data alongside theme and typography", () => {
  const styles = new Map();
  const events = [];
  globalThis.document = { querySelector: () => null, documentElement: { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } } };
  globalThis.window = { dispatchEvent: event => events.push(event) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
  try {
    applyPreferences({ ...DEFAULT_PREFERENCES, navPosition: "right", theme: "aurora", fontSize: 22 });
    assert.equal(document.documentElement.dataset.navPosition, "right");
    assert.equal(document.documentElement.dataset.theme, "vercel");
    assert.equal(styles.get("--reader-font-size"), "22px");
    assert.equal(events[0].detail.navPosition, "right");
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.CustomEvent;
  }
});

test("removed themes migrate in backups and nested presets without discarding reading settings", () => {
 assert.deepEqual(THEMES.map(t=>t.id),["vercel","editorial","cobalt","opal"]);
 for(const [theme,replacement] of [["aurora","vercel"],["niti","opal"],["signal","vercel"]]){
 const restored=validatePreferences({...DEFAULT_PREFERENCES,theme,fontSize:21,presets:[{id:"legacy",name:"Saved setup",preferences:{...DEFAULT_PREFERENCES,theme,readingWidth:90}}]});
 assert.equal(restored.theme,replacement);assert.equal(restored.fontSize,21);assert.equal(restored.presets[0].preferences.theme,replacement);assert.equal(restored.presets[0].preferences.readingWidth,90);
 }
});

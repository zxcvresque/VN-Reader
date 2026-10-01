import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compile = (path, dependencies = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => name in dependencies ? dependencies[name] : require(name), module, module.exports);
  return module.exports;
};
const preferences = compile('../src/lib/preferences.ts');
const entry = compile('../src/lib/entry.ts');
const { default: Welcome, WELCOME_SLIDES, FeatureWalkthrough } = compile('../src/components/WelcomePage.tsx', {
  '../lib/preferences': preferences, './welcome.css': {},
  './TelegramRichText': { default: ({ text }) => React.createElement('p', null, text) }
});
function environment() {
  const original = Object.fromEntries(['window', 'document', 'localStorage', 'CustomEvent'].map(key => [key, globalThis[key]]));
  const storage = new Map(), keys = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { localStorage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, scrollTo() {} };
  globalThis.document = { body: { style: { overflow: '' } }, activeElement: null, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener: (key, fn) => keys.set(key, fn), removeEventListener: key => keys.delete(key), querySelector: () => null, querySelectorAll: () => [] };
  globalThis.CustomEvent = class {};
  return { storage, keys, restore() { for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}
const props = () => ({ theme: 'opal', messages: [], manifest: null, onThemeChange() {}, onGuest() {}, onSignIn() {} });
const findButton = (root, text) => root.root.findAllByType('button').find(button => button.children.some(child => typeof child === 'string' && child.includes(text)));
test('welcome offers guest and sign in, and every theme uses the same selector', () => {
  const env = environment(), calls = [];
  let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Welcome, { ...props(), onGuest: () => calls.push('guest'), onSignIn: () => calls.push('signin'), onThemeChange: theme => calls.push(theme) })); });
    act(() => findButton(root, 'Continue as guest').props.onClick());
    act(() => findButton(root, 'Sign in').props.onClick());
    const themes = root.root.findAllByProps({ className: 'welcome-theme' });
    assert.equal(themes.length, 7);
    for (const theme of themes) act(() => theme.props.onClick());
    assert.deepEqual(calls, ['guest', 'signin', ...preferences.THEMES.map(t => t.id)]);
    assert.equal(root.root.findAllByType('h1')[0].children.filter(t => typeof t === 'string').join(''), 'Read Vidurneeti.At your own pace.');
    assert.ok(!JSON.stringify(root.toJSON()).includes('Import archive'));
  } finally { if (root) act(() => root.unmount()); env.restore(); }
});
test('feature walkthrough supports all slides, keyboard navigation, close, and body cleanup', () => {
  const env = environment(); let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Welcome, props()), { createNodeMock: () => ({ focus() {}, querySelectorAll: () => [] }) }); });
    act(() => findButton(root, 'Learn more').props.onClick());
    assert.equal(root.root.findAllByProps({ role: 'dialog' }).length, 1);
    assert.equal(document.body.style.overflow, 'hidden');
    for (let i = 0; i < WELCOME_SLIDES.length; i++) {
      assert.equal(root.root.findByProps({ id: 'welcome-slide-title' }).children.join(''), WELCOME_SLIDES[i].title);
      if (i < WELCOME_SLIDES.length - 1) act(() => env.keys.get('keydown')({ key: 'ArrowRight', preventDefault() {} }));
    }
    act(() => env.keys.get('keydown')({ key: 'ArrowLeft', preventDefault() {} }));
    assert.equal(root.root.findByProps({ id: 'welcome-slide-title' }).children.join(''), WELCOME_SLIDES.at(-2).title);
    act(() => env.keys.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
    assert.equal(root.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.equal(document.body.style.overflow, '');
  } finally { if (root) act(() => root.unmount()); env.restore(); }
});
test('guest entry persists separately from authentication and tolerates blocked storage', () => {
  const env = environment();
  try {
    assert.equal(entry.hasEnteredAsGuest(), false); entry.rememberGuestEntry(); assert.equal(entry.hasEnteredAsGuest(), true);
    assert.deepEqual([...env.storage.values()], ['guest']);
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(entry.hasEnteredAsGuest(), false); assert.doesNotThrow(() => entry.rememberGuestEntry());
  } finally { env.restore(); }
});

async function appFixture({ cached = false, cacheFails = false, archiveFails = false, savedPosition = false } = {}) {
  const env = environment();
  const demo = compile('../src/lib/demo.ts', { './idb': {} });
  const messages = demo.DEMO_MESSAGES;
  const manifest = { source: { chat_id: messages[0].chat_id }, range: {}, counts: {} };
  const snapshot = { manifest: cached ? manifest : null, messages: cached ? messages : [], threads: [], bookmarks: [], readOverrides: [], readCursor: null, importSessions: [], directoryHandle: null };
  const idb = { loadAppSnapshot: async () => snapshot, replaceAllMessages: async () => { if (cacheFails) throw Error('storage blocked'); }, replaceAllThreads: async () => {}, saveManifest: async () => {}, saveDirectoryHandle: async () => {} };
  const archive = compile('../src/lib/archive.ts', { './idb': idb });
  const state = compile('../src/lib/readingState.ts');
  const positions = [];
  if (savedPosition) {
    const saved = state.createReadingState(messages[0].chat_id);
    saved.positions[messages[2].message_key] = { offset: 125, updatedAt: '2026-09-30T00:00:00Z' };
    state.saveReadingState(saved);
  }
  const backup = compile('../src/lib/backup.ts', { './readingState': state, './preferences': preferences });
  const api = { fetchSiteArchive: async () => { if (archiveFails) throw Error('Archive network failed'); return { manifest, messages }; } };
  const account = { user: null, config: { accountsEnabled: false, archiveEnabled: true }, configReady: true, configError: '', status: 'guest', flush() {}, refreshConfig() {}, initialize() {} };
  const component = name => ({ default: props => React.createElement('div', { 'data-component': name }, props.children) });
  const deps = { './lib/demo': demo, './lib/entry': entry, './lib/preferences': preferences, './lib/readingState': state, './lib/backup': backup, './lib/idb': idb, './lib/archive': { ...archive, getDirectoryPermission: async () => 'unsupported' }, './lib/api': api, './lib/useReaderAccount': { useReaderAccount: () => account }, './lib/media': { revokeAllMediaObjectUrls() {} }, './components/WelcomePage': { default: Welcome, FeatureWalkthrough } };
  for (const name of ['ReaderSettings', 'ReaderGuide', 'ReaderAccount', 'ReadingLibrary', 'CommandPalette', 'MediaLightbox', 'MessageCard', 'ThreadRail', 'TopBar', 'PostTimeline', 'VirtualizedMessageList']) deps[`./components/${name}`] = component(name);
  deps['./components/VirtualizedMessageList'] = { default: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ restorePosition: p => positions.push(p), scrollToIndex() {}, getPosition: () => null }), []);
    return React.createElement('div', { 'data-component': 'VirtualizedMessageList' });
  }) };
  const { default: App } = compile('../src/App.tsx', deps);
  let root;
  await act(async () => { root = Renderer.create(React.createElement(App)); });
  return { root, account, positions, async guest() { await act(async () => findButton(root, 'Continue as guest').props.onClick()); }, async rerender() { await act(async () => root.update(React.createElement(App))); }, close() { act(() => root.unmount()); env.restore(); } };
}
test('cached and hosted archives both wait for a deliberate guest choice', async () => {
  for (const cached of [false, true]) {
    const f = await appFixture({ cached });
    try {
      assert.equal(f.root.root.findAllByType(Welcome).length, 1);
      assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 0);
      await f.guest();
      assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1);
    } finally { f.close(); }
  }
});
test('a failed offline cache write never blocks reading the hosted archive', async () => {
  const f = await appFixture({ cacheFails: true });
  try { await f.guest(); assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1); }
  finally { f.close(); }
});
test('archive failures retain a retry screen after guest entry, rather than an import page', async () => {
  const f = await appFixture({ archiveFails: true });
  try {
    await f.guest();
    assert.equal(f.root.root.findAllByProps({ role: 'alert' }).length, 1);
    assert.ok(findButton(f.root, 'Try again'));
    assert.ok(!JSON.stringify(f.root.toJSON()).includes('Import archive'));
  } finally { f.close(); }
});
test('a verified sign-in enters the reader and guest mode is not silently remembered', async () => {
  const f = await appFixture();
  try {
    act(() => findButton(f.root, 'Sign in').props.onClick());
    assert.equal(f.root.root.findAllByProps({ 'data-component': 'ReaderAccount' }).length, 1);
    assert.equal(f.root.root.findAllByType(Welcome).length, 1);
    f.account.user = { id: 'verified', email: 'reader@example.test' }; await f.rerender();
    assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1);
    assert.equal(entry.hasEnteredAsGuest(), false);
  } finally { f.close(); }
});
test('guest entry restores the saved paragraph after the reader mounts', async () => {
  const f = await appFixture({ cached: true, savedPosition: true });
  try { assert.equal(f.positions.length, 0); await f.guest(); assert.equal(f.positions.length, 1); assert.equal(f.positions[0].offset, 125); }
  finally { f.close(); }
});

test('first reader entry offers a tour; opening it dismisses the invitation and help can replay the feature slides', async () => {
  const f = await appFixture();
  try {
    await f.guest();
    assert.equal(f.root.root.findAllByProps({ 'aria-label': 'Get started with VN Reader' }).length, 1);
    act(() => findButton(f.root, 'Take a quick tour').props.onClick());
    assert.equal(entry.shouldOfferTour(), false);
    assert.equal(f.root.root.findAllByProps({ 'aria-label': 'Get started with VN Reader' }).length, 0);
    const guide = f.root.root.findByProps({ 'data-component': 'ReaderGuide' });
    act(() => guide.parent.props.onLearnMore());
    assert.equal(f.root.root.findAllByType(FeatureWalkthrough).length, 1);
    act(() => findButton(f.root, 'Close').props.onClick());
    assert.equal(f.root.root.findAllByType(FeatureWalkthrough).length, 0);
  } finally { f.close(); }
});

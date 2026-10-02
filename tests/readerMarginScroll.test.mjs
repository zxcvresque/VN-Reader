import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function compile(path, deps = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => deps[name] ?? require(name), module, module.exports);
  return module.exports;
}
const { default: VirtualList, routeReaderMarginWheel: route } = compile('../src/components/VirtualizedMessageList.tsx');
const { default: Guide } = compile('../src/components/ReaderGuide.tsx', {
  '../lib/useTouchLayout': { useTouchLayout: () => false },
  '../lib/tours': { GUIDE_TOPICS: [], HELP_SECTIONS: [], THEME_GUIDE: [], TOUR_STEPS: {} }
});
function environment() {
  const keys = ['document', 'window', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const listeners = new Map();
  let modal = false;
  globalThis.document = {
    body: { style: { overflow: '' } }, activeElement: null,
    querySelector: () => modal ? {} : null,
    addEventListener: (name, callback, options) => listeners.set(name, { callback, options }),
    removeEventListener: (name, callback) => { if (listeners.get(name)?.callback === callback) listeners.delete(name); }
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 800, dispatchEvent() {} };
  globalThis.getComputedStyle = () => ({ lineHeight: '24px' });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return { listeners, setModal: value => { modal = value; }, restore() { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}
function fixture(bounds = { left: 300, right: 900, top: 150, bottom: 750, height: 600 }) {
  const env = environment();
  const node = { scrollTop: 200, scrollHeight: 5000, clientHeight: 600, getBoundingClientRect: () => bounds, querySelectorAll: () => [], scrollTo({ top }) { this.scrollTop = top; } };
  const background = { matches: () => true };
  let prevented = 0, cancelled = 0;
  const event = changes => ({ target: background, deltaY: 120, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, cancelable: true, clientX: 100, clientY: 350, preventDefault() { prevented++; }, ...changes });
  return { env, node, event, route: changes => route(event(changes), node, () => { cancelled++; }), prevented: () => prevented, cancelled: () => cancelled };
}
test('both empty margins scroll the reader, including every desktop dock layout', () => {
  // Different left/right content offsets model top, bottom, left, and right docks.
  for (const [left, right] of [[300, 900], [300, 900], [420, 1020], [180, 780]]) {
    const f = fixture({ left, right, top: 150, bottom: 750, height: 600 });
    try {
      assert.equal(f.route({ clientX: left - 30 }), true);
      assert.equal(f.node.scrollTop, 320);
      assert.equal(f.route({ clientX: right + 30, deltaY: -80 }), true);
      assert.equal(f.node.scrollTop, 240);
      assert.equal(f.prevented(), 2);
      assert.equal(f.cancelled(), 2, 'user scrolling cancels a pending saved-place jump');
    } finally { f.env.restore(); }
  }
});
test('native reader, controls, panels, overlays, and zoom gestures are not intercepted', () => {
  const f = fixture();
  try {
    for (const changes of [
      { clientX: 500 }, { clientY: 100 }, { clientY: 780 },
      { target: { matches: () => false } }, { target: null },
      { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
      { deltaX: 150 }, { deltaY: 0 }, { deltaY: NaN },
      { defaultPrevented: true }, { cancelable: false }
    ]) assert.equal(f.route(changes), false);
    f.env.setModal(true); assert.equal(f.route(), false);
    f.env.setModal(false); document.body.style.overflow = 'hidden'; assert.equal(f.route(), false);
    assert.equal(f.node.scrollTop, 200);
    assert.equal(f.prevented(), 0);
    assert.equal(f.cancelled(), 0);
  } finally { f.env.restore(); }
});
test('line and page wheels are normalized, clamped, and released at reader boundaries', () => {
  const f = fixture();
  try {
    assert.equal(f.route({ deltaMode: 1, deltaY: 3 }), true);
    assert.equal(f.node.scrollTop, 272);
    assert.equal(f.route({ deltaMode: 2, deltaY: 1 }), true);
    assert.equal(f.node.scrollTop, 872);
    assert.equal(f.route({ deltaY: 10000 }), true);
    assert.equal(f.node.scrollTop, 4400);
    assert.equal(f.route(), false);
    assert.equal(f.route({ deltaY: -10000 }), true);
    assert.equal(f.node.scrollTop, 0);
    assert.equal(f.route({ deltaY: -10 }), false);
  } finally { f.env.restore(); }
});
test('margin wheel listener follows the mounted post viewport and is removed for an empty reader and unmount', () => {
  const f = fixture();
  let root;
  const message = { message_key: '1:1', text: 'Post', entities: [], external_urls: [] };
  const props = { messages: [message], renderMessage: () => React.createElement('p', null, 'Post') };
  try {
    act(() => { root = Renderer.create(React.createElement(VirtualList, props), { createNodeMock: element => element.props.className === 'virtual-list-container' ? f.node : { getBoundingClientRect: () => ({ height: 100 }), querySelectorAll: () => [] } }); });
    const listener = f.env.listeners.get('wheel');
    assert.deepEqual(listener.options, { passive: false });
    act(() => listener.callback(f.event()));
    assert.equal(f.node.scrollTop, 320);
    act(() => root.update(React.createElement(VirtualList, { ...props, messages: [] })));
    assert.equal(f.env.listeners.has('wheel'), false);
    act(() => root.update(React.createElement(VirtualList, props)));
    assert.equal(f.env.listeners.has('wheel'), true);
    act(() => root.unmount()); root = null;
    assert.equal(f.env.listeners.has('wheel'), false);
  } finally { if (root) act(() => root.unmount()); f.env.restore(); }
});
test('Help Support opens the updated Telegram destination', () => {
  const env = environment(); let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Guide, { topic: null, onSelectTopic() {}, onClose() {}, onStepChange() {} })); });
    const link = root.root.findByProps({ className: 'guide-support' });
    assert.equal(link.props.href, 'https://t.me/vidurneetixyz');
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.rel, 'noopener noreferrer');
  } finally { if (root) act(() => root.unmount()); env.restore(); }
});

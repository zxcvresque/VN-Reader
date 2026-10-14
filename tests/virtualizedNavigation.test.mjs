import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/components/VirtualizedMessageList.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const VirtualList = module.exports.default;

function fixture({ count = 2000, height = 260, viewport = 640 } = {}) {
  const previous = Object.fromEntries(['document', 'window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  const frames = new Map(), observers = new Map(), nodes = new Map(), positions = [], visible = [], scrolls = [], rendered = new Set();
  let frameId = 0, scrollTop = 0, root;
  const heights = new Map(), paragraphs = new Map();
  const messages = Array.from({ length: count }, (_, index) => ({ message_key: `1:${index + 1}`, message_id: index + 1 }));
  const row = key => root?.root.findAll(node => node.props.className === 'virtual-row' && node.props['data-row-key'] === key)[0];
  const nodeFor = element => {
    const key = element.props['data-row-key'];
    const node = {
      dataset: { rowKey: key },
      getBoundingClientRect() {
        const top = Number.parseFloat(row(key)?.props.style.top ?? element.props.style.top) - scrollTop;
        return { top, height: heights.get(key) ?? height, bottom: top + (heights.get(key) ?? height) };
      },
      querySelectorAll() {
        return (paragraphs.get(key) ?? []).map(paragraph => ({
          dataset: { paragraphOffset: String(paragraph.offset) },
          getBoundingClientRect() {
            const top = node.getBoundingClientRect().top + paragraph.top;
            return { top, height: paragraph.height, bottom: top + paragraph.height };
          }
        }));
      }
    };
    nodes.set(key, node);
    return node;
  };
  const container = {
    clientHeight: viewport,
    get scrollHeight() { return Number.parseFloat(root?.root.findByProps({ className: 'virtual-list-spacer' }).props.style.height ?? `${count * (height + 12)}`); },
    get scrollTop() { return scrollTop; },
    set scrollTop(top) { scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); },
    querySelectorAll() { return root ? root.root.findAllByProps({ className: 'virtual-row' }).map(item => nodes.get(item.props['data-row-key'])) : []; },
    scrollTo(options) { scrolls.push(options); this.scrollTop = options.top; }
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(node) { observers.set(node, this.callback); }
    disconnect() { for (const [node, callback] of observers) if (callback === this.callback) observers.delete(node); }
  };
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const ref = React.createRef();
  act(() => {
    root = Renderer.create(React.createElement(VirtualList, {
      ref, messages, estimateHeight: height, onPositionChange: position => positions.push(position), onVisibleMessageChange: key => visible.push(key),
      renderMessage: message => { rendered.add(message.message_id); return React.createElement('p', null, message.message_key); }
    }), { createNodeMock: element => element.props.className === 'virtual-list-container' ? container : nodeFor(element) });
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
  act(flush);
  positions.length = 0;
  return {
    root, ref, container, positions, visible, scrolls, rendered, flush,
    rows: () => root.root.findAllByProps({ className: 'virtual-row' }).map(item => Number(item.props['data-row-key'].split(':')[1])),
    scrollTo(top) { act(() => { root.root.findByProps({ className: 'virtual-list-container' }).props.onWheel(); container.scrollTop = top; root.root.findByProps({ className: 'virtual-list-container' }).props.onScroll({ currentTarget: container }); flush(); }); },
    measure(key, nextHeight, nextParagraphs = []) {
      heights.set(key, nextHeight); paragraphs.set(key, nextParagraphs);
      act(() => { observers.get(nodes.get(key))?.(); flush(); });
    },
    close() { act(() => root.unmount()); Object.assign(globalThis, previous); }
  };
}

test('explicit far jumps report the reading position without waiting for a native scroll event', async () => {
  const f = fixture();
  try {
    act(() => f.ref.current.scrollToIndex(1900));
    act(f.flush);
    assert.equal(f.positions.at(-1)?.messageKey, '1:1901');
    assert.equal(f.positions.at(-1)?.offset, 0);
    const beforeSettle = f.positions.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); f.flush(); });
    assert.ok(f.positions.length > beforeSettle, 'settled navigation reports its measured position');
    assert.deepEqual(f.positions.at(-1), f.ref.current.getPosition());
  } finally { f.close(); }
});

test('far jumps retain the full feed spacer and allow earlier and later context without mounting intermediate posts', () => {
  const f = fixture();
  try {
    act(() => f.ref.current.scrollToIndex(1900));
    assert.equal(f.container.scrollHeight, 2000 * 272);
    assert.ok(f.rows().includes(1901));
    assert.ok(f.rows().length < 30);
    assert.ok([...f.rendered].every(id => id < 20 || id > 1890), 'jump does not render intervening posts or their media');
    f.scrollTo(f.container.scrollTop - 272 * 5);
    assert.equal(f.positions.at(-1)?.messageKey, '1:1896');
    assert.ok(f.rows().includes(1895));
    f.scrollTo(f.container.scrollTop + 272 * 10);
    assert.equal(f.positions.at(-1)?.messageKey, '1:1906');
    assert.ok(f.rows().includes(1907));
  } finally { f.close(); }
});

test('a latest-post jump uses browser-clamped scroll position and earlier posts remain accessible', async () => {
  const f = fixture({ count: 100, height: 120 });
  try {
    act(() => f.ref.current.scrollToIndex(99));
    act(f.flush);
    assert.equal(f.container.scrollTop, f.container.scrollHeight - f.container.clientHeight);
    assert.ok(f.rows().includes(100));
    assert.deepEqual(f.positions.at(-1), f.ref.current.getPosition());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); f.flush(); });
    f.scrollTo(f.container.scrollTop - 132 * 4);
    assert.ok(f.rows().includes(91));
    assert.equal(f.positions.at(-1)?.messageKey, '1:92');
  } finally { f.close(); }
});

test('measured height changes refine explicit jumps and paragraph restoration survives reflow', async () => {
  const f = fixture({ count: 100 });
  try {
    act(() => f.ref.current.scrollToIndex(80));
    f.measure('1:80', 600);
    act(f.flush);
    assert.equal(f.ref.current.getPosition()?.messageKey, '1:81');
    assert.equal(f.ref.current.getPosition()?.offset, 0);
    f.measure('1:81', 1000, [{ offset: 400, top: 100, height: 400 }]);
    act(() => { f.ref.current.restorePosition({ messageKey: '1:81', offset: 300, paragraphOffset: 400, paragraphRatio: 0.5 }); f.flush(); });
    assert.equal(f.ref.current.getPosition()?.offset, 300);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); f.flush(); });
    f.measure('1:81', 1300, [{ offset: 400, top: 140, height: 600 }]);
    act(f.flush);
    assert.equal(f.ref.current.getPosition()?.offset, 440);
    assert.equal(f.ref.current.getPosition()?.paragraphOffset, 400);
    assert.equal(f.ref.current.getPosition()?.paragraphRatio, 0.5);
  } finally { f.close(); }
});

test('the main visible post advances when only the previous post tail remains, preserving its exact resume anchor', () => {
  const f = fixture({ count: 100 });
  try {
    act(() => f.ref.current.scrollToIndex(80));
    f.measure('1:81', 500);
    f.measure('1:82', 700);
    const targetTop = f.container.scrollTop;
    f.scrollTo(targetTop + 430);
    assert.equal(f.positions.at(-1)?.messageKey, '1:81');
    assert.equal(f.positions.at(-1)?.offset, 430);
    assert.equal(f.visible.at(-1), '1:82');
  } finally { f.close(); }
});

test('a long post stays the main visible post while reading deep inside it', () => {
  const f = fixture({ count: 100 });
  try {
    act(() => f.ref.current.scrollToIndex(80));
    f.measure('1:81', 1800, [{ offset: 600, top: 500, height: 800 }]);
    f.scrollTo(f.container.scrollTop + 900);
    assert.equal(f.visible.at(-1), '1:81');
    assert.equal(f.positions.at(-1)?.messageKey, '1:81');
    assert.equal(f.positions.at(-1)?.paragraphOffset, 600);
    assert.equal(f.positions.at(-1)?.paragraphRatio, 0.5);
  } finally { f.close(); }
});

test('the main visible post uses the actual bottom-clamped viewport instead of the requested target', () => {
  const f = fixture({ count: 100, height: 120 });
  try {
    act(() => f.ref.current.scrollToIndex(99));
    f.measure('1:99', 400);
    act(f.flush);
    assert.equal(f.container.scrollTop, f.container.scrollHeight - f.container.clientHeight);
    assert.equal(f.positions.at(-1)?.messageKey, '1:98');
    assert.equal(f.visible.at(-1), '1:99');
    assert.ok(f.rows().includes(100));
  } finally { f.close(); }
});

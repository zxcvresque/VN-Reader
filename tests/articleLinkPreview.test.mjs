import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/ArticleLinkPreview.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const url = 'https://foreignpolicy.com/2022/10/26/iran-ukraine-russia-war-drones-missiles-military-advisors-middle-east-nuclear/';
const headline = 'Iran Is Now at War With Ukraine';
const message = { text: `😀 ${headline}\n\nA caption about the source.`, raw: { entities: [{ _: 'MessageEntityTextUrl', offset: 3, length: headline.length, url }] } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ loader = async () => ({ ok: false }), withObserver = false } = {}) {
  const module = { exports: {} }, calls = [], observers = [];
  const originalObserver = globalThis.IntersectionObserver;
  if (withObserver) globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  new Function('require', 'module', 'exports', js)(name => name === './LinkViewer' ? {
    loadPreview: value => { calls.push(value); return loader(value); }
  } : require(name), module, module.exports);
  let props = { message, url }, tree;
  act(() => { tree = Renderer.create(React.createElement(module.exports.default, props), { createNodeMock: element => element.type === 'aside' ? {} : null }); });
  return {
    tree, calls, observers, linkedTitle: module.exports.linkedArticleTitle,
    async visible() { await act(async () => observers[0].callback([{ isIntersecting: true }])); },
    async update(next) { props = { ...props, ...next }; await act(async () => tree.update(React.createElement(module.exports.default, props))); },
    dispose() { act(() => tree.unmount()); globalThis.IntersectionObserver = originalObserver; }
  };
}

test('a missing archive preview preserves the original linked headline using UTF-16 offsets', () => {
  const f = fixture();
  try {
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-title' }).children.join(''), headline);
    assert.equal(f.calls.length, 0);
    assert.equal(f.linkedTitle({ ...message, raw: { entities: [{ _: 'MessageEntityTextUrl', offset: 3, length: headline.length, url: 'https://different.example/' }] } }, url), null);
    assert.equal(f.linkedTitle({ ...message, raw: { entities: [{ _: 'MessageEntityTextUrl', offset: -2, length: 10, url }] } }, url), null);
  } finally { f.dispose(); }
});

test('only a visible fallback asks the shared hovercard cache and uses its rich metadata', async () => {
  const pending = deferred();
  const f = fixture({ withObserver: true, loader: () => pending.promise });
  try {
    assert.deepEqual(f.calls, []);
    await act(async () => f.observers[0].callback([{ isIntersecting: false }]));
    assert.deepEqual(f.calls, []);
    await f.visible();
    assert.deepEqual(f.calls, [url]);
    await act(async () => f.tree.root.findByType('aside').props.onPointerEnter());
    assert.equal(f.calls.length, 1);
    await act(async () => pending.resolve({ ok: true, title: headline, description: 'Tehran has taken its fight against the West to Europe.', siteName: 'Foreign Policy', image: 'https://images.example/iran.jpg' }));
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-site' }).children.join(''), 'Foreign Policy');
    assert.match(JSON.stringify(f.tree.toJSON()), /Tehran has taken its fight/);
    assert.equal(f.tree.root.findByType('img').props.src, 'https://images.example/iran.jpg');
    act(() => f.tree.root.findByType('img').props.onError());
    assert.equal(f.tree.root.findAllByType('img').length, 0);
    assert.equal(f.tree.root.findByType('a').props.href, url);
  } finally { f.dispose(); }
});

test('offline metadata keeps the authored headline and unsafe thumbnail URLs never render', async () => {
  const f = fixture({ loader: async () => { throw new TypeError('offline'); } });
  try {
    await act(async () => f.tree.root.findByType('aside').props.onFocusCapture());
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-title' }).children.join(''), headline);
    assert.equal(f.tree.root.findByType('a').props.href, url);
  } finally { f.dispose(); }
  const unsafe = fixture({ loader: async () => ({ ok: true, title: headline, image: 'javascript:alert(1)' }) });
  try {
    await act(async () => unsafe.tree.root.findByType('aside').props.onFocusCapture());
    assert.equal(unsafe.tree.root.findAllByType('img').length, 0);
  } finally { unsafe.dispose(); }
});

test('a cached reader version gets a reader action while its original-link action stays external', async () => {
  const f = fixture({ loader: async () => ({ ok: true, title: headline, readerVersion: true, instantView: false }) });
  try {
    await act(async () => f.tree.root.findByType('aside').props.onFocusCapture());
    const links = f.tree.root.findAllByType('a');
    assert.match(links[0].children.filter(child => typeof child === 'string').join(''), /Read saved version/);
    assert.equal(links[0].props['data-no-viewer'], undefined, 'reader action uses the existing native viewer');
    assert.match(links[1].children.filter(child => typeof child === 'string').join(''), /Open original/);
    assert.equal(links[1].props['data-no-viewer'], true);
  } finally { f.dispose(); }
});

test('a prepared same-origin IV image is accepted without allowing arbitrary relative routes', async () => {
  const image = `/api/instant-view-media/${'c'.repeat(64)}`;
  const f = fixture({ loader: async () => ({ ok: true, title: headline, image, instantView: true }) });
  try {
    await act(async () => f.tree.root.findByType('aside').props.onFocusCapture());
    assert.equal(f.tree.root.findByType('img').props.src, image);
  } finally { f.dispose(); }
  const invalid = fixture({ loader: async () => ({ ok: true, title: headline, image: '/api/instant-view-media/../../private' }) });
  try {
    await act(async () => invalid.tree.root.findByType('aside').props.onFocusCapture());
    assert.equal(invalid.tree.root.findAllByType('img').length, 0);
  } finally { invalid.dispose(); }
});

test('late metadata cannot overwrite a different article or update an unmounted preview', async () => {
  const pending = deferred(), nextUrl = 'https://example.org/other';
  const f = fixture({ withObserver: true, loader: () => pending.promise });
  try {
    await f.visible();
    await f.update({ url: nextUrl, message: { text: 'Another headline', raw: { entities: [{ _: 'MessageEntityTextUrl', offset: 0, length: 16, url: nextUrl }] } } });
    await act(async () => pending.resolve({ ok: true, title: 'Stale article', image: 'https://example.org/stale.jpg' }));
    assert.doesNotMatch(JSON.stringify(f.tree.toJSON()), /Stale article|stale.jpg/);
    assert.equal(f.tree.root.findByType('a').props.href, nextUrl);
  } finally { f.dispose(); }
  const unfinished = deferred();
  const unmounted = fixture({ loader: () => unfinished.promise });
  await act(async () => unmounted.tree.root.findByType('aside').props.onFocusCapture());
  unmounted.dispose();
  await act(async () => unfinished.resolve({ ok: true, title: 'Too late' }));
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/components/InstantViewArticle.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href));
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
const { default: Article } = await import(moduleUrl);
const plain = text => ({ _: 'TextPlain', text });
const render = (blocks, extra = {}) => renderToStaticMarkup(React.createElement(Article, { article: { title: 'Article', siteName: 'Example', url: 'https://example.org/article', blocks, rtl: false, ...extra } }));

test('article renders Telegram formatting, nested lists and tables as semantic content', () => {
  const html = render([
    { _: 'PageBlockTitle', text: plain('A full article') },
    { _: 'PageBlockParagraph', text: { _: 'TextConcat', texts: [plain('A '), { _: 'TextBold', text: plain('strong claim') }] } },
    { _: 'PageBlockOrderedList', items: [{ _: 'PageListOrderedItemText', num: '3', text: plain('Third') }] },
    { _: 'PageBlockTable', title: plain('Results'), rows: [{ cells: [{ header: true, text: plain('Value') }, { text: plain('42') }] }] },
    { _: 'PageBlockDetails', title: plain('More context'), blocks: [{ _: 'PageBlockParagraph', text: plain('Details') }] },
  ]);
  assert.match(html, /<h1>A full article<\/h1>/);
  assert.match(html, /<strong>strong claim<\/strong>/);
  assert.match(html, /<ol><li value="3">Third/);
  assert.match(html, /<th>Value<\/th><td>42<\/td>/);
  assert.match(html, /<summary>More context<\/summary>/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
});

test('article never executes Telegram HTML or unsafe link targets', () => {
  const html = render([
    { _: 'PageBlockParagraph', text: { _: 'TextUrl', url: 'javascript:alert(1)', text: plain('<script>alert(1)</script>') } },
    { _: 'PageBlockEmbed', html: '<iframe src="javascript:alert(1)">', url: 'javascript:alert(1)' },
    { _: 'PageBlockParagraph', text: { _: 'TextUrl', url: '/source', text: plain('Source') } },
  ]);
  assert.doesNotMatch(html, /javascript:|<script|<iframe/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.org\/source"/);
});

test('media retains captions and links to the original page', () => {
  const html = render([{ _: 'PageBlockPhoto', caption: { text: plain('The photograph'), credit: plain('Photo credit') } }]);
  assert.match(html, /View image on original page/);
  assert.match(html, /<figcaption>The photograph<small>Photo credit<\/small>/);
  assert.doesNotMatch(html, /<img|<iframe/);
});

test('fetched article photos use the indexed media route and preserve string Telegram IDs', () => {
  const id = '9007199254740993123', url = `/api/instant-view-media/${'a'.repeat(64)}`;
  const html = render([{ _: 'PageBlockPhoto', photo_id: id, caption: { text: plain('A source photograph'), credit: plain('Photographer') } }], {
    photos: { [id]: { url, width: 1280, height: 720 } },
  });
  assert.match(html, new RegExp(`src="${url}"`));
  assert.match(html, /alt="A source photograph"/);
  assert.match(html, /width="1280" height="720" loading="lazy" decoding="async"/);
  assert.match(html, /<figcaption>A source photograph<small>Photographer<\/small>/);
});

test('article photo URLs reject external sources and unsafe media paths', () => {
  for (const url of ['https://example.org/image.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//example.org/image.jpg', `/api/instant-view-media/${'a'.repeat(64)}?redirect=other`, '/api/instant-view-media/../admin']) {
    const html = render([{ _: 'PageBlockPhoto', photo_id: '1', caption: { text: plain('Caption'), credit: plain('Credit') } }], { photos: { '1': { url } } });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /View image on original page/);
    assert.match(html, /Caption/);
  }
});

test('broken fetched photos fall back to the original without losing the caption', () => {
  let tree;
  try {
    act(() => { tree = Renderer.create(React.createElement(Article, { article: { title: 'Article', url: 'https://example.org/article', blocks: [{ _: 'PageBlockPhoto', photo_id: '1', caption: { text: plain('Still readable') } }], photos: { '1': { url: `/api/instant-view-media/${'b'.repeat(64)}` } } } })); });
    act(() => tree.root.findByType('img').props.onError());
    assert.equal(tree.root.findAllByType('img').length, 0);
    assert.match(JSON.stringify(tree.toJSON()), /View image on original page/);
    assert.match(JSON.stringify(tree.toJSON()), /Still readable/);
  } finally { if (tree) act(() => tree.unmount()); }
});

test('inline article images use the same indexed photo cache', () => {
  const html = render([{ _: 'PageBlockParagraph', text: { _: 'TextImage', document_id: '1', w: 24, h: 24 } }], { photos: { '1': { url: `/api/instant-view-media/${'c'.repeat(64)}` } } });
  assert.match(html, /class="iv-inline-photo"/);
  assert.match(html, /width="24" height="24"/);
});

// Load the viewer's public cache readers without mounting browser event handlers.
const viewerSource = await readFile(new URL('../src/components/LinkViewer.tsx', import.meta.url), 'utf8');
const viewerOutput = ts.transpileModule(viewerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href))
  .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)
  .replaceAll('from "react-dom"', `from ${JSON.stringify(pathToFileURL(require.resolve('react-dom')).href)}`)
  .replaceAll('from "@radix-ui/react-icons"', `from ${JSON.stringify(pathToFileURL(require.resolve('@radix-ui/react-icons')).href)}`)
  .replaceAll('from "./InstantViewArticle"', `from ${JSON.stringify(moduleUrl)}`);
const { loadPreview, loadInstantView, loadReaderVersion, loadSavedArticle } = await import(`data:text/javascript;base64,${Buffer.from(viewerOutput).toString('base64')}`);

test('a cached article serves the viewer and hovercard without fetching the publisher', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ status: 'ready', article: { title: 'Cached article', siteName: 'Example', url: 'https://example.org/cached', blocks: [{ _: 'PageBlockParagraph', text: plain('Article body') }] } }) };
  };
  try {
    const [preview, article] = await Promise.all([loadPreview('https://example.org/cached'), loadInstantView('https://example.org/cached')]);
    assert.equal(preview.title, 'Cached article');
    assert.equal(article.title, 'Cached article');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^\/api\/instant-view\?/);
    assert.match(calls[1], /^\/api\/reader-version\?/);
  } finally { globalThis.fetch = previous; }
});

test('an unavailable IV keeps the existing preview fallback', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => url.startsWith('/api/instant-view') || url.startsWith('/api/reader-version') ? { status: 'unavailable', article: null } : { title: 'Existing preview', url: 'https://example.org/fallback' } };
  };
  try {
    const preview = await loadPreview('https://example.org/fallback');
    assert.equal(preview.title, 'Existing preview');
    assert.equal(calls.length, 3);
    assert.match(calls[1], /^\/api\/reader-version\?/);
    assert.match(calls[2], /^\/api\/link-preview\?/);
  } finally { globalThis.fetch = previous; }
});

test('a prepared reader version loads from the shared cache and never requests extraction', async () => {
  const previous = globalThis.fetch, calls = [];
  const url = 'https://example.org/saved-reader';
  const article = { title: 'Saved readable article', url, blocks: [{ _: 'PageBlockParagraph', text: plain('Prepared in the background.') }] };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET' });
    return { ok: true, json: async () => path.startsWith('/api/instant-view') ? { status: 'unavailable', source: 'telegram', article: null } : { status: 'ready', source: 'reader', article } };
  };
  try {
    const [preview, saved] = await Promise.all([loadPreview(url), loadSavedArticle(url)]);
    assert.equal(saved.source, 'reader');
    assert.equal(saved.article.title, article.title);
    assert.equal(preview.readerVersion, true);
    assert.equal(preview.instantView, false);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'GET']);
    assert.equal(calls.length, 2);
    assert.match(calls[1].path, /^\/api\/reader-version\?/);
  } finally { globalThis.fetch = previous; }
});

test('metadata-only or empty cache entries never count as an Instant View or reader article', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ready', source: 'reader', article: { url: 'https://example.org/empty', title: 'Only metadata', blocks: [] } }) });
  try {
    assert.equal(await loadInstantView('https://example.org/empty-iv'), null);
    assert.equal(await loadReaderVersion('https://example.org/empty-reader'), null);
  } finally { globalThis.fetch = previous; }
});

test('saved previews prefer the cached cover image and subtitle without requesting the publisher', async () => {
  const previous = globalThis.fetch, calls = [];
  const cover = `/api/instant-view-media/${'a'.repeat(64)}`;
  const other = `/api/instant-view-media/${'b'.repeat(64)}`;
  const article = {
    url: 'https://example.org/cached-cover', title: 'A saved article',
    blocks: [{ _: 'PageBlockCover', cover: { _: 'PageBlockPhoto', photo_id: '9007199254740993' } },
      { _: 'PageBlockSubtitle', text: { _: 'TextConcat', texts: [plain('A readable '), { _: 'TextBold', text: plain('description.') }] } }],
    photos: { first: { url: other }, '9007199254740993': { url: cover }, unsafe: { url: 'https://remote.example/image.jpg' } },
  };
  globalThis.fetch = async path => {
    calls.push(path);
    return { ok: true, json: async () => path.startsWith('/api/instant-view') ? { status: 'ready', source: 'telegram', article } : { status: 'missing', article: null } };
  };
  try {
    const preview = await loadPreview(article.url);
    assert.equal(preview.image, cover);
    assert.equal(preview.description, 'A readable description.');
    assert.equal(preview.instantView, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(path => !path.startsWith('/api/link-preview')));
  } finally { globalThis.fetch = previous; }
});

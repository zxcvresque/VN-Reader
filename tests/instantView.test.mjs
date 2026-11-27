import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/components/InstantViewArticle.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href));
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
const { default: Article } = await import(moduleUrl);
const plain = text => ({ _: 'TextPlain', text });
const render = blocks => renderToStaticMarkup(React.createElement(Article, { article: { title: 'Article', siteName: 'Example', url: 'https://example.org/article', blocks, rtl: false } }));

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

// Load the viewer's public cache readers without mounting browser event handlers.
const viewerSource = await readFile(new URL('../src/components/LinkViewer.tsx', import.meta.url), 'utf8');
const viewerOutput = ts.transpileModule(viewerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href))
  .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)
  .replaceAll('from "react-dom"', `from ${JSON.stringify(pathToFileURL(require.resolve('react-dom')).href)}`)
  .replaceAll('from "@radix-ui/react-icons"', `from ${JSON.stringify(pathToFileURL(require.resolve('@radix-ui/react-icons')).href)}`)
  .replaceAll('from "./InstantViewArticle"', `from ${JSON.stringify(moduleUrl)}`);
const { loadPreview, loadInstantView } = await import(`data:text/javascript;base64,${Buffer.from(viewerOutput).toString('base64')}`);

test('a cached article serves the viewer and hovercard without fetching the publisher', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ status: 'ready', article: { title: 'Cached article', siteName: 'Example', url: 'https://example.org/cached', blocks: [] } }) };
  };
  try {
    const [preview, article] = await Promise.all([loadPreview('https://example.org/cached'), loadInstantView('https://example.org/cached')]);
    assert.equal(preview.title, 'Cached article');
    assert.equal(article.title, 'Cached article');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\/api\/instant-view\?/);
  } finally { globalThis.fetch = previous; }
});

test('an unavailable IV keeps the existing preview fallback', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => url.startsWith('/api/instant-view') ? { status: 'unavailable', article: null } : { title: 'Existing preview', url: 'https://example.org/fallback' } };
  };
  try {
    const preview = await loadPreview('https://example.org/fallback');
    assert.equal(preview.title, 'Existing preview');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^\/api\/link-preview\?/);
  } finally { globalThis.fetch = previous; }
});

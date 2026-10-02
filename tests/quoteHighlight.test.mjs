import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
async function compile(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies[name] ?? require(name), module, module.exports);
  return module.exports;
}
const model = await compile('../src/lib/quoteHighlight.ts');
const richText = await compile('../src/components/TelegramRichText.tsx');
const { default: Panel } = await compile('../src/components/QuotedSourcePanel.tsx', { '../lib/quoteHighlight': model, './TelegramRichText': richText });
const { resolveQuoteRange } = model;
const request = (offset, text, length = text?.length ?? 0) => ({ offset, length, fallbackText: text });

test('quote offsets count UTF-16 and select precisely one repeated occurrence', () => {
  const text = '😀 Quoted words, then Quoted words.';
  const quote = 'Quoted words';
  const offset = text.lastIndexOf(quote);
  assert.deepEqual(resolveQuoteRange(text, request(offset, quote)), { offset, length: quote.length });
  const html = renderToStaticMarkup(React.createElement(richText.default, { text, highlightRange: resolveQuoteRange(text, request(offset, quote)) }));
  assert.equal((html.match(/tg-quote-highlight/g) ?? []).length, 1);
  assert.match(html, /<mark class="tg-quote-highlight">Quoted words<\/mark>/);
  assert.ok(html.indexOf('😀 Quoted words') < html.indexOf('<mark'));
});

test('stale offsets recover exact quoted text without highlighting unrelated content', () => {
  const text = 'Prefix. Actual quote. Another Actual quote.';
  assert.deepEqual(resolveQuoteRange(text, request(29, 'Actual quote')), { offset: 30, length: 12 });
  assert.equal(resolveQuoteRange(text, request(0, 'Missing quote')), null);
  assert.equal(resolveQuoteRange(text, request(999, null, 5)), null);
  assert.equal(resolveQuoteRange(text, request(0.5, null, 5)), null);
  assert.deepEqual(resolveQuoteRange(text, request(8, null, 12)), { offset: 8, length: 12 });
});

test('quote length follows UTF-16 text even when archive count uses Unicode code points', () => {
  const text = 'Before 😀 quoted. After';
  const quote = '😀 quoted';
  assert.deepEqual(resolveQuoteRange(text, request(7, quote, [...quote].length)), { offset: 7, length: quote.length });
});

test('quoted source keeps rich formatting, paragraph boundaries, and full link targets', () => {
  const text = '😀 Before\n\nA bold https://example.com/quoted passage. End.';
  const quote = 'bold https://example.com/quoted passage';
  const offset = text.indexOf(quote);
  let tree;
  act(() => { tree = Renderer.create(React.createElement(Panel, {
    source: { message_key: 'chat:7', message_id: 7, text, raw: { entities: [{ _: 'MessageEntityBold', offset, length: quote.length }] } },
    origin: { message_key: 'chat:8', message_id: 8, quote_text: quote, quote_text_length: quote.length, quote_offset_utf16: offset },
    onClose() {}, onGoToPost() {}, onReadAround() {}
  })); });
  try {
    assert.equal(tree.root.findAllByProps({ 'aria-label': 'Quoted source preview' }).length, 1);
    assert.ok(tree.root.findAllByType('mark').length > 0);
    assert.ok(tree.root.findAllByType('strong').length > 0);
    assert.equal(tree.root.findByType('a').props.href, 'https://example.com/quoted');
    assert.equal(tree.root.findAllByProps({ 'data-paragraph-offset': 11 }).length, 1);
  } finally { act(() => tree.unmount()); }
});

test('Go to post closes the preview before navigating to its exact source and preserves the highlight', () => {
  const calls = [];
  const text = 'Before highlighted passage after.';
  const quote = 'highlighted passage';
  const source = { message_key: 'chat:7', message_id: 7, text };
  const origin = { message_key: 'chat:8', message_id: 8, quote_text: quote, quote_text_length: quote.length, quote_offset_utf16: text.indexOf(quote) };
  const props = { source, origin, onClose: () => calls.push('close'), onGoToPost: (key, highlight) => calls.push({ key, highlight }), onReadAround: key => calls.push({ around: key }) };
  const panel = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    querySelector: selector => ({ getBoundingClientRect: () => selector === 'header' ? ({ bottom: 180 }) : ({ top: 800, bottom: 840 }) })
  };
  let tree;
  act(() => { tree = Renderer.create(React.createElement(Panel, props), { createNodeMock: node => node.type === 'aside' ? panel : null }); });
  try {
    assert.equal(panel.scrollTop, 600, 'scrolls the quoted passage below the sticky actions');
    const marks = () => tree.root.findAllByProps({ className: 'tg-quote-highlight' });
    assert.equal(marks().length, 1);
    act(() => tree.update(React.createElement(Panel, props)));
    assert.equal(marks().length, 1, 'highlight is not a transient render effect');
    const go = tree.root.findAllByType('button').find(button => button.props.className === 'reader-source-go');
    act(() => go.props.onClick());
    assert.deepEqual(calls, ['close', { key: 'chat:7', highlight: request(text.indexOf(quote), quote) }]);
  } finally { act(() => tree.unmount()); }
});

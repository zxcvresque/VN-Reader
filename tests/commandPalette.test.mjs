import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const searchSource = readFileSync(new URL('../src/lib/messageSearch.ts', import.meta.url), 'utf8');
const searchJs = ts.transpileModule(searchSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const searchModule = { exports: {} };
new Function('require', 'module', 'exports', searchJs)(require, searchModule, searchModule.exports);
const Command = ({ children }) => React.createElement('div', null, children);
Object.assign(Command, { Input: 'input', List: 'div', Empty: 'div', Group: 'section', Item: 'button' });
const source = readFileSync(new URL('../src/components/CommandPalette.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', js)(name => name === 'cmdk' ? { Command } : name === '../lib/messageSearch' ? searchModule.exports : require(name), module, module.exports);
const Palette = module.exports.default;

test('commands retain reader navigation without local archive management actions', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let root;
  const selected = [];
  const noop = () => {};
  try {
    act(() => { root = Renderer.create(React.createElement(Palette, {
      open: true, messages: [], threads: [], bookmarks: [], isMessageRead: () => false,
      isMessageBookmarked: () => false, isInQuoteThread: () => false,
      onClose: noop, onFromStart: () => selected.push('start'), onResume: noop,
      onLatest: noop, onRandom: noop, onJumpToFirstUnread: noop,
      onJumpToMessage: noop, onJumpToThread: noop, onJumpToMessageId: noop,
      onJumpToDate: noop, onJumpToThreadId: noop, onSetView: view => selected.push(view)
    })); });
    const items = root.root.findAllByType('button');
    assert.ok(!items.some(item => String(item.props.value).startsWith('archive-')));
    assert.ok(!root.root.findAllByType('section').some(group => group.props.heading === 'Archive'));
    act(() => items.find(item => item.props.value === 'from-start').props.onSelect());
    assert.deepEqual(selected, ['start']);
    assert.ok(items.some(item => item.props.value === 'view-progress'));
  } finally {
    if (root) act(() => root.unmount());
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('hash post IDs match exactly and still combine with palette filters', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const message = (id, text, kind = null) => ({ message_key: `chat:${id}`, message_id: id, text, search_text: text.toLowerCase(), media_present: !!kind, media_kind: kind, date_utc: '2024-01-01T12:00:00Z' });
  const selected = [];
  const noop = () => {};
  let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Palette, {
      open: true, messages: [message(7, 'Condition within China', 'photo'), message(70, 'See #7 about China', 'photo'), message(8, 'Reference #7')], threads: [], bookmarks: [],
      isMessageRead: m => m.message_id === 7, isMessageBookmarked: () => false, isInQuoteThread: () => false,
      onClose: noop, onFromStart: noop, onResume: noop, onLatest: noop, onRandom: noop, onJumpToFirstUnread: noop,
      onJumpToMessage: key => selected.push(key), onJumpToThread: noop, onJumpToMessageId: noop, onJumpToDate: noop, onJumpToThreadId: noop, onSetView: noop
    })); });
    const search = value => act(() => root.root.findByType('input').props.onValueChange(value));
    const hits = () => root.root.findAllByType('button').filter(item => String(item.props.value).startsWith('msg-'));
    search(' #7 ');
    assert.equal(hits().length, 1);
    assert.ok(!JSON.stringify(root.toJSON()).includes('No matches.'), 'a forced post result must not show the palette empty state');
    act(() => hits()[0].props.onSelect());
    assert.deepEqual(selected, ['chat:7']);
    search('#7 media:photo read:');
    assert.equal(hits().length, 1);
    search('#7 media:video');
    assert.equal(hits().length, 0);
    search('#7 unread:');
    assert.equal(hits().length, 0);
    search('#9999');
    assert.equal(hits().length, 0);
    search('China media:photo');
    assert.equal(hits().length, 2, 'ordinary phrase searches keep their existing filters');
  } finally {
    if (root) act(() => root.unmount());
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('post ID matching does not match number prefixes or references in other posts', () => {
  const { matchesMessageSearch } = searchModule.exports;
  const messages = [7, 70, 8].map(message_id => ({ message_id, search_text: 'a passage about #7 and china' }));
  assert.deepEqual(messages.filter(message => matchesMessageSearch(message, '#7')).map(message => message.message_id), [7]);
  assert.deepEqual(messages.filter(message => matchesMessageSearch(message, ' #007 ')).map(message => message.message_id), [7]);
  assert.equal(matchesMessageSearch(messages[0], '#9007199254740993'), false);
  assert.equal(matchesMessageSearch(messages[0], ' CHINA '), true);
  assert.equal(matchesMessageSearch(messages[0], 'passage about #7'), true, 'a hashtag inside a phrase remains an ordinary text search');
  assert.equal(matchesMessageSearch(messages[0], '#7abc'), false);
  assert.equal(matchesMessageSearch(messages[0], ''), true);
});

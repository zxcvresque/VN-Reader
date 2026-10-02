import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/MessageCard.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
const quoteSource = readFileSync(new URL('../src/lib/quoteHighlight.ts', import.meta.url), 'utf8');
const quoteJs = ts.transpileModule(quoteSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const quoteModule = { exports: {} };
new Function('require', 'module', 'exports', quoteJs)(require, quoteModule, quoteModule.exports);
const dependencies = {
  '../lib/quoteHighlight': quoteModule.exports,
  './CustomSelect': { default: () => null },
  '../lib/media': { getMediaObjectUrl: async () => '' },
  './TelegramRichText': { default: props => React.createElement('p', { className: props.className }, props.text), extractMessageEntities: () => [] }
};
new Function('require', 'module', 'exports', js)(name => dependencies[name] ?? require(name), module, module.exports);

test('Telegram edit metadata adds no reader label and original post text stays intact', () => {
  const noop = () => {};
  const message = {
    message_id: 7, message_key: 'chat:7', date_utc: '2022-07-13T18:55:00Z', edit_date_utc: '2022-07-14T18:55:00Z',
    post_author: null, text: 'Edited is part of the original post text.', external_urls: [], media_present: false,
    media_path: null, thread_root_id: 7, thread_key: 'chat:7', reply_to_msg_id: null, quote_text: null
  };
  let tree;
  try {
    act(() => { tree = Renderer.create(React.createElement(module.exports.default, {
      message, bookmark: null, directoryHandle: null, hasManualReadOverride: false, isRead: false, threadMessageCount: 1,
      onClearReadOverride: noop, onMarkRead: noop, onMarkReadTillHere: noop, onMarkUnread: noop,
      onOpenThread: noop, onSaveBookmarkTags: noop, onToggleBookmark: noop
    })); });
    assert.equal(tree.root.findByProps({ className: 'reader-message-kicker' }).children.join('').trim(), '#7');
    assert.equal(tree.root.findAllByType('p').find(node => node.props.className === 'reader-message-text').children.join(''), message.text);
    assert.notEqual(tree.root.findByType('h3').children.join(''), 'Unknown time');
  } finally {
    if (tree) act(() => tree.unmount());
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const Command = ({ children }) => React.createElement('div', null, children);
Object.assign(Command, { Input: 'input', List: 'div', Empty: 'div', Group: 'section', Item: 'button' });
const source = readFileSync(new URL('../src/components/CommandPalette.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', js)(name => name === 'cmdk' ? { Command } : require(name), module, module.exports);
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

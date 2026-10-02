import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const js = ts.transpileModule(readFileSync(new URL('../src/components/CustomSelect.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', js)(name => name === 'react-dom' ? { createPortal: content => content } : require(name), componentModule, componentModule.exports);
const CustomSelect = componentModule.exports.default;
function fixture(disabled = false) {
  const originals = { document: globalThis.document, window: globalThis.window };
  const listeners = new Map(); const changes = []; let focused = false;
  const trigger = { focus: () => { focused = true; }, contains: target => target === trigger, getBoundingClientRect: () => ({ left: 280, width: 140, top: 450, bottom: 494 }) };
  const panel = { focus() {}, contains: target => target === panel, querySelector: () => ({ scrollIntoView() {} }) };
  globalThis.document = { body: {}, addEventListener: (key, handler) => listeners.set(key, handler), removeEventListener: key => listeners.delete(key) };
  globalThis.window = { innerWidth: 390, innerHeight: 540, addEventListener() {}, removeEventListener() {} };
  let root;
  act(() => { root = Renderer.create(React.createElement(CustomSelect, { value: 'a', disabled, 'aria-label': 'Test selection', onChange: event => changes.push(event.target.value) }, [React.createElement('option', { key: 'a', value: 'a' }, 'Alpha'), React.createElement('option', { key: 'b', value: 'b', disabled: true }, 'Beta'), React.createElement('option', { key: 'c', value: 'c' }, 'Charlie')]), { createNodeMock: element => element.type === 'button' ? trigger : element.props.role === 'listbox' ? panel : null }); });
  const open = () => act(() => root.root.findByType('button').props.onClick());
  const key = key => act(() => root.root.findByProps({ role: 'listbox' }).props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} }));
  return { root, open, key, changes, listeners, focused: () => focused, restore() { act(() => root.unmount()); Object.assign(globalThis, originals); } };
}
test('dropdown stays inside mobile viewport and keyboard skips disabled choices', () => {
  const env = fixture();
  try {
    env.open();
    const menu = env.root.root.findByProps({ role: 'listbox' });
    assert.ok(menu.props.style.left >= 16);
    assert.ok(menu.props.style.left + menu.props.style.width <= 374);
    assert.ok(menu.props.style.top >= 16);
    env.key('ArrowDown'); env.key('Enter');
    assert.deepEqual(env.changes, ['c']);
    assert.equal(env.root.root.findAllByProps({ role: 'listbox' }).length, 0);
    assert.equal(env.focused(), true);
  } finally { env.restore(); }
});
test('dropdown supports typeahead, Home/End, Escape and outside dismissal', () => {
  const env = fixture();
  try {
    env.open(); env.key('c'); env.key('Enter');
    assert.deepEqual(env.changes, ['c']);
    env.open(); env.key('End'); env.key('Home'); env.key('Enter');
    assert.deepEqual(env.changes, ['c', 'a']);
    env.open(); env.key('Escape');
    assert.equal(env.root.root.findAllByProps({ role: 'listbox' }).length, 0);
    env.open(); act(() => env.listeners.get('pointerdown')({ target: {} }));
    assert.equal(env.root.root.findAllByProps({ role: 'listbox' }).length, 0);
    assert.equal(env.listeners.size, 0);
  } finally { env.restore(); }
});
test('disabled dropdown cannot open', () => {
  const env = fixture(true);
  try { env.open(); assert.equal(env.root.root.findAllByProps({ role: 'listbox' }).length, 0); } finally { env.restore(); }
});

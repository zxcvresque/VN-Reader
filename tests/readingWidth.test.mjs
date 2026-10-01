import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/ReadingWidth.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', js)(name => name === 'react-dom' ? { createPortal: content => content } : require(name), componentModule, componentModule.exports);
const ReadingWidth = componentModule.exports.default;

function fixture(value = 76) {
  const originals = { document: globalThis.document, window: globalThis.window };
  const listeners = new Map(); const changes = []; let focused = false;
  const trigger = { focus: () => { focused = true; }, getBoundingClientRect: () => ({ right: 720, bottom: 100 }) };
  const details = { open: true, contains: target => target === trigger, querySelector: () => trigger };
  const panel = { contains: target => target === panel, getBoundingClientRect: () => ({ height: 240 }) };
  globalThis.document = { body: {}, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  globalThis.window = { innerWidth: 1000, innerHeight: 800, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  let root;
  const onChange = next => changes.push(next);
  act(() => { root = Renderer.create(React.createElement(ReadingWidth, { value, onChange }), { createNodeMock: element => element.type === 'details' ? details : element.props.id === 'reading-width-popup' ? panel : null }); });
  act(() => root.root.findByType('details').props.onToggle({ currentTarget: details }));
  return { root, changes, listeners, details, panel, isFocused: () => focused, update: next => act(() => root.update(React.createElement(ReadingWidth, { value: next, onChange }))), restore: () => { act(() => root.unmount()); Object.assign(globalThis, originals); } };
}

test('reading width presets and slider expose the full persisted preference range', () => {
  const env = fixture(); const { root, changes } = env;
  try {
    const buttons = root.root.findAllByType('button');
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [false, true, false]);
    for (const button of buttons) act(() => button.props.onClick());
    const range = root.root.findByProps({ type: 'range' });
    assert.deepEqual([range.props.min, range.props.max, range.props.step], ['40', '120', '2']);
    act(() => range.props.onChange({ target: { value: '88' } }));
    assert.deepEqual(changes, [60, 76, 100, 88]);
    env.update(100);
    assert.equal(root.root.findAllByType('button')[2].props['aria-pressed'], true);
    assert.equal(root.root.findByType('output').children.join(''), 'Wide');
  } finally { env.restore(); }
});

test('width popover closes on Escape, restores trigger focus, and cleans up listeners', () => {
  const env = fixture(); const { listeners, details } = env;
  try {
    assert.ok(listeners.has('keydown'));
    act(() => listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
    assert.equal(details.open, false);
    assert.equal(env.isFocused(), true);
    assert.equal(listeners.size, 0);
  } finally { env.restore(); }
});

test('pointer drag commits once on release while popup coordinates remain stable', () => {
  const env = fixture(); const { root, changes } = env;
  try {
    const popup = () => root.root.findByProps({ id: 'reading-width-popup' });
    const originalPosition = { ...popup().props.style };
    const slider = () => root.root.findByProps({ type: 'range' });
    act(() => slider().props.onPointerDown({ pointerId: 1, currentTarget: { setPointerCapture() {} } }));
    for (const value of ['80', '92', '108']) act(() => slider().props.onChange({ target: { value } }));
    assert.deepEqual(changes, []);
    assert.equal(slider().props.value, 108);
    act(() => slider().props.onPointerUp());
    act(() => slider().props.onLostPointerCapture());
    assert.deepEqual(changes, [108]);
    env.update(108);
    assert.deepEqual(popup().props.style, originalPosition);
    act(() => env.listeners.get('pointerdown')({ target: env.panel }));
    assert.equal(env.details.open, true);
    act(() => slider().props.onPointerDown({ pointerId: 2, currentTarget: { setPointerCapture() {} } }));
    act(() => slider().props.onChange({ target: { value: '44' } }));
    act(() => slider().props.onPointerCancel());
    act(() => slider().props.onLostPointerCapture());
    assert.equal(slider().props.value, 108);
    assert.deepEqual(changes, [108]);
    window.innerWidth = 300; window.innerHeight = 260;
    act(() => env.listeners.get('resize')());
    assert.equal(popup().props.style.width, 276);
    assert.equal(popup().props.style.left, 12);
    assert.equal(popup().props.style.top, 12);
  } finally { env.restore(); }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/admin/InstantViewHistory.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const plain = value => JSON.stringify(value.toJSON());
const record = { id: 1, url: 'https://en.m.wikipedia.org/wiki/Chenab_Rail_Bridge', status: 'ready', checkedAt: 1795797180, nextAttempt: 1798389180, attempts: 1, error: null };
const pageData = (page = 1, items = [record]) => ({ items, page, pageSize: 20, total: 43, totalPages: 3 });

async function fixture(loader = () => pageData()) {
  const calls = [], module = { exports: {} };
  const dependencies = {
    '../forms/api': { call: async path => { calls.push(path); return loader(new URL(path, 'https://reader.test')); } },
    './ui': { number: value => value.toLocaleString('en-US') },
  };
  new Function('require', 'module', 'exports', output)(name => dependencies[name] ?? require(name), module, module.exports);
  let tree;
  await act(async () => { tree = Renderer.create(React.createElement(module.exports.default)); });
  const button = label => tree.root.findAllByType('button').find(item => item.props['aria-label'] === label);
  return { tree, calls, button, dispose: () => act(() => tree.unmount()) };
}

test('history uses readable article labels, semantic statuses and accessible paging', async () => {
  const f = await fixture();
  try {
    assert.match(plain(f.tree), /Chenab Rail Bridge/);
    assert.match(plain(f.tree), /en.m.wikipedia.org/);
    assert.match(plain(f.tree), /Cached/);
    assert.equal(f.tree.root.findByProps({ role: 'status' }).children.join(''), '1–20 of 43 checks');
    assert.equal(f.button('Previous history page').props.disabled, true);
    assert.equal(f.button('Next history page').props.disabled, false);
    assert.equal(f.tree.root.findByType('a').props.href, record.url);
    assert.equal(f.tree.root.findByType('table').findAllByType('th').every(th => th.props.scope === 'col'), true);
  } finally { f.dispose(); }
});

test('pagination and result filters query the full backend and reset to the first page', async () => {
  const f = await fixture(url => pageData(Number(url.searchParams.get('page'))));
  try {
    await act(async () => f.button('Next history page').props.onClick());
    assert.equal(new URL(f.calls.at(-1), 'https://reader.test').searchParams.get('page'), '2');
    await act(async () => f.tree.root.findByType('select').props.onChange({ target: { value: 'error' } }));
    const query = new URL(f.calls.at(-1), 'https://reader.test').searchParams;
    assert.equal(query.get('page'), '1');
    assert.equal(query.get('status'), 'error');
    assert.equal(query.get('pageSize'), '20');
  } finally { f.dispose(); }
});

test('search is debounced, searches all history and preserves rows while loading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const f = await fixture(url => url.searchParams.get('query') ? new Promise(done => { resolve = done; }) : pageData());
  try {
    await act(async () => f.tree.root.findByType('input').props.onChange({ target: { value: 'Chenab Rail Bridge' } }));
    assert.equal(f.calls.length, 1);
    await act(async () => t.mock.timers.tick(300));
    assert.equal(new URL(f.calls.at(-1), 'https://reader.test').searchParams.get('query'), 'Chenab Rail Bridge');
    assert.match(plain(f.tree), /Updating results/);
    assert.equal(f.tree.root.findByProps({ className: 'iv-history-scroll' }).props['aria-busy'], true);
    assert.match(plain(f.tree), /Chenab Rail Bridge/);
    await act(async () => resolve({ ...pageData(), total: 1, totalPages: 1 }));
    assert.equal(f.tree.root.findByProps({ className: 'iv-history-scroll' }).props['aria-busy'], false);
  } finally { f.dispose(); }
});

test('legacy rows disclose history limits and empty searches provide recovery', async () => {
  const f = await fixture(url => url.searchParams.get('status') === 'error'
    ? { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
    : pageData(1, [{ ...record, legacy: 1 }]));
  try {
    assert.match(plain(f.tree), /Older entries show the last result saved before full history began/);
    await act(async () => f.tree.root.findByType('select').props.onChange({ target: { value: 'error' } }));
    assert.match(plain(f.tree), /No matching checks/);
    const clear = f.tree.root.findAllByType('button').find(button => button.children.join('') === 'Clear filters');
    await act(async () => clear.props.onClick());
    assert.equal(new URL(f.calls.at(-1), 'https://reader.test').searchParams.get('status'), 'all');
  } finally { f.dispose(); }
});

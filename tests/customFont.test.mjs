import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function fixture() {
  let saved; let failSave = false; let releases = [];
  const registered = new Set(); const css = new Map();
  const db = {
    close() {}, createObjectStore() {},
    transaction() {
      const tx = { objectStore: () => ({
        get() { const request = {}; queueMicrotask(() => { request.result = saved; request.onsuccess(); }); return request; },
        put(value) { queueMicrotask(() => { if (failSave) tx.onabort(); else { saved = value; tx.oncomplete(); } }); },
        delete() { queueMicrotask(() => { if (failSave) tx.onabort(); else { saved = undefined; tx.oncomplete(); } }); }
      }) };
      return tx;
    }
  };
  const indexedDB = { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess(); }); return request; } };
  class FontFace {
    constructor(name, data) { this.data = data; }
    async load() {
      if (new Uint8Array(this.data)[0] === 0) throw new Error('invalid font');
      if (new Uint8Array(this.data)[0] === 9) await new Promise(resolve => releases.push(resolve));
      return this;
    }
  }
  const document = { fonts: { add: font => registered.add(font), delete: font => registered.delete(font) }, documentElement: { style: { setProperty: (key, value) => css.set(key, value) } } };
  const source = readFileSync(new URL('../src/lib/customFont.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'indexedDB', 'FontFace', 'document', js)(module, module.exports, indexedDB, FontFace, document);
  return { ...module.exports, css, registered, saved: () => saved, failSave: () => { failSave = true; }, release: () => releases.shift()() };
}
const file = (name, byte = 1, size = 10) => ({ name, size, arrayBuffer: async () => Uint8Array.of(byte).buffer });

test('custom font upload persists, restores and removes the font with Aspekta fallback', async () => {
  const env = fixture();
  assert.equal(await env.restoreCustomFont(), '');
  assert.equal(await env.uploadCustomFont(file('my-font.woff2')), 'my-font.woff2');
  assert.equal(env.saved().name, 'my-font.woff2');
  assert.equal(env.registered.size, 1);
  assert.equal(await env.restoreCustomFont(), 'my-font.woff2');
  assert.equal(env.registered.size, 1);
  await env.removeCustomFont();
  assert.equal(env.saved(), undefined);
  assert.equal(env.registered.size, 0);
  assert.equal(env.css.get('--custom'), 'var(--sans)');
  assert.equal(await env.restoreCustomFont(), '');
});

test('invalid files and failed storage preserve the previous custom font', async () => {
  const env = fixture();
  await env.uploadCustomFont(file('good.ttf'));
  const original = [...env.registered][0];
  for (const candidate of [file('bad.txt'), file('empty.otf', 1, 0), file('big.woff', 1, 2 * 1024 * 1024 + 1), file('corrupt.woff2', 0)]) {
    await assert.rejects(env.uploadCustomFont(candidate), /Choose|could not be read/);
    assert.equal([...env.registered][0], original);
    assert.equal(env.saved().name, 'good.ttf');
  }
  env.failSave();
  await assert.rejects(env.uploadCustomFont(file('replacement.ttf')), /Could not save/);
  await assert.rejects(env.removeCustomFont(), /Could not save/);
  assert.equal([...env.registered][0], original);
  assert.equal(env.saved().name, 'good.ttf');
});

test('concurrent font operations complete in order without stale restoration', async () => {
  const env = fixture();
  const first = env.uploadCustomFont(file('slow.ttf', 9));
  await new Promise(resolve => setImmediate(resolve));
  const restore = env.restoreCustomFont();
  const second = env.uploadCustomFont(file('new.woff2'));
  env.release();
  assert.equal(await first, 'slow.ttf');
  await new Promise(resolve => setImmediate(resolve));
  env.release();
  assert.equal(await restore, 'slow.ttf');
  assert.equal(await second, 'new.woff2');
  assert.equal(env.saved().name, 'new.woff2');
  assert.equal(env.registered.size, 1);
  assert.equal(new Uint8Array([...env.registered][0].data)[0], 1);
});

test('custom font accepts exactly 2 MB and rejects a larger file', async () => {
  const env = fixture();
  assert.equal(await env.uploadCustomFont(file('limit.woff2', 1, 2 * 1024 * 1024)), 'limit.woff2');
  await assert.rejects(env.uploadCustomFont(file('over.woff2', 1, 2 * 1024 * 1024 + 1)), /up to 2 MB/);
});

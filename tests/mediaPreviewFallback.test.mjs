import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = `${readFileSync(new URL('../src/components/MessageCard.tsx', import.meta.url), 'utf8')}\nexport { MediaPreview };`;
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
const dependencies = {
  './CustomSelect': { default: () => null },
  '../lib/media': { getMediaObjectUrl: async () => 'blob:local-photo' },
  '../lib/quoteHighlight': {},
  './TelegramRichText': {}
};
new Function('require', 'module', 'exports', js)(name => dependencies[name] ?? require(name), module, module.exports);
const Preview = module.exports.MediaPreview;
const response = (status, marker = null) => ({ status, headers: new Headers(marker ? { 'X-Media-Status': marker } : {}) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(fetcher, overrides = {}, directoryHandle = null, extra = {}) {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = (url, options) => { calls.push({ url, options }); return fetcher(url, options); };
  let message = { message_id: 4336, message_key: 'vn:4336', media_present: true, media_kind: 'photo', media_path: '/api/media/4336', external_urls: ['https://t.me/VidurNeeti', 'https://example.org/article'], ...overrides };
  let visible=extra.visible??true;
  const props = () => ({ message, directoryHandle,...extra.props });
  let tree;
  act(() => { tree = Renderer.create(React.createElement(Preview, props()),{createNodeMock:element=>element.type==='video'?extra.player??null:element.props.className==='reader-media reader-media-placeholder'?{getBoundingClientRect:()=>({height:100,top:visible?0:2000,bottom:visible?100:2100})}:null}); });
  return {
    tree, calls,
    setVisible(value){visible=value;},
    async fail(type = 'img') { await act(async () => { tree.root.findByType(type).props.onError(); }); },
    async update(next) { message = { ...message, ...next }; await act(async () => tree.update(React.createElement(Preview, props()))); },
    dispose() { act(() => tree.unmount()); globalThis.fetch = originalFetch; }
  };
}

function text(tree) { return JSON.stringify(tree.toJSON()); }

test('only an expired-preview response changes failed image into an article preview card', async () => {
  const f = fixture(async () => response(410, 'link-preview-unavailable'));
  try {
    assert.equal(f.calls.length, 0, 'successful media must not send a HEAD request');
    await f.fail();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, '/api/media/4336');
    assert.equal(f.calls[0].options.method, 'HEAD');
    assert.equal(f.calls[0].options.cache, 'no-store');
    assert.equal(f.tree.root.findByType('aside').props['aria-label'], 'Article preview');
    assert.match(text(f.tree), /example.org/);
    assert.match(text(f.tree), /From the article link/);
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-title' }).children.join(''), 'article');
    assert.doesNotMatch(text(f.tree), /Retry media|temporarily unavailable/);
    const link = f.tree.root.findByType('a');
    assert.equal(link.props.href, 'https://example.org/article');
    assert.equal(link.props.rel, 'noopener noreferrer');
    assert.equal(link.children[0], 'Open article');
  } finally { f.dispose(); }
});

test('a cooldown disables early retry and automatically reloads visible media at its deadline',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.UTC(2026,9,13)});
 const f=fixture(async()=>({status:503,headers:new Headers({'Retry-After':'3','X-Media-Status':'rate-limited'})}));
 try{
  await f.fail();const button=()=>f.tree.root.findAllByType('button').find(b=>b.props.className==='reader-inline-button');
  assert.equal(button().props.disabled,true);assert.match(text(f.tree),/Retry in 3s/);
  await act(async()=>t.mock.timers.tick(2000));assert.match(text(f.tree),/Retry in 1s/);assert.equal(f.calls.length,1);
  await act(async()=>t.mock.timers.tick(1000));assert.match(f.tree.root.findByType('img').props.src,/\?retry=1$/);assert.equal(f.calls.length,1);
 }finally{f.dispose();}
});

test('expired cooldown waits until offscreen media is visible and stops after two automatic retries',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.UTC(2026,9,13)});
 const originalWindow=globalThis.window,listeners=new Map();
 globalThis.window={innerHeight:800,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const f=fixture(async()=>({status:503,headers:new Headers({'Retry-After':'1'})}),{},null,{visible:false});
 try{
  await f.fail();await act(async()=>t.mock.timers.tick(1000));assert.match(text(f.tree),/Ready to retry when/);assert.equal(f.tree.root.findAllByType('img').length,0);
  f.setVisible(true);await act(async()=>listeners.get('scroll')());assert.match(f.tree.root.findByType('img').props.src,/\?retry=1$/);
  await f.fail();await act(async()=>t.mock.timers.tick(1000));assert.match(f.tree.root.findByType('img').props.src,/\?retry=2$/);
  await f.fail();await act(async()=>t.mock.timers.tick(5000));assert.equal(f.tree.root.findAllByType('img').length,0);assert.equal(f.calls.length,3);
  assert.equal(f.tree.root.findAllByType('button').find(b=>b.props.className==='reader-inline-button').props.disabled,false);
 }finally{f.dispose();globalThis.window=originalWindow;}
});

test('HTTP date cooldowns are honored and a changed post cannot inherit a pending retry',async(t)=>{
 const now=Date.UTC(2026,9,13);t.mock.timers.enable({apis:['setTimeout','Date'],now});
 const f=fixture(async()=>({status:503,headers:new Headers({'Retry-After':new Date(now+5000).toUTCString()})}));
 try{
  await f.fail();assert.match(text(f.tree),/Retry in 5s/);
  await f.update({message_key:'vn:43',message_id:43,media_path:'/api/media/43'});
  await act(async()=>t.mock.timers.tick(10000));assert.equal(f.tree.root.findByType('img').props.src,'/api/media/43');
 }finally{f.dispose();}
});

test('video failure captures the last playback position for retry restoration',async()=>{
 const saved=[],player={currentTime:72,playbackRate:1.5};
 const f=fixture(async()=>response(503),{media_kind:'video'},null,{player,props:{mediaPlayback:{time:72,rate:1.5},onSaveMediaPlayback:(_,state)=>saved.push(state)}});
 try{
  await f.fail('video');assert.deepEqual(saved,[{time:72,rate:1.5}]);
  await act(async()=>f.tree.root.findAllByType('button').find(b=>b.props.className==='reader-inline-button').props.onClick());
  const reloaded={currentTime:0,playbackRate:1,duration:100};
  act(()=>f.tree.root.findByType('video').props.onLoadedMetadata({currentTarget:reloaded}));assert.equal(reloaded.currentTime,72);assert.equal(reloaded.playbackRate,1.5);
 }finally{f.dispose();}
});

test('transient errors and unmarked 410s keep Retry media, which changes the actual media URL', async () => {
  for (const result of [response(503), response(404), response(410), response(410, 'other-status')]) {
    const f = fixture(async () => result);
    try {
      await f.fail();
      assert.match(text(f.tree), /Media temporarily unavailable/);
      const retry = f.tree.root.findByType('button');
      await act(async () => retry.props.onClick());
      assert.equal(f.tree.root.findByType('img').props.src, '/api/media/4336?retry=1');
      assert.equal(f.calls[0].options.signal.aborted, true);
      await f.fail();
      assert.equal(f.calls[1].url, '/api/media/4336?retry=1');
      await act(async () => f.tree.root.findByType('button').props.onClick());
      assert.equal(f.tree.root.findByType('img').props.src, '/api/media/4336?retry=2');
    } finally { f.dispose(); }
  }
});

test('network failures during inspection preserve the retryable native video error', async () => {
  const f = fixture(async () => { throw new TypeError('offline'); }, { media_kind: 'video' });
  try {
    await f.fail('video');
    assert.equal(f.calls.length, 1);
    assert.match(text(f.tree), /Retry media/);
    assert.doesNotMatch(text(f.tree), /Link preview unavailable/);
  } finally { f.dispose(); }
});

test('the fallback never exposes unsafe or Telegram URLs as an article action', async () => {
  const f = fixture(async () => response(410, 'link-preview-unavailable'), { external_urls: ['javascript:alert(1)', 'data:text/html,bad', 'not a URL', 'https://www.t.me/VidurNeeti', 'https://telegram.me/VidurNeeti'] });
  try {
    await f.fail();
    assert.match(text(f.tree), /Article preview/);
    assert.doesNotMatch(text(f.tree), /Retry media|unavailable/);
    assert.equal(f.tree.root.findAllByType('a').length, 0);
  } finally { f.dispose(); }
});

test('switching posts aborts inspection and ignores its late result; a new post loads normally', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  try {
    await f.fail();
    await f.update({ message_id: 43, message_key: 'vn:43', media_path: '/api/media/43' });
    assert.equal(f.calls.length, 1, 'a new post must not inherit the previous media failure');
    assert.equal(f.calls[0].options.signal.aborted, true);
    await act(async () => pending.resolve(response(410, 'link-preview-unavailable')));
    assert.equal(f.tree.root.findByType('img').props.src, '/api/media/43');
    assert.doesNotMatch(text(f.tree), /unavailable/);
  } finally { f.dispose(); }
});

test('unmount aborts a pending inspection and local-file errors make no hosted request', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  await f.fail();
  f.dispose();
  assert.equal(f.calls[0].options.signal.aborted, true);
  await act(async () => pending.resolve(response(410, 'link-preview-unavailable')));
  const local = fixture(async () => { throw new Error('should never fetch'); }, { media_path: 'media/photo.jpg' }, {});
  try {
    await act(async () => {});
    await local.fail();
    assert.equal(local.calls.length, 0);
    assert.match(text(local.tree), /Retry media/);
  } finally { local.dispose(); }
});

test('stored article metadata provides the headline, description, site and primary clean URL', async () => {
  const f = fixture(async () => response(410, 'link-preview-unavailable'), {
    media_preview: { url: 'https://user:secret@news.example/story-42', title: 'A real archived headline', description: 'The archived article description.', site_name: 'News Example' }
  });
  try {
    await f.fail();
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-title' }).children.join(''), 'A real archived headline');
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-description' }).children.join(''), 'The archived article description.');
    assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-site' }).children.join(''), 'News Example');
    assert.equal(f.tree.root.findByType('a').props.href, 'https://news.example/story-42');
    assert.doesNotMatch(text(f.tree), /From the article link|secret|temporarily unavailable/);
  } finally { f.dispose(); }
});

test('legacy preview cards label a decoded article slug as derived, and fall back to domain for numeric paths', async () => {
  for (const [url, expected] of [
    ['https://news.example/posts/the-quiet-reader.html', 'the quiet reader'],
    ['https://news.example/posts/a%20readable_title', 'a readable title'],
    ['https://news.example/7410415.html', 'news.example']
  ]) {
    const f = fixture(async () => response(410, 'link-preview-unavailable'), { external_urls: [url] });
    try {
      await f.fail();
      assert.equal(f.tree.root.findByProps({ className: 'reader-link-preview-title' }).children.join(''), expected);
      assert.match(text(f.tree), /From the article link/);
    } finally { f.dispose(); }
  }
});

test('unsafe metadata cannot supply a link or mislabel a different safe article', async () => {
  const f = fixture(async () => response(410, 'link-preview-unavailable'), {
    media_preview: { url: 'javascript:alert(1)', title: 'Wrong headline', description: 'Wrong description', site_name: 'Wrong site' }
  });
  try {
    await f.fail();
    assert.equal(f.tree.root.findByType('a').props.href, 'https://example.org/article');
    assert.doesNotMatch(text(f.tree), /Wrong headline|Wrong description|Wrong site/);
    assert.match(text(f.tree), /From the article link/);
  } finally { f.dispose(); }
});

test('a text-only Telegram preview renders its saved article details without requesting media', () => {
  const f = fixture(async () => { throw new Error('No media request expected'); }, {
    media_present: false, media_path: null, media_kind: 'webpage',
    media_preview: { url: 'https://example.org/article', title: 'An article without a thumbnail', site_name: 'Example' }
  });
  try {
    assert.equal(f.calls.length, 0);
    assert.equal(f.tree.root.findAllByType('img').length, 0);
    assert.match(text(f.tree), /An article without a thumbnail/);
    assert.equal(f.tree.root.findByType('a').props.href, 'https://example.org/article');
    assert.doesNotMatch(text(f.tree), /Retry media|unavailable/);
  } finally { f.dispose(); }
});

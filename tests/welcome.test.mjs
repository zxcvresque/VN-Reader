import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compile = (path, dependencies = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => name in dependencies ? dependencies[name] : require(name), module, module.exports);
  return module.exports;
};
const customSelect = compile('../src/components/CustomSelect.tsx', { 'react-dom': { createPortal: content => content } });
const preferences = compile('../src/lib/preferences.ts');
const messageSearch = compile('../src/lib/messageSearch.ts');
const touchLayout = compile('../src/lib/useTouchLayout.ts');
const entry = compile('../src/lib/entry.ts');
const {default: Capacity} = compile('../src/components/SignupCapacity.tsx');
const {default: BrandLogo} = compile('../src/components/BrandLogo.tsx');
const { default: Welcome, WELCOME_SLIDES, FeatureWalkthrough } = compile('../src/components/WelcomePage.tsx', {
  '../lib/preferences': preferences, './welcome.css': {}, './SignupCapacity': {default:Capacity}, './BrandLogo': {default:BrandLogo},
  './TelegramRichText': { default: ({ text }) => React.createElement('p', null, text) }
});
function environment() {
  const original = Object.fromEntries(['window', 'document', 'localStorage', 'CustomEvent'].map(key => [key, globalThis[key]]));
  const storage = new Map(), keys = new Map(),intervals=new Map();let nextInterval=0;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { localStorage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: fn=>{intervals.set(++nextInterval,fn);return nextInterval;}, clearInterval:id=>intervals.delete(id), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, scrollTo() {} };
  globalThis.document = { body: { style: { overflow: '' } }, activeElement: null, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener: (key, fn) => keys.set(key, fn), removeEventListener: key => keys.delete(key), querySelector: () => null, querySelectorAll: () => [] };
  globalThis.CustomEvent = class {};
  return { storage, keys, intervals, restore() { for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}
const props = () => ({ theme: 'opal', messages: [], manifest: null, onThemeChange() {}, onGuest() {}, onSignIn() {} });
const textOf = node => typeof node==='string'?node:(node.children??[]).map(textOf).join('');
const findButton = (root, text) => root.root.findAllByType('button').find(button => textOf(button).includes(text));
test('welcome offers guest and sign in, and every theme uses the same selector', () => {
  const env = environment(), calls = [];
  let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Welcome, { ...props(), onGuest: () => calls.push('guest'), onSignIn: () => calls.push('signin'), onThemeChange: theme => calls.push(theme) })); });
    act(() => findButton(root, 'Read as guest').props.onClick());
    act(() => findButton(root, 'Sign in').props.onClick());
    for(const theme of preferences.THEMES){
      act(()=>root.root.findByProps({'aria-label':'Change theme: Liquid Opal'}).props.onClick());
      const options=root.root.findAllByProps({role:'option'});
      assert.equal(options.length,4);
      act(()=>options.find(option=>textOf(option)===theme.name).props.onClick());
      assert.equal(root.root.findAllByProps({role:'listbox'}).length,0);
    }
    assert.deepEqual(calls, ['guest', 'signin', ...preferences.THEMES.map(t => t.id)]);
    assert.equal(root.root.findAllByType('h1')[0].children.filter(t => typeof t === 'string').join(''), 'A quieter way toread Vidurneeti.');
    assert.ok(!JSON.stringify(root.toJSON()).includes('Import archive'));
  } finally { if (root) act(() => root.unmount()); env.restore(); }
});
test('feature walkthrough supports all slides, keyboard navigation, close, and body cleanup', () => {
  const env = environment(); let root;
  try {
    act(() => { root = Renderer.create(React.createElement(Welcome, props()), { createNodeMock: () => ({ focus() {}, querySelectorAll: () => [] }) }); });
    act(() => findButton(root, 'Why vn reader').props.onClick());
    assert.equal(root.root.findAllByProps({ role: 'dialog' }).length, 1);
    assert.equal(document.body.style.overflow, 'hidden');
    for (let i = 0; i < WELCOME_SLIDES.length; i++) {
      assert.equal(root.root.findByProps({ id: 'welcome-slide-title' }).children.join(''), WELCOME_SLIDES[i].title);
      if (i < WELCOME_SLIDES.length - 1) act(() => env.keys.get('keydown')({ key: 'ArrowRight', preventDefault() {} }));
    }
    act(() => env.keys.get('keydown')({ key: 'ArrowLeft', preventDefault() {} }));
    assert.equal(root.root.findByProps({ id: 'welcome-slide-title' }).children.join(''), WELCOME_SLIDES.at(-2).title);
    act(() => env.keys.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
    assert.equal(root.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.equal(document.body.style.overflow, '');
  } finally { if (root) act(() => root.unmount()); env.restore(); }
});
test('guest entry persists separately from authentication and tolerates blocked storage', () => {
  const env = environment();
  try {
    assert.equal(entry.hasEnteredAsGuest(), false); entry.rememberGuestEntry(); assert.equal(entry.hasEnteredAsGuest(), true);
    assert.deepEqual([...env.storage.values()], ['guest']);
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(entry.hasEnteredAsGuest(), false); assert.doesNotThrow(() => entry.rememberGuestEntry());
  } finally { env.restore(); }
});

async function appFixture({ cached = false, cacheFails = false, archiveFails = false, savedPosition = false, archiveFetcher, skipTour=false } = {}) {
  const env = environment();
  if(skipTour)entry.rememberTourInvitation();
  const demo = compile('../src/lib/demo.ts', { './idb': {} });
  const messages = demo.DEMO_MESSAGES;
  const manifest = { source: { chat_id: messages[0].chat_id }, range: {}, counts: {} };
  const snapshot = { manifest: cached ? manifest : null, messages: cached ? messages : [], threads: [], bookmarks: [], readOverrides: [], readCursor: null, importSessions: [], directoryHandle: null };
  let cacheWrites=0;
  const idb = { loadAppSnapshot: async () => snapshot, replaceAllMessages: async () => { cacheWrites++;if (cacheFails) throw Error('storage blocked'); }, replaceAllThreads: async () => {}, saveManifest: async () => {}, saveDirectoryHandle: async () => {} };
  const archive = compile('../src/lib/archive.ts', { './idb': idb });
  const state = compile('../src/lib/readingState.ts');
  const positions = [],jumps=[];
  if (savedPosition) {
    const saved = state.createReadingState(messages[0].chat_id);
    saved.positions[messages[2].message_key] = { offset: 125, updatedAt: '2026-09-30T00:00:00Z' };
    state.saveReadingState(saved);
  }
  const backup = compile('../src/lib/backup.ts', { './readingState': state, './preferences': preferences });
  const api = { fetchSiteArchive: async etag => { if (archiveFails) throw Error('Archive network failed'); return archiveFetcher?archiveFetcher(etag,{manifest,messages}):{ manifest, messages }; } };
  const account = { user: null, config: { accountsEnabled: false, archiveEnabled: true }, configReady: true, configError: '', status: 'guest', flush() {}, refreshConfig() {}, initialize() {} };
  const component = name => ({ default: props => React.createElement('div', { 'data-component': name }, props.children) });
  const deps = { './components/CustomSelect': customSelect, './lib/customFont': {restoreCustomFont:async()=>''}, './lib/useTouchLayout': touchLayout, './lib/demo': demo, './lib/entry': entry, './lib/preferences': preferences, './lib/readingState': state, './lib/backup': backup, './lib/idb': idb, './lib/archive': { ...archive, getDirectoryPermission: async () => 'unsupported' }, './lib/api': api, './lib/useReaderAccount': { useReaderAccount: () => account }, './lib/useSignupCapacity': {useSignupCapacity:()=>({capacity:null,error:'',refresh(){}})}, './lib/media': { revokeAllMediaObjectUrls() {} }, './components/WelcomePage': { default: Welcome, FeatureWalkthrough } };
  for (const name of ['AdminDashboard', 'ReaderSettings', 'ReadingWidth', 'ReaderGuide', 'ReaderAccount', 'ReadingLibrary', 'CommandPalette', 'MediaLightbox', 'QuotedSourcePanel', 'MessageCard', 'ThreadRail', 'TopBar', 'PostTimeline', 'VirtualizedMessageList']) deps[`./components/${name}`] = component(name);
  deps['./components/VirtualizedMessageList'] = { default: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ restorePosition: p => positions.push(p), scrollToIndex(index,align) {jumps.push({index,align});}, getPosition: () => null }), []);
    return React.createElement('div', { 'data-component': 'VirtualizedMessageList' });
  }) };
  deps['./lib/messageSearch'] = messageSearch;
  const { default: App } = compile('../src/App.tsx', deps);
  const restoreTarget={};
  let root;
  await act(async () => { root = Renderer.create(React.createElement(App),{createNodeMock:element=>element.props.className==='reader-navigation-restore'?restoreTarget:null}); });
  return { root, account, positions,jumps,messages,restoreTarget,get cacheWrites(){return cacheWrites;},async poll(){await act(async()=>{for(const update of env.intervals.values())await update();});}, async guest() { await act(async () => findButton(root, 'Read as guest').props.onClick()); }, async rerender() { await act(async () => root.update(React.createElement(App))); }, close() { act(() => root.unmount()); env.restore(); } };
}
test('cached and hosted archives both wait for a deliberate guest choice', async () => {
  for (const cached of [false, true]) {
    const f = await appFixture({ cached });
    try {
      assert.equal(f.root.root.findAllByType(Welcome).length, 1);
      assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 0);
      await f.guest();
      assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1);
    } finally { f.close(); }
  }
});
test('a failed offline cache write never blocks reading the hosted archive', async () => {
  const f = await appFixture({ cacheFails: true });
  try { await f.guest(); assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1); }
  finally { f.close(); }
});

test('unchanged archive revalidation skips rewriting the offline cache',async()=>{
 const requested=[];
 const f=await appFixture({archiveFetcher:(etag,data)=>{requested.push(etag);return etag?null:{...data,etag:'W/"revision-1"'};}});
 try{
  await f.guest();assert.equal(f.cacheWrites,1);await f.poll();await f.poll();assert.equal(f.cacheWrites,1);
  assert.deepEqual(requested,[undefined,'W/"revision-1"','W/"revision-1"']);
 }finally{f.close();}
});

test('opening a post clears filtering and restores full earlier and later feed context',async()=>{
 const f=await appFixture({skipTour:true});
 try{
  await f.guest();
  act(()=>f.root.root.findByProps({'aria-label':'Search and filter'}).props.onClick());
  await act(async()=>f.root.root.findByProps({'aria-label':'Search archive beside reading'}).props.onChange({target:{value:'#5'}}));
  await act(async()=>findButton(f.root,'Filter stream').props.onClick());
  const virtual=()=>f.root.root.findAll(node=>typeof node.props.renderMessage==='function')[0];
  assert.equal(virtual().props.messages.length,1);f.jumps.length=0;
  await act(async()=>findButton(f.root,'Read post').props.onClick());
  assert.equal(virtual().props.messages.length,f.messages.length);
  assert.ok(virtual().props.messages.some(message=>message.message_id===4));assert.ok(virtual().props.messages.some(message=>message.message_id===6));
  assert.deepEqual(f.jumps.at(-1),{index:4,align:'start'});
  assert.match(textOf(f.root.root.findByProps({className:'reading-current-position'})),/#5 22 Sept, 2026/);
  act(()=>virtual().props.onVisibleMessageChange(f.messages[5].message_key));
  assert.match(textOf(f.root.root.findByProps({className:'reading-current-position'})),/#6 22 Sept, 2026/);
 }finally{f.close();}
});
test('every main page mounts the same toolbar navigation restore target',async()=>{
 const f=await appFixture();
 try{
  await f.guest();
  const topBar=()=>f.root.root.findAll(node=>node.props.onSetView&&'restoreTarget' in node.props)[0];
  for(const view of ['progress','threads','bookmarks','read']){
   await act(async()=>topBar().props.onSetView(view));
   assert.equal(topBar().props.restoreTarget,f.restoreTarget);
   assert.equal(f.root.root.findAllByProps({className:'reader-navigation-restore'}).length,1);
   const toolbar=f.root.root.findByProps({'data-view':view});
   assert.equal(toolbar.props.className,view==='read'?'reader-toolbar':'view-toolbar');
  }
 }finally{f.close();}
});
test('leaving Read exits focus and removes its floating control from the destination page',async()=>{
 const f=await appFixture();
 try{
  await f.guest();
  const topBar=()=>f.root.root.findAll(node=>node.props.onSetView&&'restoreTarget' in node.props)[0];
  for(const view of ['progress','threads','bookmarks']){
   await act(async()=>topBar().props.onToggleFocus());
   assert.equal(topBar().props.focusMode,true);
   await act(async()=>topBar().props.onSetView(view));
   assert.equal(topBar().props.view,view);
   assert.equal(topBar().props.focusMode,false);
   assert.equal(f.root.root.findAllByProps({className:'reader-focus-exit'}).length,0);
   await act(async()=>topBar().props.onSetView('read'));
  }
 }finally{f.close();}
});
test('archive failures retain a retry screen after guest entry, rather than an import page', async () => {
  const f = await appFixture({ archiveFails: true });
  try {
    await f.guest();
    assert.equal(f.root.root.findAllByProps({ role: 'alert' }).length, 1);
    assert.ok(findButton(f.root, 'Try again'));
    assert.ok(!JSON.stringify(f.root.toJSON()).includes('Import archive'));
  } finally { f.close(); }
});
test('a verified sign-in enters the reader and guest mode is not silently remembered', async () => {
  const f = await appFixture();
  try {
    act(() => findButton(f.root, 'Sign in').props.onClick());
    assert.equal(f.root.root.findAllByProps({ 'data-component': 'ReaderAccount' }).length, 1);
    assert.equal(f.root.root.findAllByType(Welcome).length, 1);
    f.account.user = { id: 'verified', email: 'reader@example.test' }; await f.rerender();
    assert.equal(f.root.root.findAllByProps({ 'data-component': 'TopBar' }).length, 1);
    assert.equal(entry.hasEnteredAsGuest(), false);
  } finally { f.close(); }
});
test('guest entry restores the saved paragraph after the reader mounts', async () => {
  const f = await appFixture({ cached: true, savedPosition: true });
  try { assert.equal(f.positions.length, 0); await f.guest(); assert.equal(f.positions.length, 1); assert.equal(f.positions[0].offset, 125); }
  finally { f.close(); }
});

test('first reader entry automatically starts the basic tour once and help can replay the feature slides', async () => {
  const f = await appFixture();
  try {
    await f.guest();
    assert.equal(f.root.root.findByProps({ 'data-component': 'ReaderGuide' }).parent.props.topic, 'basic');
    assert.equal(entry.shouldOfferTour(), false);
    assert.equal(f.root.root.findAllByProps({ 'aria-label': 'Get started with VN Reader' }).length, 0);
    const guide = f.root.root.findByProps({ 'data-component': 'ReaderGuide' });
    act(() => guide.parent.props.onLearnMore());
    assert.equal(f.root.root.findAllByType(FeatureWalkthrough).length, 1);
    act(() => findButton(f.root, 'Close').props.onClick());
    assert.equal(f.root.root.findAllByType(FeatureWalkthrough).length, 0);
  } finally { f.close(); }
});

test('welcome shows remaining email slots; a full allowance blocks new signup but leaves guest and password sign-in available', () => {
  const env=environment();let root;
  const capacity={configured:true,limit:300,used:299,remaining:1,resetsAt:'2026-10-02T00:00:00Z',timezone:'UTC',scope:'VN Reader email allowance'};
  try {
    act(()=>{root=Renderer.create(React.createElement(Welcome,{...props(),capacity}));});
    assert.ok(root.root.findAllByType('span').some(node=>node.children.filter(c=>typeof c==='string').join('')==='1 email slot left today'));
    assert.equal(findButton(root,'Create an account').props.disabled,false);
    act(()=>root.update(React.createElement(Welcome,{...props(),capacity:{...capacity,used:300,remaining:0}})));
    assert.match(JSON.stringify(root.toJSON()),/Email verification is full for today/);
    assert.equal(findButton(root,'Create an account').props.disabled,true);
    assert.notEqual(findButton(root,'Sign in').props.disabled,true);
    assert.notEqual(findButton(root,'Read as guest').props.disabled,true);
    assert.ok(!JSON.stringify(root.toJSON()).includes('Brevo'));
  } finally {if(root)act(()=>root.unmount());env.restore();}
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const compile=async(path,dependencies={})=>{
 const source=await readFile(new URL(path,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};new Function('require','module','exports',js)(name=>dependencies[name]??require(name),module,module.exports);return module.exports;
};
const merge=await compile('../src/lib/cloudMerge.ts');
const blank=(chat=-100)=>({format:'vn-reader-reading-state',version:1,exportedAt:'2000-01-01T00:00:00.000Z',chatId:chat,preferences:{theme:'vercel'},readingState:{version:1,chatId:chat,positions:{},statuses:{},queue:[],notes:{},passages:[],collections:[],media:{}},bookmarks:[],readOverrides:[],readCursor:null});
const withNote=(value,chat=-100)=>{const d=blank(chat);d.readingState.notes.post=value;return d;};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture({guest=withNote('guest'),cached,remote={revision:1,data:withNote('server')},load,save,sessionApi=async()=>null,auth,autoInitialize=true,configApi=async()=>({accountsEnabled:true,archiveEnabled:true})}={}){
 const storage=new Map();if(cached)storage.set('vn-reader:account:u:-100',JSON.stringify(cached));
 const oldWindow=globalThis.window,oldStorage=globalThis.localStorage;
 globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 const events=new Map();const on=(name,fn)=>{const listeners=events.get(name)??new Set();listeners.add(fn);events.set(name,listeners);};const off=(name,fn)=>events.get(name)?.delete(fn);
 const timers=new Map();let next=0;globalThis.window={setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),setInterval:()=>++next,clearInterval:()=>{},addEventListener:on,removeEventListener:off,document:{visibilityState:'visible',addEventListener:on,removeEventListener:off}};
 let logouts=0,control,doc,update;const applied=[];let currentRemote=remote;
 const apiModule={api:async path=>path==='/config'?configApi():sessionApi(),ApiError:class extends Error{},authRequest:auth??(async()=>{logouts++;}),loadCloudState:load??(async()=>currentRemote),saveCloudState:save??(async(chat,data,revision)=>({revision:revision+1,data}))};
 const {useReaderAccount}=await compile('../src/lib/useReaderAccount.ts',{'./api':apiModule,'./cloudMerge':merge});
 function Harness(){const [document,setDocument]=React.useState(guest);doc=document;update=setDocument;control=useReaderAccount(document,(d,restore)=>{applied.push({d,restore});setDocument(d);},()=>{},value=>{if(value.chatId!==document.chatId)throw Error('Wrong archive');return structuredClone(value);});return null;}
 let root;await act(async()=>{root=Renderer.create(React.createElement(Harness));});
 if(autoInitialize)await act(async()=>{await control.initialize({id:'u',email:'reader@example.com'});});
 return {get control(){return control;},get doc(){return doc;},applied,storage,get logouts(){return logouts;},setRemote:r=>{currentRemote=r;},event:async name=>{await act(async()=>{for(const fn of events.get(name)??[])fn();});},edit:async d=>{await act(async()=>update(d));},close:()=>{act(()=>root.unmount());globalThis.window=oldWindow;globalThis.localStorage=oldStorage;}};
}
test('offline initialization restores account cache; subsequent edits never enter the guest copy',async()=>{
 const base=withNote('server'),local=withNote('cached');const f=await fixture({cached:{base,data:local,revision:1},load:async()=>{throw Error('Offline');}});
 try{assert.equal(f.control.status,'offline');assert.equal(f.doc.readingState.notes.post,'cached');assert.equal(f.control.guestImport.readingState.notes.post,'guest');await f.edit(withNote('offline edit'));f.control.flush(f.doc);assert.equal(JSON.parse(f.storage.get('vn-reader:account:u:-100')).data.readingState.notes.post,'offline edit');}finally{f.close();}
});
test('an account without a cache uses an empty account document while offline and keeps guest import separate',async()=>{
 const f=await fixture({load:async()=>{throw Error('Offline');}});try{assert.deepEqual(f.doc.readingState.notes,{});assert.equal(f.control.guestImport.readingState.notes.post,'guest');assert.equal(f.control.ready,true);}finally{f.close();}
});
test('archive switching clears old conflicts and cannot apply the old archive server copy',async()=>{
 const f=await fixture({cached:{base:withNote('old'),data:withNote('local'),revision:1}});try{
  assert.equal(f.control.status,'conflict');f.setRemote({revision:1,data:withNote('archive two',-200)});await f.edit(blank(-200));assert.equal(f.control.status,'saved');assert.deepEqual(f.control.conflicts,[]);await act(async()=>f.control.resolve('server'));assert.equal(f.doc.chatId,-200);assert.equal(f.doc.readingState.notes.post,'archive two');
 }finally{f.close();}
});
test('logout stops when its final sync discovers competing edits',async()=>{
 const f=await fixture({remote:{revision:1,data:withNote('old')}});try{await f.edit(withNote('device'));f.setRemote({revision:2,data:withNote('remote edit')});await act(async()=>{await assert.rejects(f.control.logout(),/Resolve|resolve/);});assert.equal(f.logouts,0);assert.equal(f.control.status,'conflict');assert.equal(f.control.user.id,'u');}finally{f.close();}
});
test('conflict resolution preserves edits made while the save is in flight',async()=>{
 const pending=deferred();const f=await fixture({cached:{base:withNote('old'),data:withNote('local'),revision:1},save:()=>pending.promise});try{
  assert.equal(f.control.status,'conflict');let resolving;act(()=>{resolving=f.control.resolve('device');});await f.edit(withNote('newer edit'));await act(async()=>{pending.resolve({revision:2,data:withNote('local')});await resolving;});assert.equal(f.doc.readingState.notes.post,'newer edit');assert.equal(f.control.status,'saved');
 }finally{f.close();}
});
test('initial cloud progress requests position restoration after account hydration',async()=>{
 const cloud=blank();cloud.readingState.positions.post={offset:250,updatedAt:'2026-09-30T00:00:00Z'};const f=await fixture({remote:{revision:1,data:cloud}});try{assert.equal(f.applied.at(-1).restore,true);assert.equal(f.doc.readingState.positions.post.offset,250);}finally{f.close();}
});
test('site configuration errors are visible and retry recovers without discarding the account',async()=>{
 let attempts=0;const f=await fixture({configApi:async()=>{if(++attempts===1)throw Error('Temporary connection failure');return {accountsEnabled:false,archiveEnabled:true};}});
 try{
  assert.equal(f.control.configReady,true);assert.equal(f.control.configError,'Temporary connection failure');
  await act(async()=>f.control.refreshConfig());
  assert.deepEqual(f.control.config,{accountsEnabled:false,archiveEnabled:true});assert.equal(f.control.configError,'');assert.equal(f.control.user.id,'u');
 }finally{f.close();}
});
test('Retry connection rediscovers a failed saved session and keeps guest edits separate',async()=>{
 let attempts=0;const f=await fixture({autoInitialize:false,sessionApi:async()=>{if(++attempts===1)throw Error('Offline');return {user:{id:'u',email:'reader@example.com'}};}});
 try{
  assert.equal(f.control.user,null);assert.match(f.control.sessionError,/saved sign-in/);
  await f.edit(withNote('guest edit after session failure'));
  await act(async()=>f.control.refreshConfig());
  assert.equal(attempts,2);assert.equal(f.control.user.id,'u');assert.equal(f.control.sessionError,'');
  assert.equal(f.doc.readingState.notes.post,'server');assert.equal(f.control.guestImport.readingState.notes.post,'guest edit after session failure');
 }finally{f.close();}
});
for(const event of ['online','visibilitychange'])test(`${event} recovers failed discovery but does not repeatedly rediscover a confirmed guest`,async()=>{
 let attempts=0;const f=await fixture({autoInitialize:false,sessionApi:async()=>{if(++attempts===1)throw Error('Offline');return null;}});
 try{await f.event(event);assert.equal(attempts,2);assert.equal(f.control.sessionError,'');await f.event(event);assert.equal(attempts,2);assert.equal(f.doc.readingState.notes.post,'guest');}finally{f.close();}
});
test('an old discovery response cannot override an explicit login or signed-out account',async()=>{
 const pending=deferred();const f=await fixture({autoInitialize:false,sessionApi:()=>pending.promise});
 try{
  act(()=>f.control.beginAuthentication());
  await act(async()=>f.control.initialize({id:'u',email:'chosen@example.com'}));
  await act(async()=>f.control.logout());
  const count=f.applied.length;
  await act(async()=>pending.resolve({user:{id:'old',email:'old@example.com'}}));
  assert.equal(f.control.user,null);assert.equal(f.applied.length,count);assert.equal(f.control.status,'guest');
 }finally{f.close();}
});
test('same-account sign-in preserves unsynced edits and the original guest import',async()=>{
 const f=await fixture();try{
  await f.edit(withNote('unsynced reading'));
  const count=f.applied.length;
  await act(async()=>f.control.initialize({id:'u',email:'reader@example.com',name:'Vidur'}));
  assert.equal(f.doc.readingState.notes.post,'unsynced reading');assert.equal(f.applied.length,count);assert.equal(f.control.guestImport.readingState.notes.post,'guest');assert.equal(f.control.user.name,'Vidur');
 }finally{f.close();}
});
test('updating a name uses only the profile field and preserves reading edits made in flight',async()=>{
 const pending=deferred(),requests=[];const f=await fixture({auth:(action,body)=>{requests.push({action,body});return pending.promise;}});
 try{
  let updating;act(()=>{updating=f.control.updateName('  Vidur daas  ');});
  await f.edit(withNote('edited during profile update'));
  const count=f.applied.length;await act(async()=>{pending.resolve({status:true});await updating;});
  assert.deepEqual(requests,[{action:'update-user',body:{name:'Vidur daas'}}]);assert.equal(f.control.user.name,'Vidur daas');assert.equal(f.doc.readingState.notes.post,'edited during profile update');assert.equal(f.applied.length,count);
 }finally{f.close();}
});
test('a stale profile response cannot replace a new account identity',async()=>{
 const pending=deferred();const f=await fixture({auth:()=>pending.promise});
 try{
  let updating;act(()=>{updating=f.control.updateName('Old name');});
  await act(async()=>f.control.initialize({id:'new',email:'new@example.com',name:'New reader'}));
  await act(async()=>{pending.resolve({status:true});await updating;});
  assert.equal(f.control.user.id,'new');assert.equal(f.control.user.name,'New reader');
 }finally{f.close();}
});

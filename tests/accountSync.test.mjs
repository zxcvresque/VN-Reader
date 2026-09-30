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
async function fixture({guest=withNote('guest'),cached,remote={revision:1,data:withNote('server')},load,save}={}){
 const storage=new Map();if(cached)storage.set('vn-reader:account:u:-100',JSON.stringify(cached));
 const oldWindow=globalThis.window,oldStorage=globalThis.localStorage;
 globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 const timers=new Map();let next=0;globalThis.window={setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),setInterval:()=>++next,clearInterval:()=>{},addEventListener:()=>{},removeEventListener:()=>{},document:{visibilityState:'visible',addEventListener:()=>{},removeEventListener:()=>{}}};
 let logouts=0,control,doc,update;const applied=[];let currentRemote=remote;
 const apiModule={api:async path=>path==='/config'?{accountsEnabled:true,archiveEnabled:true}:null,ApiError:class extends Error{},authRequest:async()=>{logouts++;},loadCloudState:load??(async()=>currentRemote),saveCloudState:save??(async(chat,data,revision)=>({revision:revision+1,data}))};
 const {useReaderAccount}=await compile('../src/lib/useReaderAccount.ts',{'./api':apiModule,'./cloudMerge':merge});
 function Harness(){const [document,setDocument]=React.useState(guest);doc=document;update=setDocument;control=useReaderAccount(document,(d,restore)=>{applied.push({d,restore});setDocument(d);},()=>{},value=>{if(value.chatId!==document.chatId)throw Error('Wrong archive');return structuredClone(value);});return null;}
 let root;await act(async()=>{root=Renderer.create(React.createElement(Harness));});
 await act(async()=>{await control.initialize({id:'u',email:'reader@example.com'});});
 return {get control(){return control;},get doc(){return doc;},applied,storage,get logouts(){return logouts;},setRemote:r=>{currentRemote=r;},edit:async d=>{await act(async()=>update(d));},close:()=>{act(()=>root.unmount());globalThis.window=oldWindow;globalThis.localStorage=oldStorage;}};
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

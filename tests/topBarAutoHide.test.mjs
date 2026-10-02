import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/TopBar.tsx',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const mod={exports:{}};
new Function('require','module','exports',js)(name=>name==='./BrandLogo'?{default:()=>null}:name==='../lib/useTouchLayout'?{useTouchLayout:()=>false}:require(name),mod,mod.exports);
function fixture(){
 const original={localStorage:globalThis.localStorage,document:globalThis.document};const stored=new Map();
 globalThis.localStorage={getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)};
 globalThis.document={addEventListener:()=>{},removeEventListener:()=>{}};
 let keyboardFocus=false;let tree;
 const shell={querySelector:()=>keyboardFocus?{}:null,contains:()=>false};
 act(()=>{tree=Renderer.create(React.createElement(mod.exports.default,{channelTitle:'vn reader',channelMeta:'',anchorLabel:'#4',progressPercent:0,view:'read',onSetView:()=>{},onOpenPalette:()=>{}}),{createNodeMock:element=>element.type==='header'?shell:null});});
 const header=()=>tree.root.findByType('header');
 const toggle=()=>tree.root.findAllByType('button').find(b=>b.props['aria-pressed']!==undefined);
 return{tree,stored,header,toggle,setFocus:value=>{keyboardFocus=value;},restore:()=>{act(()=>tree.unmount());Object.assign(globalThis,original);}};
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,380));
test('navigation starts pinned and persists explicit auto hide preference',()=>{const f=fixture();try{assert.equal(f.toggle().props['aria-label'],'Hide navigation while reading');act(()=>f.toggle().props.onClick());assert.equal(f.stored.get('vn-reader-nav-auto-hide'),'true');assert.equal(f.toggle().props['aria-label'],'Keep navigation visible');act(()=>f.toggle().props.onClick());assert.equal(f.stored.get('vn-reader-nav-auto-hide'),'false');assert.ok(!f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});
test('reveal strip allows crossing the gap into navigation without collapsing',async()=>{const f=fixture();try{act(()=>f.toggle().props.onClick());act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(f.header().props.className.includes('nav-auto-hidden'));const edge=f.tree.root.findByProps({'aria-label':'Show navigation'});act(()=>edge.props.onPointerEnter());act(()=>edge.props.onPointerLeave());act(()=>f.header().props.onPointerEnter());await act(async()=>pause());assert.ok(!f.header().props.className.includes('nav-auto-hidden'));act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});
test('keyboard focus keeps navigation visible while pointer leaves',async()=>{const f=fixture();try{act(()=>f.toggle().props.onClick());f.setFocus(true);act(()=>f.header().props.onFocusCapture());act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(!f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});

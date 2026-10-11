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
let touchLayout=false;
const portals=[];
new Function('require','module','exports',js)(name=>name==='react-dom'?{createPortal:(content,target)=>{portals.push(target);return content;}}:name==='./BrandLogo'?{default:()=>null}:name==='../lib/useTouchLayout'?{useTouchLayout:()=>touchLayout}:require(name),mod,mod.exports);
function fixture(props={},touch=false){
 touchLayout=touch;portals.length=0;
 const original={localStorage:globalThis.localStorage,document:globalThis.document,window:globalThis.window,requestAnimationFrame:globalThis.requestAnimationFrame};const stored=new Map();
 globalThis.localStorage={getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)};
 globalThis.document={addEventListener:()=>{},removeEventListener:()=>{}};
 globalThis.window={addEventListener:()=>{},removeEventListener:()=>{}};
 globalThis.requestAnimationFrame=callback=>callback();
 let keyboardFocus=false;let tree;
 const shell={querySelector:()=>keyboardFocus?{}:null,contains:()=>false};
 act(()=>{tree=Renderer.create(React.createElement(mod.exports.default,{channelTitle:'vn reader',channelMeta:'',anchorLabel:'#4',progressPercent:0,view:'read',onSetView:()=>{},onOpenPalette:()=>{},...props}),{createNodeMock:element=>element.type==='header'?shell:null});});
 const header=()=>tree.root.findByType('header');
 const toggle=()=>tree.root.findAllByType('button').find(b=>b.props['aria-pressed']!==undefined);
 return{tree,stored,header,toggle,setFocus:value=>{keyboardFocus=value;},restore:()=>{act(()=>tree.unmount());Object.assign(globalThis,original);}};
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,380));
test('navigation starts pinned and persists explicit auto hide preference',()=>{const f=fixture();try{assert.equal(f.toggle().props['aria-label'],'Hide navigation while reading');act(()=>f.toggle().props.onClick());assert.equal(f.stored.get('vn-reader-nav-auto-hide'),'true');assert.equal(f.toggle().props['aria-label'],'Keep navigation visible');act(()=>f.toggle().props.onClick());assert.equal(f.stored.get('vn-reader-nav-auto-hide'),'false');assert.ok(!f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});
test('reveal strip allows crossing the gap into navigation without collapsing',async()=>{const f=fixture();try{act(()=>f.toggle().props.onClick());act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(f.header().props.className.includes('nav-auto-hidden'));const edge=f.tree.root.findByProps({'aria-label':'Show navigation'});act(()=>edge.props.onPointerEnter());act(()=>edge.props.onPointerLeave());act(()=>f.header().props.onPointerEnter());await act(async()=>pause());assert.ok(!f.header().props.className.includes('nav-auto-hidden'));act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});
test('keyboard focus keeps navigation visible while pointer leaves',async()=>{const f=fixture();try{act(()=>f.toggle().props.onClick());f.setFocus(true);act(()=>f.header().props.onFocusCapture());act(()=>f.header().props.onPointerLeave());await act(async()=>pause());assert.ok(!f.header().props.className.includes('nav-auto-hidden'));}finally{f.restore();}});

test('reveal edge and help text follow the chosen desktop navigation position',()=>{
 for(const navPosition of ['top','bottom','left','right']){
  const f=fixture({navPosition});try{
   assert.match(f.toggle().props['data-tooltip'],new RegExp(`reveal at ${navPosition} edge`));
   act(()=>f.toggle().props.onClick());
   assert.equal(f.tree.root.findByProps({'aria-label':'Show navigation'}).props['data-edge'],navPosition);
  }finally{f.restore();}
 }
 const f=fixture({navPosition:'left',focusMode:true});try{act(()=>f.toggle().props.onClick());assert.equal(f.tree.root.findByProps({'aria-label':'Show navigation'}).props['data-edge'],'top');}finally{f.restore();}
});

test('hiding touch navigation points readers to the restore button in the reading toolbar',()=>{
 const target={};const f=fixture({restoreTarget:target},true);
 try{
  act(()=>f.toggle().props.onClick());
  assert.ok(f.header().props.className.includes('nav-auto-hidden'));
  assert.ok(portals.includes(target));
  const button=f.tree.root.findByProps({'aria-label':'Show navigation'});
  assert.match(button.props.className,/nav-restore-button/);
  assert.equal(button.props['aria-describedby'],'navigation-restore-hint');
  assert.match(f.tree.root.findByProps({role:'status'}).children.join(''),/Tap the menu button/);
  act(()=>f.tree.root.findAllByType('button').find(b=>b.children.join('')==='Got it').props.onClick());
  assert.equal(f.tree.root.findAllByProps({role:'status'}).length,0);
  assert.ok(f.header().props.className.includes('nav-auto-hidden'));
  act(()=>button.props.onClick());
  assert.ok(!f.header().props.className.includes('nav-auto-hidden'));
 }finally{f.restore();}
});

test('restore hint follows desktop edges and closes when navigation is restored',()=>{
 const f=fixture({navPosition:'right'});
 try{
  act(()=>f.toggle().props.onClick());
  assert.match(f.tree.root.findByProps({role:'status'}).children.join(''),/right edge/);
  act(()=>f.tree.root.findByProps({'aria-label':'Show navigation'}).props.onClick());
  assert.equal(f.tree.root.findAllByProps({role:'status'}).length,0);
  act(()=>f.toggle().props.onClick());
  assert.equal(f.tree.root.findAllByProps({'aria-label':'Show navigation'}).length,0);
 }finally{f.restore();}
});

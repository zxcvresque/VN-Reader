import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function compile(path,resolve=require){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const mod={exports:{}};
 new Function('require','module','exports',js)(resolve,mod,mod.exports);
 return mod.exports;
}
const geometry=compile('../src/lib/mediaViewport.ts');
const Lightbox=compile('../src/components/MediaLightbox.tsx',name=>name==='react-dom'?{createPortal:children=>children}:name==='../lib/mediaViewport'?geometry:require(name)).default;

function fixture(media={url:'/api/media/43',kind:'photo',caption:'#43 · /api/media/43'}){
 const original={document:globalThis.document,window:globalThis.window,ResizeObserver:globalThis.ResizeObserver};
 const keyboard=new Map(),wheel=new Map(),observers=[],captures=[];
 let closed=0,tree;
 const doc={body:{style:{overflow:'auto'}},activeElement:null};
 const focusNode=()=>({isConnected:true,focus(){doc.activeElement=this;}});
 const previous=focusNode(),buttons=new Map(['Zoom out','Fit image','Zoom in','Close media viewer'].map(label=>[label,focusNode()]));
 doc.activeElement=previous;
 const stage={clientHeight:600,getBoundingClientRect:()=>({left:0,top:0,width:1000,height:600}),setPointerCapture:id=>captures.push(id),addEventListener:(name,fn,options)=>wheel.set(name,{fn,options}),removeEventListener:(name,fn)=>{if(wheel.get(name)?.fn===fn)wheel.delete(name);}};
 const dialog={contains:node=>[...buttons.values()].includes(node),querySelectorAll:()=>tree.root.findAllByType('button').filter(button=>!button.props.disabled).map(button=>buttons.get(button.props['aria-label']))};
 globalThis.document=doc;
 globalThis.window={addEventListener:(name,fn,capture)=>keyboard.set(name,{fn,capture}),removeEventListener:(name,fn)=>{if(keyboard.get(name)?.fn===fn)keyboard.delete(name);}};
 globalThis.ResizeObserver=class {constructor(fn){this.fn=fn;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnected=true;}};
 const props=()=>({media,onClose:()=>closed++});
 act(()=>{tree=Renderer.create(React.createElement(Lightbox,props()),{createNodeMock:element=>element.props.className?.startsWith('lightbox-stage')?stage:element.props.className==='lightbox-overlay'?dialog:element.props['aria-label']==='Close media viewer'?buttons.get('Close media viewer'):null});});
 const button=label=>tree.root.findByProps({'aria-label':label});
 const stageNode=()=>tree.root.findAllByType('div').find(node=>node.props.className?.startsWith('lightbox-stage'));
 const frame=()=>tree.root.findByProps({className:'lightbox-image-frame'});
 const load=(width=1200,height=2400)=>act(()=>tree.root.findByType('img').props.onLoad({currentTarget:{naturalWidth:width,naturalHeight:height}}));
 const pointer=(id,x,y,target={},type='touch')=>({pointerId:id,clientX:x,clientY:y,target,currentTarget:stage,pointerType:type,button:0});
 return {tree,doc,previous,buttons,stage,keyboard,wheel,observers,captures,button,stageNode,frame,load,pointer,get closed(){return closed;},update(next){media=next;act(()=>tree.update(React.createElement(Lightbox,props())));},restore(){act(()=>tree.unmount());Object.assign(globalThis,original);}};
}

test('opening a portrait fits the whole image, strips internal URL from caption and resets zoom for another image',()=>{
 const f=fixture();try{
  f.load();assert.equal(f.frame().props.style.width,300);assert.equal(f.frame().props.style.height,600);
  assert.equal(f.tree.root.findByType('img').props.alt,'#43');
  act(()=>f.button('Zoom in').props.onClick());assert.match(f.frame().props.style.transform,/scale\(1\.25\)/);
  f.update({url:'/api/media/61',kind:'photo'});f.load(2400,1200);
  assert.equal(f.frame().props.style.width,1000);assert.equal(f.frame().props.style.height,500);
  assert.equal(f.frame().props.style.transform,'translate(0px, 0px) scale(1)');
  assert.equal(f.observers[0].disconnected,true);
 }finally{f.restore();}
});

test('Ctrl-wheel zoom is non-passive and prevents browser zoom, while ordinary scrolling remains untouched',()=>{
 const f=fixture();try{
  f.load(2000,1200);let prevented=0;
  assert.equal(f.wheel.get('wheel').options.passive,false);
  const event={ctrlKey:false,deltaY:-100,deltaMode:0,clientX:650,clientY:400,preventDefault:()=>prevented++};
  act(()=>f.wheel.get('wheel').fn(event));assert.equal(prevented,0);assert.equal(f.stageNode().props['data-zoomed'],false);
  act(()=>f.wheel.get('wheel').fn({...event,ctrlKey:true}));assert.equal(prevented,1);assert.equal(f.stageNode().props['data-zoomed'],true);
  const [x,y,scale]=f.frame().props.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/).slice(1).map(Number);
  assert.ok(Math.abs(scale-Math.exp(.3))<1e-12);assert.ok(Math.abs((150-x)/scale-150)<1e-10);assert.ok(Math.abs((100-y)/scale-100)<1e-10);
  act(()=>f.button('Fit image').props.onClick());assert.equal(f.frame().props.style.transform,'translate(0px, 0px) scale(1)');
 }finally{f.restore();}
});

test('two touch pointers pinch to zoom and one remaining pointer pans within bounds without closing the viewer',()=>{
 const f=fixture();try{
  f.load(2000,1200);
  act(()=>f.stageNode().props.onPointerDown(f.pointer(1,400,300)));
  act(()=>f.stageNode().props.onPointerDown(f.pointer(2,600,300)));
  act(()=>f.stageNode().props.onPointerMove(f.pointer(2,800,300)));
  assert.equal(f.frame().props.style.transform,'translate(100px, 0px) scale(2)');
  assert.deepEqual(f.captures,[1,2]);
  act(()=>f.stageNode().props.onPointerUp(f.pointer(2,800,300)));
  act(()=>f.stageNode().props.onPointerMove(f.pointer(1,2000,2000)));
  assert.equal(f.frame().props.style.transform,'translate(500px, 300px) scale(2)');
  act(()=>f.stageNode().props.onPointerCancel(f.pointer(1,2000,2000)));
  assert.equal(f.stageNode().props['data-interacting'],false);
  act(()=>f.stageNode().props.onClick({target:f.stage,currentTarget:f.stage}));assert.equal(f.closed,0);
  act(()=>f.button('Fit image').props.onClick());
  act(()=>f.stageNode().props.onPointerDown(f.pointer(3,500,300,f.stage)));
  act(()=>f.stageNode().props.onPointerUp(f.pointer(3,500,300,f.stage)));
  act(()=>f.stageNode().props.onClick({target:f.stage,currentTarget:f.stage}));assert.equal(f.closed,1);
 }finally{f.restore();}
});

test('modal traps keyboard focus, handles Escape and restores focus, scrolling and event listeners on close',()=>{
 const f=fixture();try{
  assert.equal(f.doc.body.style.overflow,'hidden');assert.equal(f.doc.activeElement,f.buttons.get('Close media viewer'));
  assert.equal(f.keyboard.get('keydown').capture,true);let prevented=0,stopped=0;
  act(()=>f.keyboard.get('keydown').fn({key:'Tab',shiftKey:false,preventDefault:()=>prevented++}));
  assert.equal(f.doc.activeElement,f.buttons.get('Fit image'));assert.equal(prevented,1);
  act(()=>f.keyboard.get('keydown').fn({key:'Tab',shiftKey:true,preventDefault:()=>prevented++}));
  assert.equal(f.doc.activeElement,f.buttons.get('Close media viewer'));assert.equal(prevented,2);
  act(()=>f.keyboard.get('keydown').fn({key:'Escape',preventDefault:()=>prevented++,stopPropagation:()=>stopped++}));
  assert.equal(f.closed,1);assert.equal(stopped,1);
  f.update(null);assert.equal(f.doc.body.style.overflow,'auto');assert.equal(f.doc.activeElement,f.previous);
  assert.equal(f.keyboard.size,0);assert.equal(f.wheel.size,0);assert.equal(f.observers[0].disconnected,true);
 }finally{f.restore();}
});

test('a captured image click stays open while a fresh backdrop click closes at fit',()=>{
 const f=fixture();try{
  f.load();const image={};
  act(()=>f.stageNode().props.onPointerDown(f.pointer(1,500,300,image,'mouse')));
  act(()=>f.stageNode().props.onPointerUp(f.pointer(1,500,300,image,'mouse')));
  act(()=>f.stageNode().props.onClick({target:f.stage,currentTarget:f.stage}));assert.equal(f.closed,0);
  act(()=>f.stageNode().props.onPointerDown(f.pointer(2,0,0,f.stage,'mouse')));
  act(()=>f.stageNode().props.onPointerUp(f.pointer(2,0,0,f.stage,'mouse')));
  act(()=>f.stageNode().props.onClick({target:f.stage,currentTarget:f.stage}));assert.equal(f.closed,1);
 }finally{f.restore();}
});

test('switching from a pinched image to video clears gesture state so its backdrop still closes',()=>{
 const f=fixture();try{
  f.load(2000,1200);
  act(()=>f.stageNode().props.onPointerDown(f.pointer(1,400,300)));
  act(()=>f.stageNode().props.onPointerDown(f.pointer(2,600,300)));
  act(()=>f.stageNode().props.onPointerMove(f.pointer(2,800,300)));
  f.update({url:'/api/media/9',kind:'video'});
  act(()=>f.stageNode().props.onClick({target:f.stage,currentTarget:f.stage}));assert.equal(f.closed,1);
 }finally{f.restore();}
});

test('video and audio keep playback controls without installing image zoom gestures',()=>{
 for(const [kind,type] of [['video','video'],['animation','video'],['audio','audio'],['voice','audio']]){
  const f=fixture({url:'/api/media/9',kind});try{
   assert.equal(f.tree.root.findByType(type).props.controls,true);
   assert.equal(f.wheel.size,0);assert.equal(f.tree.root.findAllByProps({'aria-label':'Zoom in'}).length,0);
  }finally{f.restore();}
 }
});

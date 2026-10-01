import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import ts from 'typescript';
const require=createRequire(import.meta.url);
async function compile(path,dependencies={}){
 const source=await readFile(new URL(path,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};new Function('require','module','exports',js)(name=>dependencies[name]??require(name),module,module.exports);return module.exports;
}
const model=await compile('../src/lib/postTimeline.ts');
const {default:Timeline}=await compile('../src/components/PostTimeline.tsx',{'../lib/postTimeline':model,'../lib/media':{getMediaObjectUrl:async()=>''}});
const {default:VirtualList}=await compile('../src/components/VirtualizedMessageList.tsx');
const message=id=>({message_key:`1:${id}`,message_id:id,message_type:'Message',date_utc:`2024-01-${String(id).padStart(2,'0')}T10:00:00Z`,text:`Post ${id}`,entities:[],media_kind:null,media_path:null,media_present:false,external_urls:[]});
function environment(){
 const saved={document:globalThis.document,window:globalThis.window,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
 const frames=new Map();let id=0;
 globalThis.document={addEventListener(){},removeEventListener(){}};
 globalThis.window={dispatchEvent(){},scrollBy(){},matchMedia:()=>({matches:false})};
 globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;}observe(){this.fn([{contentRect:{width:390}}]);}disconnect(){}};
 globalThis.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 return {flush(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();},restore(){Object.assign(globalThis,saved);}};
}
function fixture(showPosts=true){
 const env=environment(),opened=[],listeners=new Map(),captured=new Set();
 const svg={getBoundingClientRect:()=>({left:0,width:390}),setPointerCapture:id=>captured.add(id),hasPointerCapture:id=>captured.has(id),releasePointerCapture:id=>captured.delete(id),focus(){},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 let root;act(()=>{root=Renderer.create(React.createElement(Timeline,{messages:[1,2,3,4].map(message),directoryHandle:null,onOpenMessage:key=>opened.push(key)}),{createNodeMock:element=>element.type==='svg'?svg:element.props.className==='post-timeline-plot'?{contains:()=>true}:{focus(){}}});});
 if(showPosts)act(()=>root.root.findByType('input').props.onChange({target:{checked:true}}));
 return {env,root,svg,opened,listeners,chart:()=>root.root.findAllByType('svg')[0],point:()=>root.root.findAll(node=>node.props.className?.startsWith('post-timeline-point'))[0],status:()=>root.root.findByProps({role:'status'}).children.join(''),close(){act(()=>root.unmount());env.restore();}};
}
test('pinch changes the timeline window and does not accidentally open a post',()=>{
 const f=fixture();try{
  const event=(id,x)=>({pointerType:'touch',pointerId:id,clientX:x,currentTarget:f.svg});
  act(()=>f.chart().props.onPointerDown(event(1,100)));
  act(()=>f.chart().props.onPointerDown(event(2,200)));
  act(()=>{f.chart().props.onPointerMove(event(2,300));f.env.flush();});
  assert.equal(f.status(),'2.0× zoom');
  const before=f.chart().findAllByProps({className:'post-timeline-axis'}).map(node=>node.children.join(''));
  act(()=>f.chart().props.onPointerUp(event(2,300)));
  act(()=>{f.chart().props.onPointerMove(event(1,50));f.env.flush();});
  const after=f.chart().findAllByProps({className:'post-timeline-axis'}).map(node=>node.children.join(''));
  assert.notDeepEqual(after,before,'remaining finger continues panning after pinch');
  act(()=>{f.chart().props.onPointerUp(event(1,100));f.chart().props.onPointerUp(event(2,300));f.point().props.onClick();});
  assert.deepEqual(f.opened,[]);
 }finally{f.close();}
});
test('touch tap previews first and the preview button opens the exact post',()=>{
 const f=fixture();try{
  act(()=>{f.point().props.onPointerDown({pointerType:'touch'});f.point().props.onClick();});
  assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,1);assert.deepEqual(f.opened,[]);
  const read=f.root.root.findAllByType('button').find(button=>button.props.className==='post-timeline-preview-action');
  act(()=>read.props.onClick());assert.deepEqual(f.opened,['1:1']);
 }finally{f.close();}
});
test('compact screen clicks only preview, including keyboard activation',()=>{
 const f=fixture();try{
  act(()=>{f.point().props.onPointerDown({pointerType:'mouse'});f.point().props.onClick();});
  assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,1);assert.deepEqual(f.opened,[]);
  act(()=>f.point().props.onKeyDown({key:'Enter',preventDefault(){},stopPropagation(){}}));assert.deepEqual(f.opened,[]);
 }finally{f.close();}
});
test('desktop hover preview is released when the pointer leaves',async()=>{
 const f=fixture();try{
  act(()=>f.point().props.onPointerEnter());assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,1);
  await act(async()=>{f.point().props.onPointerLeave({pointerType:'mouse'});await new Promise(resolve=>setTimeout(resolve,160));});
  assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,0);
 }finally{f.close();}
});
test('Ctrl wheel zooms the chart while ordinary wheel keeps normal page scrolling',()=>{
 const f=fixture();try{
  let prevented=0;
  const event={ctrlKey:false,clientX:195,deltaY:-100,deltaMode:0,preventDefault(){prevented++;},stopPropagation(){}};
  act(()=>{f.listeners.get('wheel')(event);f.env.flush();});assert.equal(f.status(),'1.0× zoom');assert.equal(prevented,0);
  act(()=>{f.listeners.get('wheel')({...event,ctrlKey:true});f.env.flush();});assert.equal(f.status(),'1.5× zoom');assert.equal(prevented,1);
 }finally{f.close();}
});
test('choosing any week updates the plotted date window',()=>{
 const f=fixture();try{
  act(()=>f.root.root.findByProps({'aria-label':'Time range'}).findAllByType('button').at(-1).props.onClick());
  act(()=>f.root.root.findByProps({'aria-label':'Choose any date in the timeline week'}).props.onChange({target:{value:'2024-01-15'}}));
  assert.match(f.root.root.findByProps({className:'post-timeline-footer'}).findAllByType('span')[0].children.join(''),/15 Jan 2024 – 21 Jan 2024/);
 }finally{f.close();}
});
test('far post navigation jumps instantly and mounts only nearby virtual rows',()=>{
 const env=environment(),calls=[],ref=React.createRef();let root;
 const container={clientHeight:640,scrollTop:0,querySelectorAll:()=>[],scrollTo(options){calls.push(options);this.scrollTop=options.top;}};
 try{
  act(()=>{root=Renderer.create(React.createElement(VirtualList,{ref,messages:Array.from({length:2000},(_,i)=>message(i+1)),renderMessage:m=>React.createElement('p',null,m.message_key)}),{createNodeMock:element=>element.props.className==='virtual-list-container'?container:{getBoundingClientRect:()=>({height:100}),querySelectorAll:()=>[]}});});
  act(()=>ref.current.scrollToIndex(1900));
  assert.ok(calls.length>0);assert.ok(calls.every(call=>call.behavior==='instant'));
  const rows=root.root.findAll(node=>node.props.className==='virtual-row');assert.ok(rows.length<50);
  assert.ok(rows.some(row=>row.props['data-row-key']==='1:1901'));
 }finally{if(root)act(()=>root.unmount());env.restore();}
});

test('arrow keys explore from empty chart space and move both directions',()=>{
 const f=fixture();try{
  const key=key=>({key,preventDefault(){},stopPropagation(){}});
  act(()=>f.chart().props.onKeyDown(key('ArrowRight')));
  assert.match(f.root.root.findByProps({role:'tooltip'}).findByType('strong').children.join(''),/#1/);
  act(()=>f.chart().props.onKeyDown(key('ArrowRight')));
  assert.match(f.root.root.findByProps({role:'tooltip'}).findByType('strong').children.join(''),/#2/);
  act(()=>f.chart().props.onKeyDown(key('ArrowLeft')));
  assert.match(f.root.root.findByProps({role:'tooltip'}).findByType('strong').children.join(''),/#1/);
  assert.deepEqual(f.opened,[]);
 }finally{f.close();}
});
test('desktop empty-space drag scrolls vertically and pans a zoomed timeline',()=>{
 const f=fixture();try{
  const scrolls=[];window.scrollBy=options=>scrolls.push(options.top);
  act(()=>{f.root.root.findByProps({'aria-label':'Zoom in timeline'}).props.onClick();f.env.flush();});
  const before=f.chart().findAllByProps({className:'post-timeline-axis'}).map(node=>node.children.join(''));
  const event=(x,y)=>({pointerType:'mouse',pointerId:1,button:0,clientX:x,clientY:y,target:{closest:()=>null},currentTarget:f.svg});
  act(()=>f.chart().props.onPointerDown(event(200,150)));
  act(()=>{f.chart().props.onPointerMove(event(140,100));f.env.flush();});
  const after=f.chart().findAllByProps({className:'post-timeline-axis'}).map(node=>node.children.join(''));
  assert.notDeepEqual(after,before);assert.deepEqual(scrolls,[50]);
  act(()=>f.chart().props.onPointerUp(event(140,100)));assert.deepEqual(f.opened,[]);
 }finally{f.close();}
});

test('reference default shows stacked areas and weekly bars; keyboard explores week summaries',()=>{
 const f=fixture(false);try{
  assert.equal(f.root.root.findAllByProps({className:'post-timeline-area'}).length,7);
  assert.equal(f.root.root.findAll(node=>node.props.className?.startsWith('post-timeline-point')).length,0);
  assert.ok(f.root.root.findAllByProps({className:'post-timeline-weekly'}).length);
  act(()=>f.chart().props.onKeyDown({key:'ArrowRight',preventDefault(){},stopPropagation(){}}));
  const popup=f.root.root.findByProps({role:'tooltip'});assert.equal(popup.findByProps({className:'post-timeline-week-total'}).children.join(''),'4 posts');
  assert.deepEqual(f.opened,[]);
  act(()=>popup.findAllByType('button').at(-1).props.onClick());
  assert.equal(f.root.root.findByProps({'aria-label':'Time range'}).findAllByType('button').at(-1).props['aria-pressed'],true);
  assert.equal(f.root.root.findByProps({className:'post-timeline-individual'}).findByType('input').props.checked,true);
  assert.ok(f.point());assert.deepEqual(f.opened,[]);
 }finally{f.close();}
});

test('weekly bar tap previews and never navigates directly',()=>{
 const f=fixture(false);try{
  const bar=f.root.root.findAll(node=>node.props.className?.startsWith('post-timeline-week-bar'))[0];
  act(()=>bar.props.onClick());assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,1);assert.deepEqual(f.opened,[]);
  act(()=>f.root.root.findByProps({'aria-label':'Dismiss week preview'}).props.onClick());assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,0);
 }finally{f.close();}
});

 test('clicked week stays open when the pointer leaves and crosses another week',async()=>{
 const f=fixture(false);try{
  const bars=()=>f.root.root.findAll(node=>node.props.className?.startsWith('post-timeline-week-bar'));
  act(()=>bars()[0].props.onClick());
  const title=f.root.root.findByProps({className:'post-timeline-preview-meta'}).findByType('span').children.join('');
  act(()=>bars()[0].props.onPointerLeave({pointerType:'mouse'}));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,180));});
  assert.equal(f.root.root.findAllByProps({role:'tooltip'}).length,1);
  if(bars()[1])act(()=>bars()[1].props.onPointerEnter());
  assert.equal(f.root.root.findByProps({className:'post-timeline-preview-meta'}).findByType('span').children.join(''),title);
  act(()=>f.root.root.findByProps({className:'post-timeline-preview-action'}).props.onClick());
  assert.equal(f.root.root.findByProps({'aria-label':'Time range'}).findAllByType('button').at(-1).props['aria-pressed'],true);
 }finally{f.close();}
});

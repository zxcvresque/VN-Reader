import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/ReadingLibrary.tsx',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const mod={exports:{}};
new Function('require','module','exports',js)(name=>name==='./CustomSelect'?{default:props=>React.createElement('select',props,props.children)}:name==='../lib/readingState'?{moveItem:()=>{throw Error('Not used');}}:require(name),mod,mod.exports);

test('collection chooser immediately includes newly saved posts and keeps passages distinct',()=>{
 let state={queue:[],statuses:{},notes:{},passages:[{id:'highlight',messageKey:'chat:1',text:'Selected words',note:''}],collections:[{id:'collection',title:'Ideas',introduction:'',items:[]}]};
 let savedPostKeys=[];
 const props=()=>({initialTab:'collections',state,savedPostKeys,messages:[{message_key:'chat:1',message_id:1,text:'A full post'}],onChange:next=>{state=next;},onOpenMessage:()=>{},onReadAround:()=>{}});
 let tree;
 act(()=>{tree=Renderer.create(React.createElement(mod.exports.default,props()));});
 try{
  const chooser=()=>tree.root.findAllByType('select').find(select=>select.findAllByType('option').some(option=>option.props.value==='passage:highlight'));
  const add=()=>tree.root.findAllByType('button').find(button=>button.children.join('')==='Add saved item');
  assert.equal(chooser().findAllByType('option').some(option=>option.props.value==='post:chat:1'),false);
  savedPostKeys=['chat:1'];
  act(()=>tree.update(React.createElement(mod.exports.default,props())));
  assert.equal(chooser().findAllByType('option').some(option=>option.props.value==='post:chat:1'),true);
  act(()=>chooser().props.onChange({target:{value:'post:chat:1'}}));
  assert.equal(add().props.disabled,false);
  act(()=>add().props.onClick());
  assert.equal(state.collections[0].items.length,1);
  assert.equal(state.collections[0].items[0].messageKey,'chat:1');
  assert.equal(state.collections[0].items[0].passageId,undefined);
  act(()=>tree.update(React.createElement(mod.exports.default,props())));
  act(()=>chooser().props.onChange({target:{value:'post:chat:1'}}));
  assert.equal(add().props.disabled,true);
  act(()=>chooser().props.onChange({target:{value:'passage:highlight'}}));
  assert.equal(add().props.disabled,false);
  act(()=>add().props.onClick());
  assert.equal(state.collections[0].items.length,2);
  assert.equal(state.collections[0].items[1].passageId,'highlight');
  act(()=>tree.update(React.createElement(mod.exports.default,props())));
  act(()=>chooser().props.onChange({target:{value:'passage:highlight'}}));
  assert.equal(add().props.disabled,true);
  assert.equal(tree.root.findAllByProps({'aria-label':'Collection order'}).length,0);
 }finally{act(()=>tree.unmount());}
});

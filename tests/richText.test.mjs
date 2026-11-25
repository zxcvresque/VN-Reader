import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/components/TelegramRichText.tsx',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText.replaceAll('"react/jsx-runtime"',JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href));
const {default:RichText}=await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const render=props=>renderToStaticMarkup(React.createElement(RichText,props));
test('paragraphs keep global UTF-16 offsets and formatting across boundaries',()=>{
 const html=render({text:'😀 First\n\nSecond',entities:[{_:'MessageEntityBold',offset:3,length:13}]});
 assert.match(html,/data-paragraph-offset="0"/);assert.match(html,/data-paragraph-offset="10"/);assert.match(html,/<strong>First<\/strong>/);assert.match(html,/<strong>Second<\/strong>/);
});
test('search highlighting does not turn a complete link into partial addresses',()=>{
 const text='https://example.com/research';const html=render({text,entities:[{_:'MessageEntityUrl',offset:0,length:text.length}],searchHighlight:'example'});
 assert.equal((html.match(/href="https:\/\/example.com\/research"/g)||[]).length,3);assert.match(html,/tg-search-highlight/);
});
test('quoted passage highlights take priority over search and personal passage marks',()=>{
 const html=render({text:'Attention',searchHighlight:'attention',savedPassageTexts:['Attention'],highlightRange:{offset:0,length:9}});
 assert.match(html,/tg-quote-highlight/);assert.doesNotMatch(html,/tg-search-highlight|tg-passage-highlight/);
});
test('saved passages highlight every matching occurrence without changing text',()=>{
 const html=render({text:'Return, then return.',savedPassageTexts:['return']});assert.equal((html.match(/class="tg-passage-highlight"/g)||[]).length,2);
});
test('literal URLs omit sentence punctuation and unsafe text links do not become anchors',()=>{
 assert.match(render({text:'Read https://example.com/guide.'}),/href="https:\/\/example.com\/guide"/);
 assert.doesNotMatch(render({text:'Read this',entities:[{_:'MessageEntityTextUrl',offset:0,length:9,url:'javascript:alert(1)'}]}),/<a /);
});

test('in-post quotes form one continuous block across formatting and paragraph boundaries',()=>{
 const text='Before\nQuoted bold and https://example.com\n\nSecond quote paragraph\nAfter';
 const start=text.indexOf('Quoted');const end=text.indexOf('\nAfter');
 const html=render({text,entities:[
  {_:'MessageEntityBlockquote',offset:start,length:end-start},
  {_:'MessageEntityBold',offset:text.indexOf('bold'),length:4},
  {_:'MessageEntityItalic',offset:start,length:end-start}
 ],searchHighlight:'quote'});
 assert.equal((html.match(/<blockquote/g)||[]).length,1);
 assert.match(html,/<blockquote class="tg-post-quote">/);
 assert.match(html,/<strong><em>bold<\/em><\/strong>/);
 assert.match(html,/href="https:\/\/example.com"/);
 assert.match(html,new RegExp(`data-paragraph-offset="${text.indexOf('Second')}"`));
 assert.ok(html.indexOf('Before')<html.indexOf('<blockquote'));
 assert.ok(html.indexOf('After')>html.indexOf('</blockquote>'));
 assert.doesNotMatch(html,/reader-quote-label|Quoted from|tg-inline-quote/);
});

test('adjacent quote entities stay separate and highlights keep UTF-16 offsets',()=>{
 const text='😀 One\nTwo\nEnd';
 const html=render({text,entities:[
  {_:'MessageEntityBlockquote',offset:3,length:4},
  {_:'MessageEntityBlockquote',offset:7,length:3}
 ],highlightRange:{offset:7,length:3}});
 assert.equal((html.match(/<blockquote/g)||[]).length,2);
 assert.match(html,/<mark class="tg-quote-highlight">Two<\/mark>/);
 assert.match(html,/data-text-offset="7"/);
});

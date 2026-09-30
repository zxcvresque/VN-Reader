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

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/lib/mediaViewport.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const mod={exports:{}};
new Function('require','module','exports',js)(require,mod,mod.exports);
const {fitMedia,constrainMedia,zoomMediaAt}=mod.exports;

test('portrait and landscape media fit fully inside the viewport without upscaling small images',()=>{
 assert.deepEqual(fitMedia({width:1200,height:2400},{width:1000,height:600}),{width:300,height:600});
 assert.deepEqual(fitMedia({width:2400,height:1200},{width:1000,height:600}),{width:1000,height:500});
 assert.deepEqual(fitMedia({width:320,height:180},{width:1000,height:600}),{width:320,height:180});
 assert.deepEqual(fitMedia({width:0,height:0},{width:1000,height:600}),{width:0,height:0});
});

test('pan bounds prevent empty space and keep an image centered on an axis where it still fits',()=>{
 const fitted={width:300,height:600},viewport={width:1000,height:600};
 assert.deepEqual(constrainMedia({scale:2,x:2000,y:-2000},fitted,viewport),{scale:2,x:0,y:-300});
 assert.deepEqual(constrainMedia({scale:4,x:-2000,y:2000},fitted,viewport),{scale:4,x:-100,y:900});
 assert.deepEqual(constrainMedia({scale:0,x:50,y:50},fitted,viewport),{scale:1,x:0,y:0});
 assert.deepEqual(constrainMedia({scale:100,x:0,y:0},fitted,viewport),{scale:8,x:0,y:0});
});

test('zoom preserves the point under the cursor until an edge bound is reached and fit resets pan',()=>{
 const size={width:1000,height:600};
 const current={scale:2,x:40,y:-20},point={x:100,y:80};
 const next=zoomMediaAt(current,3,point,size,size);
 assert.deepEqual(next,{scale:3,x:10,y:-70});
 assert.equal((point.x-next.x)/next.scale,(point.x-current.x)/current.scale);
 assert.equal((point.y-next.y)/next.scale,(point.y-current.y)/current.scale);
 assert.deepEqual(zoomMediaAt(next,1,point,size,size),{scale:1,x:0,y:0});
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/cloudMerge.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {mergeDocuments} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('independent devices merge notes and preferences without losing either edit', () => {
 const base={notes:{a:'old',b:'old'},preferences:{theme:'opal',nav:'top'}};
 const local={notes:{a:'new',b:'old'},preferences:{theme:'vercel',nav:'top'}};
 const remote={notes:{a:'old',b:'other'},preferences:{theme:'opal',nav:'left'}};
 assert.deepEqual(mergeDocuments(base,local,remote),{data:{notes:{a:'new',b:'other'},preferences:{theme:'vercel',nav:'left'}},conflicts:[]});
});
test('deletions survive remote changes in other notes', () => {
 assert.deepEqual(mergeDocuments({notes:{a:'x',b:'y'}},{notes:{b:'y'}},{notes:{a:'x',b:'z'}}),{data:{notes:{b:'z'}},conflicts:[]});
});
test('same-field edits and competing list ordering require reader choice', () => {
 const merged=mergeDocuments({notes:{a:'old'},queue:['a','b']},{notes:{a:'local'},queue:['b','a']},{notes:{a:'remote'},queue:['a']});
 assert.deepEqual(merged.conflicts,['notes.a','queue']);
});
test('identical edits and object key reordering do not conflict', () => {
 assert.deepEqual(mergeDocuments({a:1,b:2},{b:2,a:3},{a:3,b:2}),{data:{b:2,a:3},conflicts:[]});
});

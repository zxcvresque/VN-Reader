import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import { createAccounts } from '../server/accounts.mjs';
const require=createRequire(import.meta.url);
const compile=(path,dependencies={})=>{
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{fileName:path,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};new Function('require','module','exports',js)(name=>dependencies[name]??require(name),module,module.exports);return module.exports;
};
const apiModule=compile('../src/lib/api.ts');
test('signup preserves a chosen name and uses Reader when the optional name is blank',async()=>{
 const oldFetch=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response('{}',{headers:{'Content-Type':'application/json'}});};
 try{
  await apiModule.authRequest('register',{email:'reader@example.com',password:'unchanged-password',name:'  Vidur daas  '});
  await apiModule.authRequest('register',{email:'guest@example.com',password:'unchanged-password',name:'   '});
  assert.equal(requests[0].url,'/api/auth/sign-up/email');assert.deepEqual(requests[0].body,{email:'reader@example.com',password:'unchanged-password',name:'Vidur daas'});assert.equal(requests[1].body.name,'Reader');
 }finally{globalThis.fetch=oldFetch;}
});
test('archive conditional GET exposes ETag, avoids JSON parsing on 304 and retains API errors',async()=>{
 const oldFetch=globalThis.fetch,requests=[];let step=0;
 globalThis.fetch=async(url,options)=>{
  requests.push({url,options});
  if(++step===1)return new Response(JSON.stringify({manifest:{chat_id:-100},messages:[]}),{headers:{'Content-Type':'application/json',ETag:'"revision-1"'}});
  if(step===2)return new Response(null,{status:304});
  return new Response(JSON.stringify({detail:'Archive unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
 };
 try{
  const first=await apiModule.fetchSiteArchive();assert.equal(first.etag,'"revision-1"');
  assert.equal(await apiModule.fetchSiteArchive(first.etag),null);
  assert.equal(requests[1].url,'/api/archive');assert.equal(requests[1].options.headers['If-None-Match'],'"revision-1"');assert.equal(requests[1].options.credentials,'same-origin');
  await assert.rejects(apiModule.fetchSiteArchive(),error=>error instanceof apiModule.ApiError&&error.status===503&&error.message==='Archive unavailable');
 }finally{globalThis.fetch=oldFetch;}
});
async function panelFixture({user=null,initialMode='register',updateName=async()=>{},register=async()=>({})}={}){
 const oldDocument=globalThis.document,oldWindow=globalThis.window,requests=[];let begins=0;
 globalThis.document={body:{style:{overflow:''}},activeElement:null,addEventListener(){},removeEventListener(){}};
 globalThis.window={setTimeout:()=>1,clearTimeout(){}};
 const api={...apiModule,api:async()=>({allowed:false}),authRequest:async(action,body)=>{requests.push({action,body});return register(action,body);}};
 const {default:ReaderAccount}=compile('../src/components/ReaderAccount.tsx',{'../lib/api':api,'./SignupCapacity':{default:()=>null}});
 const account={user,status:'saved',config:{accountsEnabled:true},conflicts:[],message:'',guestImport:null,ready:true,beginAuthentication:()=>{begins++;},updateName};
 let root;await act(async()=>{root=Renderer.create(React.createElement(ReaderAccount,{account,initialMode,onClose(){}}));});
 return {root,requests,get begins(){return begins;},close(){act(()=>root.unmount());globalThis.document=oldDocument;globalThis.window=oldWindow;}};
}
test('signup offers an optional display name and forwards it with unchanged email and password fields',async()=>{
 const f=await panelFixture();
 try{
  const inputs=f.root.root.findAllByType('input');
  assert.equal(inputs.find(input=>input.props.type==='text').props.required,undefined);
  await act(async()=>{
   inputs.find(input=>input.props.type==='text').props.onChange({target:{value:'Vidur'}});
   inputs.find(input=>input.props.type==='email').props.onChange({target:{value:'reader@example.com'}});
   inputs.find(input=>input.props.type==='password').props.onChange({target:{value:'unchanged-password'}});
  });
  await act(async()=>f.root.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(f.begins,1);assert.deepEqual(f.requests,[{action:'register',body:{email:'reader@example.com',password:'unchanged-password',name:'Vidur'}}]);
 }finally{f.close();}
});
test('account profile edits call updateName without signing in again',async()=>{
 const saved=[];const f=await panelFixture({user:{id:'u',email:'reader@example.com',name:'Vidur'},updateName:async name=>saved.push(name)});
 try{
  const input=f.root.root.findByProps({type:'text'});assert.equal(input.props.value,'Vidur');
  await act(async()=>input.props.onChange({target:{value:'Vidur daas'}}));
  await act(async()=>f.root.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(saved,['Vidur daas']);assert.deepEqual(f.requests,[]);assert.equal(f.begins,0);
  assert.match(JSON.stringify(f.root.toJSON()),/Your display name is saved/);
 }finally{f.close();}
});
test('Better Auth updates the signed-in display name while preserving reading state and password login',async()=>{
 const mail=[];const accounts=await createAccounts({database:':memory:',secret:'test-only-secret-with-more-than-thirty-two-characters',baseURL:'http://reader.test',origins:['http://reader.test'],production:false},message=>mail.push(message));
 const request=(path,body,cookie='')=>accounts.auth.handler(new Request(`http://reader.test/api/auth/${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin:'http://reader.test',cookie,'x-forwarded-for':'192.0.2.21'},body:body===undefined?undefined:JSON.stringify(body)}));
 try{
  const credentials={email:'profile@example.com',password:'a-strong-test-password'};
  assert.equal((await request('sign-up/email',{...credentials,name:'Chosen signup name'})).status,200);
  const verified=await request('email-otp/verify-email',{email:credentials.email,otp:mail[0].otp});assert.equal(verified.status,200);
  const user=(await verified.json()).user;assert.equal(user.name,'Chosen signup name');
  const cookie=verified.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const reading={format:'vn-reader-reading-state',version:1,chatId:-100,readingState:{chatId:-100,notes:{post:'keep my unsynced meaning'}}};accounts.states.put(user.id,'-100',reading,0);
  assert.equal((await request('update-user',{name:'Updated name'},cookie)).status,200);
  const session=await (await request('get-session',undefined,cookie)).json();assert.equal(session.user.name,'Updated name');assert.equal(session.user.email,credentials.email);assert.equal(session.user.id,user.id);
  assert.deepEqual(accounts.states.get(user.id,'-100'),{revision:1,data:reading});
  assert.equal((await request('update-user',{name:'No session'})).status,401);
  assert.equal((await request('sign-in/email',credentials)).status,200);
 }finally{accounts.close();}
});

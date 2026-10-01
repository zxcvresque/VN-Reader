import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAccountApp } from '../server/accountService.mjs';

const settings={database:':memory:',secret:'test-only-secret-at-least-thirty-two-characters',baseURL:'http://reader.test',origins:['http://reader.test'],production:false,archiveEnabled:true};
async function fixture(enabled=true){
 const mail=[];const {app,accounts}=await createAccountApp(settings,enabled?m=>mail.push(m):undefined);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,{method='GET',body,cookie='',headers={}}={})=>fetch(base+path,{method,headers:{origin:'http://reader.test','x-vn-csrf':'1','content-type':'application/json',cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});
 async function signup(email){const r=await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Reader',email,password:'strong-test-password-123'}});assert.equal(r.status,200);const otp=mail.find(m=>m.email===email).otp;const v=await request('/api/auth/email-otp/verify-email',{method:'POST',body:{email,otp}});assert.equal(v.status,200);return v.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');}
 return {request,signup,close:async()=>{await new Promise(resolve=>server.close(resolve));accounts.close();}};
}
test('HTTP middleware enforces verified sessions, origin, CSRF, account isolation and save revisions',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await (await f.request('/api/config')).json(),{accountsEnabled:true,archiveEnabled:true});
  assert.equal((await f.request('/api/state/-100')).status,401);
  const cookie=await f.signup('first@example.com');const other=await f.signup('second@example.com');
  const doc={format:'vn-reader-reading-state',version:1,chatId:-100,readingState:{chatId:-100,notes:{post:'note'}}};
  const put={method:'PUT',cookie,body:{data:doc},headers:{'if-match':'"0"'}};
  assert.equal((await f.request('/api/state/-100',{...put,headers:{...put.headers,'x-vn-csrf':''}})).status,403);
  assert.equal((await f.request('/api/state/-100',{...put,headers:{...put.headers,origin:'http://other.test'}})).status,403);
  assert.equal((await f.request('/api/state/-100',{...put,headers:{}})).status,428);
  const saved=await f.request('/api/state/-100',put);assert.equal(saved.status,200);assert.equal(saved.headers.get('etag'),'"1"');
  assert.equal((await f.request('/api/state/-100',put)).status,409);
  assert.deepEqual(await (await f.request('/api/state/-100',{cookie:other})).json(),{revision:0,data:null});
  assert.equal((await f.request('/api/state/not-a-chat',{cookie})).status,422);
  assert.equal((await f.request('/api/auth/sign-in/email',{method:'POST',body:{padding:'x'.repeat(9000)}})).status,413);
  const logOut=await f.request('/api/auth/sign-out',{method:'POST',cookie,body:{}});assert.equal(logOut.status,200);
  assert.equal((await f.request('/api/state/-100',{cookie})).status,401);
 }finally{await f.close();}
});
test('HTTP endpoints truthfully report disabled accounts and preserve guest access',async()=>{
 const f=await fixture(false);try{
  assert.deepEqual(await (await f.request('/api/config')).json(),{accountsEnabled:false,archiveEnabled:true});
  assert.equal(await (await f.request('/api/auth/get-session')).json(),null);
  assert.equal((await f.request('/api/auth/sign-up/email',{method:'POST',body:{}})).status,503);
  assert.equal((await f.request('/api/state/-100')).status,503);
 }finally{await f.close();}
});

test('two password sessions for one verified account share progress through HTTP while another account stays separate', async () => {
 const f = await fixture();
 try {
  const phone = await f.signup('sync@example.com');
  const login = await f.request('/api/auth/sign-in/email', { method:'POST', body:{email:'sync@example.com',password:'strong-test-password-123'} });
  assert.equal(login.status,200);
  const desktop = login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  assert.notEqual(phone,desktop);
  const other = await f.signup('private@example.com');
  const doc = {format:'vn-reader-reading-state',version:1,chatId:-100,preferences:{theme:'vercel'},bookmarks:[{message_key:'post'}],readingState:{chatId:-100,positions:{post:{offset:137,updatedAt:'2026-10-01T10:00:00Z'}},notes:{post:'My thought'},queue:['post'],collections:[{id:'c',name:'Ideas'}]}};
  const saved = await f.request('/api/state/-100', {method:'PUT',cookie:phone,body:{data:doc},headers:{'if-match':'"0"'}});
  assert.equal(saved.status,200);
  assert.deepEqual(await (await f.request('/api/state/-100',{cookie:desktop})).json(),{revision:1,data:doc});
  const edited = {...doc,readingState:{...doc.readingState,notes:{post:'Updated on desktop'}}};
  assert.equal((await f.request('/api/state/-100',{method:'PUT',cookie:desktop,body:{data:edited},headers:{'if-match':'"1"'}})).status,200);
  assert.deepEqual(await (await f.request('/api/state/-100',{cookie:phone})).json(),{revision:2,data:edited});
  assert.deepEqual(await (await f.request('/api/state/-100',{cookie:other})).json(),{revision:0,data:null});
 } finally { await f.close(); }
});

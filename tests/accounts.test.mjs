import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccounts, StateError } from '../server/accounts.mjs';

const settings={database:':memory:',secret:'test-only-secret-with-more-than-thirty-two-characters',baseURL:'http://reader.test',origins:['http://reader.test'],production:false};
async function fixture(production=false){
 const mail=[];const accounts=await createAccounts({...settings,production},m=>mail.push(m));
 const request=(path,body,cookie='')=>accounts.auth.handler(new Request('http://reader.test/api/auth/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin:'http://reader.test',cookie,'x-forwarded-for':'192.0.2.10'},body:body===undefined?undefined:JSON.stringify(body)}));
 const signup=async(email='reader@example.com')=>{const response=await request('sign-up/email',{name:'Reader',email,password:'a-strong-test-password'});assert.equal(response.status,200);return mail.find(m=>m.email===email&&m.type==='email-verification').otp;};
 const verify=async(email,otp)=>{const response=await request('email-otp/verify-email',{email,otp});assert.equal(response.status,200);return {user:(await response.json()).user,cookie:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),headers:response.headers.getSetCookie()};};
 return {...accounts,mail,request,signup,verify};
}
test('password signup requires a hashed six-digit OTP; session is HttpOnly and OTP cannot be replayed',async()=>{
 const f=await fixture();try{
  const otp=await f.signup();assert.match(otp,/^\d{6}$/);
  const stored=f.database.prepare('SELECT value FROM verification').all();assert.ok(stored.every(v=>!v.value.includes(otp)));
  assert.equal((await f.request('sign-in/email',{email:'reader@example.com',password:'a-strong-test-password'})).status,403);
  assert.equal((await f.request('email-otp/verify-email',{email:'reader@example.com',otp:'invalid'})).status,400);
  const verified=await f.verify('reader@example.com',otp);assert.equal(verified.user.emailVerified,true);assert.ok(verified.headers.some(c=>/httponly/i.test(c)));
  const session=await f.request('get-session',undefined,verified.cookie);assert.equal((await session.json()).user.email,'reader@example.com');
  assert.equal((await f.request('email-otp/verify-email',{email:'reader@example.com',otp})).status,400);
  await f.request('sign-out',{},verified.cookie);assert.equal(await (await f.request('get-session',undefined,verified.cookie)).json(),null);
 }finally{f.close();}
});
test('OTP password reset changes the password and revokes prior sessions',async()=>{
 const f=await fixture();try{
  const otp=await f.signup();const verified=await f.verify('reader@example.com',otp);
  assert.equal((await f.request('email-otp/request-password-reset',{email:'reader@example.com'})).status,200);
  const reset=f.mail.find(m=>m.type==='forget-password');assert.ok(reset);
  assert.equal((await f.request('email-otp/reset-password',{email:'reader@example.com',otp:reset.otp,password:'my-new-strong-test-password'})).status,200);
  assert.equal(await (await f.request('get-session',undefined,verified.cookie)).json(),null);
  assert.equal((await f.request('sign-in/email',{email:'reader@example.com',password:'a-strong-test-password'})).status,401);
  assert.equal((await f.request('sign-in/email',{email:'reader@example.com',password:'my-new-strong-test-password'})).status,200);
 }finally{f.close();}
});
test('state is isolated by account and archive, rejects stale saves, and preserves tombstones',async()=>{
 const f=await fixture();try{
  const a=await f.verify('reader@example.com',await f.signup());const b=await f.verify('second@example.com',await f.signup('second@example.com'));
  const doc={format:'vn-reader-reading-state',version:1,chatId:-100,readingState:{chatId:-100,notes:{a:'original'}}};
  assert.deepEqual(f.states.get(a.user.id,'-100'),{revision:0,data:null});
  assert.equal(f.states.put(a.user.id,'-100',doc,0).revision,1);
  assert.deepEqual(f.states.get(b.user.id,'-100'),{revision:0,data:null});
  assert.throws(()=>f.states.put(a.user.id,'-100',doc,0),e=>e instanceof StateError&&e.status===409);
  const deleted={...doc,readingState:{chatId:-100,notes:{}}};f.states.put(a.user.id,'-100',deleted,1);
  assert.deepEqual(f.states.get(a.user.id,'-100').data.readingState.notes,{});
  assert.throws(()=>f.states.put(a.user.id,'-200',doc,0),e=>e.status===422);
  assert.throws(()=>f.states.put(a.user.id,'-100',{...doc,text:'x'.repeat(1024*1024)},2),e=>e.status===413);
 }finally{f.close();}
});
test('production sessions are secure and OTP attempts are bounded',async()=>{
 const f=await fixture(true);try{
  const otp=await f.signup();const verified=await f.verify('reader@example.com',otp);assert.ok(verified.headers.some(c=>/secure/i.test(c)&&/httponly/i.test(c)));
  const other=await f.signup('second@example.com');for(let i=0;i<5;i++)assert.notEqual((await f.request('email-otp/verify-email',{email:'second@example.com',otp:other==='000000'?'111111':'000000'})).status,200);
  assert.notEqual((await f.request('email-otp/verify-email',{email:'second@example.com',otp:other})).status,200);
 }finally{f.close();}
});
test('missing email configuration disables live accounts',async()=>{
 const f=await createAccounts(settings);try{assert.equal(f.enabled,false);}finally{f.close();}
});

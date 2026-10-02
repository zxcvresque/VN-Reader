import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNotifier} from '../server/notifications.mjs';
import {createAccounts} from '../server/accounts.mjs';
test('operator events target the logs topic and throttle repeated failures',async()=>{
 const calls=[];const notify=createNotifier({botToken:'test',logTopicId:'42',logDestination:'-1001'},async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};});
 await notify('Media delivery failed','ConnectionError');await notify('Media delivery failed','ConnectionError');
 assert.equal(calls.length,1);assert.equal(calls[0].message_thread_id,42);assert.equal(calls[0].chat_id,'-1001');
});
test('successful signup emits an event without email, password or OTP',async()=>{
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};};
 const accounts=await createAccounts({database:':memory:',secret:'test-secret-of-at-least-thirty-two-characters',baseURL:'http://reader.test',origins:['http://reader.test'],production:false,botToken:'test',logTopicId:'42',logDestination:'-1001'},async()=>{});
 try {
 const response=await accounts.auth.handler(new Request('http://reader.test/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://reader.test'},body:JSON.stringify({name:'Reader',email:'private@example.com',password:'a-strong-test-password'})}));
 assert.equal(response.status,200);assert.ok(calls.some(c=>c.text.includes('Account created')));assert.ok(calls.every(c=>!c.text.includes('private@example.com')&&!c.text.includes('a-strong-test-password')));
 }finally{accounts.close();globalThis.fetch=previous;}
});
test('account events use authenticated internal relay and do not expose bot URL',async()=>{
 const calls=[];
 const notify=createNotifier({botToken:'test-secret',eventUrl:'http://archive:8000/internal/events'},async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true})};});
 await notify('Account created','A new reader signed up.',0);
 assert.equal(calls[0].url,'http://archive:8000/internal/events');
 assert.equal(calls[0].options.headers.Authorization,'Bearer test-secret');
 assert.deepEqual(JSON.parse(calls[0].options.body),{event:'Account created',detail:'A new reader signed up.'});
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNotifier,formatOperatorEvent} from '../server/notifications.mjs';
import {createAccounts} from '../server/accounts.mjs';
test('operator events target the logs topic and throttle repeated failures',async()=>{
 const calls=[];const notify=createNotifier({botToken:'test',logTopicId:'42',logDestination:'-1001'},async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};});
 await notify('Media delivery failed','ConnectionError');await notify('Media delivery failed','ConnectionError');
 assert.equal(calls.length,1);assert.equal(calls[0].message_thread_id,42);assert.equal(calls[0].chat_id,'-1001');
 await notify('Media delivery failed','ConnectionError',300000,{severity:'critical'});assert.equal(calls.length,2);assert.match(calls[1].text,/#critical #media/);
});
test('signup, verification and login identify the reader without exposing credentials',async()=>{
 const previous=globalThis.fetch,calls=[],mail=[];
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};};
 const accounts=await createAccounts({database:':memory:',secret:'test-secret-of-at-least-thirty-two-characters',baseURL:'http://reader.test',origins:['http://reader.test'],production:false,botToken:'test',logTopicId:'42',logDestination:'-1001'},async message=>mail.push(message));
 try {
 const request=(path,body)=>accounts.auth.handler(new Request(`http://reader.test/api/auth/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://reader.test','x-forwarded-for':'192.0.2.10'},body:JSON.stringify(body)}));
 const response=await request('sign-up/email',{name:'Reader <admin> & friend',email:'private@example.com',password:'a-strong-test-password'});
 assert.equal(response.status,200);const user=(await response.json()).user;
 const signup=calls.find(c=>c.text.includes('Account created'));assert.ok(signup);assert.equal(signup.parse_mode,'HTML');
 assert.match(signup.text,/#signup/);assert.match(signup.text,/Reader &lt;admin&gt; &amp; friend/);assert.ok(signup.text.includes('private@example.com'));assert.ok(signup.text.includes(user.id));
 assert.equal((await request('email-otp/verify-email',{email:user.email,otp:'invalid'})).status,400);
 assert.equal(calls.filter(c=>c.text.includes('Email verified')).length,0);
 assert.equal((await request('email-otp/verify-email',{email:user.email,otp:mail[0].otp})).status,200);
 const verified=calls.find(c=>c.text.includes('Email verified'));assert.match(verified.text,/#signup #verification #login/);assert.ok(verified.text.includes(user.id));
 assert.equal((await request('sign-in/email',{email:user.email,password:'wrong-password'})).status,401);
 const rejected=calls.find(c=>c.text.includes('Reader login rejected'));assert.ok(rejected);assert.match(rejected.text,/#login/);assert.match(rejected.text,/INVALID_EMAIL_OR_PASSWORD/);
 assert.equal(calls.filter(c=>c.text.includes('Reader signed in')).length,0);
 const login=await request('sign-in/email',{email:user.email,password:'a-strong-test-password'});assert.equal(login.status,200);const session=await login.json();
 const signedIn=calls.find(c=>c.text.includes('Reader signed in'));assert.ok(signedIn.text.includes(user.email));assert.ok(signedIn.text.includes(user.id));
 assert.ok(calls.every(c=>!c.text.includes('a-strong-test-password')&&!c.text.includes('wrong-password')&&!c.text.includes(mail[0].otp)&&!c.text.includes(session.token)));
 const duplicate=await request('sign-up/email',{name:'Duplicate',email:user.email,password:'a-strong-test-password'});assert.equal(duplicate.status,200);
 assert.equal(calls.filter(c=>c.text.includes('Account created')).length,1);
 }finally{accounts.close();globalThis.fetch=previous;}
});
test('account events use authenticated internal relay and do not expose bot URL',async()=>{
 const calls=[];
 const notify=createNotifier({botToken:'test-secret',eventUrl:'http://archive:8000/internal/events'},async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true})};});
 await notify('Account created','A new reader signed up.',0);
 assert.equal(calls[0].url,'http://archive:8000/internal/events');
 assert.equal(calls[0].options.headers.Authorization,'Bearer test-secret');
 assert.deepEqual(JSON.parse(calls[0].options.body),{event:'Account created',detail:'A new reader signed up.',severity:'routine'});
});
test('only critical events reach owner DM and repeated critical failures are throttled',async()=>{
 const calls=[];const notify=createNotifier({botToken:'test',logTopicId:'4523',logDestination:'-1001',ownerId:'5988446905'},async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};});
 await notify('Account created','A new reader signed up.',0);
 assert.equal(calls.length,1);assert.equal(calls[0].chat_id,'-1001');
 await notify('Account request failed','Internal error.',0,{severity:'critical'});
 await notify('Account request failed','Internal error.',0,{severity:'critical'});
 const owner=calls.filter(call=>call.chat_id==='5988446905');
 assert.equal(owner.length,1);assert.equal(owner[0].message_thread_id,undefined);assert.match(owner[0].text,/#critical #account/);assert.equal(owner[0].parse_mode,'HTML');
});
test('critical owner alert bypasses unavailable archive relay and missing logs config',async()=>{
 const calls=[];const notify=createNotifier({botToken:'test',eventUrl:'http://archive:8000/internal/events',ownerId:'5988446905'},async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(url.includes('/internal/'))throw new Error('offline');return {ok:true,json:async()=>({ok:true})};});
 await notify('Account service fatal','Service stopping.',300000,{severity:'critical'});
 assert.ok(calls.some(call=>call.body.chat_id==='5988446905'));
 const direct=[];const withoutTopic=createNotifier({botToken:'test',ownerId:'5988446905'},async(url,options)=>{direct.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};});
 await withoutTopic('Account service startup failed','',300000,{severity:'critical'});
 assert.equal(direct.length,1);assert.equal(direct[0].chat_id,'5988446905');
});
test('failed notification delivery cannot reject account operations or leak transport errors',async()=>{
 const notify=createNotifier({botToken:'test',ownerId:'5988446905'},async()=>{throw new Error('sensitive transport error');});
 await assert.doesNotReject(()=>notify('Account service fatal','Service stopping.',300000,{severity:'critical'}));
});
test('critical relay preserves severity and bounded allowlisted fields',async()=>{
 const calls=[];const notify=createNotifier({botToken:'test',eventUrl:'http://archive/internal/events'},async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};});
 await notify('OTP email delivery failed','Provider refused the email.',0,{severity:'critical',fields:{email:'reader@example.com',purpose:'Email verification',error:'ECONNECTION',password:'never-send',reader:'x'.repeat(500)}});
 assert.equal(calls[0].severity,'critical');assert.equal(calls[0].fields.reader.length,128);assert.equal(calls[0].fields.password,undefined);assert.equal(calls[0].fields.email,'reader@example.com');
});
test('formatting escapes markup, uses quotes and bold labels without truncating HTML',()=>{
 assert.equal(formatOperatorEvent('Account created','Signed up <today> & verified.','routine',{reader:'A <b> B\nC',email:'a@example.com',readerId:'123',otp:'secret'}),'<b>vn reader · Account created</b>\n#signup\n\n<blockquote>Signed up &lt;today&gt; &amp; verified.</blockquote>\n\n<b>Reader:</b> A &lt;b&gt; B C\n<b>Email:</b> a@example.com\n<b>Reader ID:</b> 123');
 const long=formatOperatorEvent('Account created','<'.repeat(500),'routine',{reader:'<'.repeat(500)});assert.ok(long.endsWith('&lt;'));assert.ok(!long.includes('secret'));
});

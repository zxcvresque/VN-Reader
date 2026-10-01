import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminStore,deliveryFailureIsDefinitive } from "../server/adminStore.mjs";
import { createAccounts } from "../server/accounts.mjs";

const base={database:":memory:",secret:"test-only-secret-with-more-than-thirty-two-characters",baseURL:"http://reader.test",origins:["http://reader.test"],production:false};
async function fixture(extra={},sender) {
  const mail=[];const a=await createAccounts({...base,...extra},sender??(message=>mail.push(message)));
  let ip=1;
  const request=(path,body)=>a.auth.handler(new Request(`http://reader.test/api/auth/${path}`,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",origin:"http://reader.test","x-forwarded-for":`192.0.2.${ip++}`},body:body===undefined?undefined:JSON.stringify(body)}));
  const signup=email=>request("sign-up/email",{name:"Reader",email,password:"a-strong-test-password"});
  const verify=email=>request("email-otp/verify-email",{email,otp:mail.findLast(m=>m.email===email&&m.type==="email-verification").otp});
  return {...a,request,signup,verify,mail};
}
test("daily allowance atomically admits only the limit and persists reservations",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"vn-quota-")),path=join(directory,"quota.sqlite");
  const db=new DatabaseSync(path);let store=new AdminStore(db,{emailDailyLimit:3});
  const results=await Promise.allSettled(Array.from({length:12},(_,index)=>Promise.resolve().then(()=>store.reserve(`r${index}@example.com`))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal(store.capacity(true).remaining,0);
  db.close();const reopened=new DatabaseSync(path);store=new AdminStore(reopened,{emailDailyLimit:3});assert.equal(store.capacity(true).used,3);reopened.close();rmSync(directory,{recursive:true});
});
test("quota follows configured local calendar including DST and rolls over without erasing history",()=>{
  const db=new DatabaseSync(":memory:");let now=new Date("2026-03-08T06:59:00Z");const store=new AdminStore(db,{emailDailyLimit:1,emailQuotaTimezone:"America/New_York",now:()=>now});
  store.reserve("a@example.com");assert.equal(store.dayAt(),"2026-03-08");const range=store.range("2026-03-08");assert.equal(range.end-range.start,23*3600000);assert.equal(store.capacity(true).resetsAt,"2026-03-09T04:00:00.000Z");
  now=new Date("2026-03-09T04:00:00Z");assert.equal(store.capacity(true).used,0);assert.equal(store.usage("2026-03-08"),1);assert.throws(()=>store.range("2026-02-30"));db.close();
});
test("full signup allowance creates no stranded user and can recover next day",async()=>{
  let now=new Date("2026-10-01T12:00:00Z");const f=await fixture({emailDailyLimit:1,now:()=>now});
  try {assert.equal((await f.signup("one@example.com")).status,200);assert.equal(f.admin.capacity(true).used,1);
    assert.equal((await f.signup("two@example.com")).status,429);assert.equal(f.database.prepare("SELECT id FROM user WHERE email='two@example.com'").get(),undefined);
    now=new Date("2026-10-02T00:00:00Z");assert.equal((await f.signup("two@example.com")).status,200);assert.equal((await f.verify("two@example.com")).status,200);
  }finally{f.close();}
});
test("rejected SMTP releases allowance and removes only the failed new signup; ambiguous delivery retains a slot",async()=>{
  let fail=true;const f=await fixture({emailDailyLimit:1},()=>{if(fail)throw Object.assign(new Error("not accepted"),{responseCode:550,command:"DATA"});});
  try {assert.equal((await f.signup("reject@example.com")).status,503);assert.equal(f.admin.capacity(true).used,0);assert.equal(f.database.prepare("SELECT id FROM user WHERE email='reject@example.com'").get(),undefined);
    fail=false;assert.equal((await f.signup("reject@example.com")).status,200);assert.equal(f.admin.capacity(true).used,1);assert.equal(f.admin.dashboard().summary.failed,1);
  }finally{f.close();}
  const ambiguous=await fixture({emailDailyLimit:1},()=>{throw Object.assign(new Error("lost SMTP response"),{code:"ETIMEDOUT",command:"DATA"});});
  try {assert.equal((await ambiguous.signup("uncertain@example.com")).status,503);assert.equal(ambiguous.admin.capacity(true).used,1);assert.equal(ambiguous.admin.dashboard().summary.uncertain,1);}finally{ambiguous.close();}
  assert.equal(deliveryFailureIsDefinitive({code:"ETIMEDOUT",command:"CONN"}),true);assert.equal(deliveryFailureIsDefinitive({code:"ETIMEDOUT",command:"DATA"}),false);
});
test("signup, OTP resend and password reset all count; password login and failed login do not",async()=>{
  const f=await fixture({emailDailyLimit:4,adminEmails:["ADMIN@EXAMPLE.COM"]});
  try {assert.equal((await f.signup("admin@example.com")).status,200);assert.equal((await f.verify("admin@example.com")).status,200);
    assert.equal((await f.request("email-otp/send-verification-otp",{email:"admin@example.com",type:"email-verification"})).status,200);
    assert.equal((await f.request("email-otp/request-password-reset",{email:"admin@example.com"})).status,200);assert.equal(f.admin.capacity(true).used,3);
    assert.equal((await f.request("sign-in/email",{email:"admin@example.com",password:"wrong-password"})).status,401);
    assert.equal((await f.request("sign-in/email",{email:"admin@example.com",password:"a-strong-test-password"})).status,200);
    const dashboard=f.admin.dashboard();assert.equal(dashboard.summary.registrations,1);assert.equal(dashboard.summary.signIns,2);assert.equal(dashboard.summary.uniqueSignIns,1);assert.equal(dashboard.users[0].signInCount,2);assert.deepEqual(new Set(dashboard.signIns.map(s=>s.kind)),new Set(["password","verification"]));assert.equal(f.admin.capacity(true).used,3);
    assert.equal(f.admin.allowed({email:"ADMIN@example.com",emailVerified:true}),true);assert.equal(f.admin.allowed({email:"admin@example.com",emailVerified:false}),false);assert.equal(f.admin.allowed({email:"other@example.com",emailVerified:true}),false);
    const serialized=JSON.stringify(dashboard);assert.ok(!serialized.includes("passwordHash")&&!serialized.includes("token"));
  }finally{f.close();}
});
test("concurrent real signups cannot race past allowance or create blocked accounts",async()=>{
  const f=await fixture({emailDailyLimit:2});try {
    const responses=await Promise.all(Array.from({length:8},(_,i)=>f.signup(`race${i}@example.com`)));
    assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(responses.filter(r=>r.status===429).length,6);assert.equal(f.mail.length,2);assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM user").get().count,2);assert.equal(f.admin.capacity(true).used,2);
  }finally{f.close();}
});
test("invalid signup releases admission and dashboard pagination bounds user data",async()=>{
  const f=await fixture({emailDailyLimit:1,emailQuotaTimezone:"Asia/Kolkata"});try {
    assert.equal((await f.request("sign-up/email",{name:"Reader",email:"invalid@example.com",password:"short"})).status,400);assert.equal(f.admin.capacity(true).used,0);
    assert.equal((await f.signup("valid@example.com")).status,200);
    const insert=f.database.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)");
    for(let i=0;i<104;i++)insert.run(`reader-${i}`,"Reader",`p${i}@example.com`,1,"2026-10-01T20:00:00.000Z","2026-10-01T20:00:00.000Z");
    const page1=f.admin.dashboard("2026-10-02",1),page2=f.admin.dashboard("2026-10-02",2);assert.equal(page1.users.length,100);assert.equal(page2.users.length,5);assert.equal(page1.summary.registrations,104);assert.equal(page1.pagination.totalUsers,105);assert.equal(new Set([...page1.users,...page2.users].map(u=>u.id)).size,105);assert.throws(()=>f.admin.dashboard("2026-10-01",0));
  }finally{f.close();}
});
test("a caller cannot reuse an internal reservation header to bypass the daily allowance",async()=>{
  const f=await fixture({emailDailyLimit:1});try {
    const reservation=f.admin.reserve("blocked@example.com");
    const response=await f.auth.handler(new Request("http://reader.test/api/auth/sign-up/email",{
      method:"POST",headers:{"content-type":"application/json",origin:"http://reader.test","x-vn-email-reservation":reservation},
      body:JSON.stringify({name:"Reader",email:"blocked@example.com",password:"a-strong-test-password"})
    }));
    assert.equal(response.status,429);assert.equal(f.mail.length,0);
    assert.equal(f.database.prepare("SELECT id FROM user WHERE email='blocked@example.com'").get(),undefined);
    assert.equal(f.admin.deliveryStatus(reservation),"reserved");assert.equal(f.admin.capacity(true).used,1);
  }finally{f.close();}
});

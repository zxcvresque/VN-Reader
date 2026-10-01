import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAccountApp } from "../server/accountService.mjs";

test("admin HTTP endpoints enforce verified allowlisted sessions and never disclose users through public capacity",async()=>{
  const mail=[];const {app,accounts}=await createAccountApp({database:":memory:",secret:"test-only-secret-at-least-thirty-two-characters",baseURL:"http://reader.test",origins:["http://reader.test"],production:false,archiveEnabled:true,adminEmails:["ADMIN@EXAMPLE.COM"],emailDailyLimit:10},m=>mail.push(m));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,cookie="")=>fetch(base+path,{method:body===undefined?"GET":"POST",headers:{origin:"http://reader.test","x-vn-csrf":"1","content-type":"application/json",cookie},body:body===undefined?undefined:JSON.stringify(body)});
  const signup=async email=>{const r=await request("/api/auth/sign-up/email",{name:"Reader",email,password:"strong-test-password-123"});assert.equal(r.status,200);};
  const verify=async email=>{const r=await request("/api/auth/email-otp/verify-email",{email,otp:mail.findLast(m=>m.email===email).otp});assert.equal(r.status,200);return r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");};
  try {
    assert.equal((await request("/api/admin/dashboard")).status,401);assert.deepEqual(await(await request("/api/admin/access")).json(),{allowed:false});
    await signup("admin@example.com");assert.equal((await request("/api/admin/dashboard")).status,401);
    const admin=await verify("admin@example.com");await signup("reader@example.com");const reader=await verify("reader@example.com");
    assert.deepEqual(await(await request("/api/admin/access",undefined,reader)).json(),{allowed:false});assert.equal((await request("/api/admin/dashboard",undefined,reader)).status,403);
    assert.deepEqual(await(await request("/api/admin/access",undefined,admin)).json(),{allowed:true});
    const capacityResponse=await request("/api/signup-capacity"),capacity=await capacityResponse.json();assert.equal(capacity.used,2);assert.equal(capacity.remaining,8);assert.equal(capacity.scope,"VN Reader email allowance");assert.equal(capacityResponse.headers.get("cache-control"),"no-store");assert.ok(!JSON.stringify(capacity).includes("@"));
    const dashboardResponse=await request("/api/admin/dashboard",undefined,admin),dashboard=await dashboardResponse.json();assert.equal(dashboardResponse.status,200);assert.equal(dashboardResponse.headers.get("cache-control"),"no-store");assert.equal(dashboard.summary.signIns,2);assert.equal(dashboard.summary.uniqueSignIns,2);assert.equal(dashboard.summary.registrations,2);assert.equal(dashboard.users.length,2);assert.equal(dashboard.pagination.totalUsers,2);
    assert.equal((await request("/api/admin/dashboard?day=2026-02-30",undefined,admin)).status,422);assert.equal((await request("/api/admin/dashboard?page=0",undefined,admin)).status,422);
    const previous=await(await request("/api/admin/dashboard?day=2000-01-01",undefined,admin)).json();assert.equal(previous.summary.signIns,0);assert.equal(previous.summary.registrations,0);assert.equal(previous.summary.used,0);assert.equal(previous.users.length,2);
    await request("/api/auth/sign-out",{},admin);assert.equal((await request("/api/admin/dashboard",undefined,admin)).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));accounts.close();}
});

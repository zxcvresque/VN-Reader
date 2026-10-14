import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAccountApp } from "../server/accountService.mjs";
import { accountSettings } from "../server/accounts.mjs";

test("R2 admin routes reach the configured archive and report upstream failures without expiring the session",async()=>{
  const calls=[];
  const upstream=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    calls.push({path:req.url,method:req.method,authorization:req.headers.authorization,body:body?JSON.parse(body):null});
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true,enabled:true}));
  });
  upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
  const archiveURL=`http://127.0.0.1:${upstream.address().port}`;
  assert.equal(accountSettings({VN_ARCHIVE_URL:archiveURL}).archiveURL,archiveURL);
  const mail=[];
  const {app,accounts}=await createAccountApp({database:":memory:",secret:"test-only-secret-at-least-thirty-two-characters",baseURL:"http://reader.test",origins:["http://reader.test"],production:false,archiveEnabled:true,archiveURL,botToken:"test-internal-token",ownerId:"1234",adminEmails:["admin@example.com"],emailDailyLimit:10},m=>mail.push(m));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,cookie="")=>fetch(base+path,{method:body===undefined?"GET":"POST",headers:{origin:"http://reader.test","x-vn-csrf":"1","content-type":"application/json",cookie},body:body===undefined?undefined:JSON.stringify(body)});
  const login=async(email)=>{
    assert.equal((await request("/api/auth/sign-up/email",{name:"Reader",email,password:"strong-test-password-123"})).status,200);
    const r=await request("/api/auth/email-otp/verify-email",{email,otp:mail.findLast(m=>m.email===email).otp});
    assert.equal(r.status,200);return r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
  };
  try {
    const routes=["r2-stats","r2-analytics","r2-control"];
    for(const route of routes)assert.equal((await request(`/api/admin/${route}`,route==="r2-control"?{action:"r2_refresh"}:undefined)).status,401);
    const reader=await login("reader@example.com");
    for(const route of routes)assert.equal((await request(`/api/admin/${route}`,route==="r2-control"?{action:"r2_refresh"}:undefined,reader)).status,403);
    assert.equal(calls.length,0);
    const admin=await login("admin@example.com");
    for(const route of routes){
      const r=await request(`/api/admin/${route}`,route==="r2-control"?{action:"r2_pause_writes",sender_id:9999}:undefined,admin);
      assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
    }
    assert.deepEqual(calls.map(c=>c.path),["/api/r2-stats","/api/r2-analytics","/api/r2-control"]);
    assert.ok(calls.every(c=>c.authorization==="Bearer test-internal-token"));
    assert.deepEqual(calls[2].body,{action:"r2_pause_writes",sender_id:1234});
    assert.equal(calls[2].method,"POST");
    await new Promise(resolve=>upstream.close(resolve));
    for(const route of routes){
      const r=await request(`/api/admin/${route}`,route==="r2-control"?{action:"r2_refresh"}:undefined,admin);
      assert.equal(r.status,502);assert.match((await r.json()).detail,/archive storage service/);
    }
    assert.deepEqual(await(await request("/api/admin/access",undefined,admin)).json(),{allowed:true});
  }finally{
    if(upstream.listening)await new Promise(resolve=>upstream.close(resolve));
    await new Promise(resolve=>server.close(resolve));accounts.close();
  }
});

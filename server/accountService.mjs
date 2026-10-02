import express from "express";
import { createNotifier } from "./notifications.mjs";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { createAccounts, accountSettings, StateError } from "./accounts.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

export async function createAccountApp(settings=accountSettings(),sendEmail) {
  const accounts=await createAccounts(settings,sendEmail);const app=express();app.disable("x-powered-by");
  const origins=new Set([...settings.origins,new URL(settings.baseURL).origin]);
  app.use((req,res,next)=>{
    // Production accepts traffic only from the private reverse proxy.
    // In development use the actual socket instead of a caller-controlled value.
    if(!settings.production||!req.headers["x-forwarded-for"])req.headers["x-forwarded-for"]=req.socket.remoteAddress;
    res.set({"X-Content-Type-Options":"nosniff","Referrer-Policy":"same-origin","Cache-Control":"no-store"});
    if(!["GET","HEAD","OPTIONS"].includes(req.method)){
      if(!origins.has(req.headers.origin)||req.headers["x-vn-csrf"]!=="1")return res.status(403).json({detail:"This request did not pass the browser security check."});
      const limit=req.path.startsWith("/api/state/")?1024*1024+4096:8192;
      if(Number(req.headers["content-length"]??0)>limit)return res.status(413).json({detail:"Request too large."});
    }
    next();
  });
  app.all("/api/auth/*splat",(req,res,next)=>{
    if(!accounts.enabled){if(req.path==="/api/auth/get-session")return res.json(null);return res.status(503).json({detail:"Email delivery is not connected yet. You can continue reading as a guest."});}
    return toNodeHandler(accounts.auth)(req,res,next);
  });
  app.use(express.json({limit:"1mb"}));
  app.get("/api/config",(req,res)=>res.json({accountsEnabled:accounts.enabled,archiveEnabled:settings.archiveEnabled}));
  app.get("/api/health",(req,res)=>res.json({status:"ok",accountsEnabled:accounts.enabled}));
  app.get("/api/signup-capacity",(req,res)=>res.json(accounts.admin.capacity(accounts.enabled)));
  app.get("/api/admin/access",async(req,res)=>{
    try {const session=accounts.enabled?await accounts.auth.api.getSession({headers:fromNodeHeaders(req.headers)}):null;res.json({allowed:accounts.admin.allowed(session?.user)});}
    catch {res.json({allowed:false});}
  });
  app.get("/api/admin/dashboard",async(req,res)=>{
    try {
      const session=accounts.enabled?await accounts.auth.api.getSession({headers:fromNodeHeaders(req.headers)}):null;
      if(!session?.user?.emailVerified)return res.status(401).json({detail:"Sign in with a verified email to view administration."});
      if(!accounts.admin.allowed(session.user))return res.status(403).json({detail:"This account does not have administrator access."});
      const day=req.query.day??accounts.admin.dayAt(),page=req.query.page??"1";
      if(typeof day!=="string"||typeof page!=="string"||!/^\d+$/.test(page))return res.status(422).json({detail:"Invalid day or page."});
      try {res.json(accounts.admin.dashboard(day,Number(page)));}catch {res.status(422).json({detail:"Invalid day or page. Use YYYY-MM-DD and a positive page number."});}
    }catch {res.status(401).json({detail:"Your session has expired. Sign in again."});}
  });
  app.use("/api/state",async(req,res,next)=>{
    if(!accounts.enabled)return res.status(503).json({detail:"Accounts are not configured."});
    try{const session=await accounts.auth.api.getSession({headers:fromNodeHeaders(req.headers)});if(!session?.user?.emailVerified)return res.status(401).json({detail:"Sign in with a verified email to sync your reading state."});req.readerUser=session.user;next();}catch{res.status(401).json({detail:"Your session has expired. Sign in again."});}
  });
  const checkId=(id)=>/^-?\d{1,16}$/.test(id);
  app.get("/api/state/:chatId",(req,res)=>{
    if(!checkId(req.params.chatId))return res.status(422).json({detail:"Invalid archive ID."});
    const state=accounts.states.get(req.readerUser.id,req.params.chatId);res.set("ETag",`"${state.revision}"`).json(state);
  });
  app.put("/api/state/:chatId",(req,res,next)=>{
    if(!checkId(req.params.chatId))return res.status(422).json({detail:"Invalid archive ID."});
    const match=req.headers["if-match"];if(match===undefined)return res.status(428).json({detail:"Fetch your saved state and include its revision in If-Match."});
    const revision=String(match).replace(/^"|"$/g,"");if(!/^\d+$/.test(revision))return res.status(422).json({detail:"Invalid revision."});
    try{const state=accounts.states.put(req.readerUser.id,req.params.chatId,req.body?.data,Number(revision));res.set("ETag",`"${state.revision}"`).json(state);}catch(e){next(e);}
  });
  app.use((error,req,res,next)=>{if(!(error instanceof StateError)&&!error.type&&!(error instanceof SyntaxError))void accounts.notify("Account request failed","An internal request could not be completed.",300000,{severity:"critical"});res.status(error instanceof StateError?error.status:error.type==="entity.too.large"?413:error instanceof SyntaxError?422:500).json({detail:error instanceof StateError?error.message:error.type==="entity.too.large"?"Request too large.":error instanceof SyntaxError?"Invalid JSON.":"The account service could not complete this request."});});
  return {app,accounts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  loadEnv({path:process.env.VN_ENV_FILE??"server/.env",quiet:true});
  const settings=accountSettings();
  const bootNotify=createNotifier(settings);
  try {
  const {app,accounts}=await createAccountApp(settings);
  const server=app.listen(settings.port,settings.host,(error)=>{
    if(error){console.error("Account service could not listen");void bootNotify("Account service startup failed","Could not bind the service port.",300000,{severity:"critical"}).finally(()=>{accounts.close();process.exitCode=1;});return;}
    void accounts.notify("Account service started");
    console.log(`VN Reader account service listening on ${settings.host}:${settings.port}`);
  });
  let failing=false;
  const fatal=()=>{
    if(failing)return;failing=true;
    console.error("Account service fatal error; restarting is required");
    server.close();
    const deadline=setTimeout(()=>process.exit(1),9000);deadline.unref();
    void bootNotify("Account service fatal","The account service is stopping after an unexpected error.",300000,{severity:"critical"}).finally(()=>process.exit(1));
  };
  process.once("uncaughtException",fatal);
  process.once("unhandledRejection",fatal);
  for(const signal of ["SIGTERM","SIGINT"])process.once(signal,()=>server.close(()=>{accounts.close();process.exit(0);}));
  }catch {
    console.error("Account service startup failed");
    await bootNotify("Account service startup failed","The account service could not initialize.",300000,{severity:"critical"});
    process.exitCode=1;
  }
}

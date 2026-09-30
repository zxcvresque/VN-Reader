import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";

export function accountSettings(env=process.env) {
  return { database:env.VN_ACCOUNT_DATABASE_PATH??"data/accounts.sqlite3", secret:env.BETTER_AUTH_SECRET,
    baseURL:env.BETTER_AUTH_URL??"http://127.0.0.1:5173", production:env.VN_ENV!=="development",
    origins:(env.VN_ALLOWED_ORIGINS??"http://127.0.0.1:5173,http://localhost:5173").split(",").map(s=>s.trim()).filter(Boolean),
    smtpHost:env.VN_SMTP_HOST, smtpPort:Number(env.VN_SMTP_PORT??587), smtpUser:env.VN_SMTP_USERNAME,
    smtpPassword:env.VN_SMTP_PASSWORD, smtpFrom:env.VN_SMTP_FROM, smtpSSL:env.VN_SMTP_SSL==="true",
    archiveEnabled:env.VN_ARCHIVE_ENABLED!==undefined?env.VN_ARCHIVE_ENABLED==="true":!!(env.TELEGRAM_SOURCE&&env.TELEGRAM_DESTINATION&&env.TELEGRAM_BOT_TOKEN),
    port:Number(env.VN_ACCOUNT_PORT??3005), host:env.VN_ACCOUNT_HOST??"127.0.0.1" };
}

export async function createAccounts(settings=accountSettings(), sendEmail) {
  const enabled=!!(settings.secret?.length>=32 && (sendEmail || (settings.smtpHost&&settings.smtpFrom)));
  mkdirSync(dirname(settings.database),{recursive:true,mode:0o700});
  const database=new DatabaseSync(settings.database);
  if(settings.database!==":memory:")chmodSync(settings.database,0o600);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;");
  const transport=sendEmail?null:nodemailer.createTransport({host:settings.smtpHost,port:settings.smtpPort,
    secure:settings.smtpSSL,requireTLS:!settings.smtpSSL,auth:settings.smtpUser?{user:settings.smtpUser,pass:settings.smtpPassword}:undefined,
    connectionTimeout:10000,socketTimeout:20000});
  const options={appName:"VN Reader",baseURL:settings.baseURL,basePath:"/api/auth",
    secret:settings.secret??randomBytes(32).toString("hex"),database,
    trustedOrigins:[...new Set([new URL(settings.baseURL).origin,...settings.origins])],
    emailAndPassword:{enabled:true,requireEmailVerification:true,minPasswordLength:12,maxPasswordLength:128,revokeSessionsOnPasswordReset:true},
    emailVerification:{sendOnSignUp:true,autoSignInAfterVerification:true},
    session:{expiresIn:30*86400,updateAge:86400,cookieCache:{enabled:false}},
    advanced:{useSecureCookies:settings.production,ipAddress:{ipAddressHeaders:["x-forwarded-for"]}},
    rateLimit:{enabled:true,window:60,max:30,storage:"database",customRules:{
      "/sign-up/email":{window:60,max:5},"/sign-in/email":{window:60,max:10},
      "/email-otp/send-verification-otp":{window:60,max:2},"/email-otp/request-password-reset":{window:60,max:2},
      "/email-otp/verify-email":{window:60,max:10}}},
    plugins:[emailOTP({otpLength:6,expiresIn:600,allowedAttempts:5,storeOTP:"hashed",disableSignUp:true,
      overrideDefaultEmailVerification:true,sendVerificationOnSignUp:true,
      async sendVerificationOTP({email,otp,type}){
        if(!enabled)throw new Error("Email delivery is not configured.");
        const purpose=type==="forget-password"?"reset your password":"verify your email";
        if(sendEmail)return sendEmail({email,otp,type});
        await transport.sendMail({from:settings.smtpFrom,to:email,subject:`VN Reader · ${type==="forget-password"?"Password reset":"Verify your email"}`,
          text:`Your VN Reader code is ${otp}. Use it to ${purpose}. It expires in 10 minutes. If you didn't request this, ignore this email.`});
      }})]
  };
  await (await getMigrations(options)).runMigrations();
  const auth=betterAuth(options);
  const context=await auth.$context;
  await context.checkSchema?.();
  database.exec(`CREATE TABLE IF NOT EXISTS reader_states (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, chat_id TEXT NOT NULL,
    revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,chat_id));`);
  return {auth,database,enabled,states:new StateStore(database),close:()=>{transport?.close();database.close();}};
}

export class StateError extends Error {constructor(status,message){super(message);this.status=status;}}
export class StateStore {
  constructor(database){this.database=database;}
  get(userId,chatId){const row=this.database.prepare("SELECT revision,data FROM reader_states WHERE user_id=? AND chat_id=?").get(userId,chatId);return row?{revision:row.revision,data:JSON.parse(row.data)}:{revision:0,data:null};}
  put(userId,chatId,data,revision){
    if(!Number.isSafeInteger(revision)||revision<0)throw new StateError(422,"Invalid saved-state revision.");
    if(!data||typeof data!=="object"||Array.isArray(data)||data.format!=="vn-reader-reading-state"||data.version!==1||String(data.chatId)!==chatId||String(data.readingState?.chatId)!==chatId)throw new StateError(422,"This reading state belongs to a different archive or has an unsupported format.");
    const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>1024*1024)throw new StateError(413,"Reading state exceeds the 1 MB sync limit. Export a backup to preserve all your work.");
    this.database.exec("BEGIN IMMEDIATE");
    try{
      const current=this.get(userId,chatId);if(current.revision!==revision)throw new StateError(409,"Another device changed your reading state. Fetch the current revision before saving.");
      const next=revision+1;this.database.prepare("INSERT INTO reader_states VALUES (?,?,?,?,?) ON CONFLICT(user_id,chat_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at").run(userId,chatId,next,serialized,new Date().toISOString());
      this.database.exec("COMMIT");return {revision:next,data};
    }catch(e){this.database.exec("ROLLBACK");throw e;}
  }
}

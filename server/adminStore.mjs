import { randomUUID, createHash } from "node:crypto";

export class AllowanceError extends Error { constructor(message) { super(message); this.status=429; } }
const fingerprint=email=>createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
export class AdminStore {
  constructor(database,{emailDailyLimit=300,emailQuotaTimezone="UTC",adminEmails=[],now=()=>new Date()}={}) {
    if(!Number.isSafeInteger(emailDailyLimit)||emailDailyLimit<1)throw new Error("VN_EMAIL_DAILY_LIMIT must be a positive integer.");
    this.formatter=new Intl.DateTimeFormat("en-CA",{timeZone:emailQuotaTimezone,year:"numeric",month:"2-digit",day:"2-digit"});
    this.database=database;this.limit=emailDailyLimit;this.timezone=emailQuotaTimezone;this.now=now;
    this.adminEmails=new Set(adminEmails.map(email=>email.toLowerCase().trim()).filter(Boolean));
    database.exec(`CREATE TABLE IF NOT EXISTS email_allowance (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, email_hash TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS email_allowance_day ON email_allowance(day,status);
      CREATE TABLE IF NOT EXISTS reader_sign_ins (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      occurred_at INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reader_sign_ins_time ON reader_sign_ins(occurred_at);`);
  }
  dayAt(date=this.now()) { const parts=this.formatter.formatToParts(date);return ["year","month","day"].map(key=>parts.find(p=>p.type===key).value).join("-"); }
  range(day) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new Error("Invalid day. Use YYYY-MM-DD.");
    const boundary=target=>{let low=Date.parse(target)-36*3600000,high=Date.parse(target)+36*3600000;
      while(high-low>1){const mid=Math.floor((low+high)/2);if(this.dayAt(new Date(mid))<target)low=mid;else high=mid;}return high;};
    const next=new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
    return {start:boundary(day),end:boundary(next)};
  }
  usage(day=this.dayAt()) {return Number(this.database.prepare("SELECT COUNT(*) AS count FROM email_allowance WHERE day=? AND status IN ('reserved','accepted','unknown')").get(day).count);}
  capacity(configured,day=this.dayAt()) {const used=this.usage(day);return {limit:this.limit,used,remaining:Math.max(0,this.limit-used),resetsAt:new Date(this.range(day).end).toISOString(),timezone:this.timezone,configured,scope:"VN Reader email allowance"};}
  reserve(email) {
    // One conditional write remains atomic across connections and can safely run
    // inside Better Auth's own SQLite transaction without nesting BEGINs.
    const day=this.dayAt(),id=randomUUID(),time=this.now().getTime();
    const result=this.database.prepare(`INSERT INTO email_allowance SELECT ?,?,?,?,?,?
      WHERE (SELECT COUNT(*) FROM email_allowance WHERE day=? AND status IN ('reserved','accepted','unknown'))<?`).run(id,day,fingerprint(email),"reserved",time,time,day,this.limit);
    if(!result.changes)throw new AllowanceError("Today's email allowance is full. Continue as a guest or try again after the daily reset.");return id;
  }
  reservation(id,email) {return id&&this.database.prepare("SELECT id FROM email_allowance WHERE id=? AND email_hash=? AND status='reserved'").get(id,fingerprint(email))?.id;}
  complete(id,status) {this.database.prepare("UPDATE email_allowance SET status=?,updated_at=? WHERE id=? AND status='reserved'").run(status,this.now().getTime(),id);}
  deliveryStatus(id) {return this.database.prepare("SELECT status FROM email_allowance WHERE id=?").get(id)?.status;}
  allowed(user) {return !!(user?.emailVerified&&this.adminEmails.has(user.email.toLowerCase()));}
  recordSession(session,kind) {if(session?.user?.emailVerified&&session.session?.id)this.database.prepare("INSERT OR IGNORE INTO reader_sign_ins VALUES (?,?,?,?)").run(session.session.id,session.user.id,this.now().getTime(),kind);}
  dashboard(day=this.dayAt(),page=1) {
    const {start,end}=this.range(day);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new Error("Invalid page.");
    const totalUsers=Number(this.database.prepare("SELECT COUNT(*) AS count FROM user").get().count);
    const eventTotals=this.database.prepare("SELECT COUNT(*) AS count,COUNT(DISTINCT user_id) AS uniqueCount FROM reader_sign_ins WHERE occurred_at>=? AND occurred_at<?").get(start,end);
    const registrations=Number(this.database.prepare("SELECT COUNT(*) AS count FROM user WHERE julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)").get(new Date(start).toISOString(),new Date(end).toISOString()).count);
    const used=this.usage(day),offset=(page-1)*100;
    const users=this.database.prepare(`SELECT u.id,u.email,u.emailVerified,u.createdAt,MAX(s.occurred_at) AS lastSignIn,COUNT(s.id) AS signInCount
      FROM user u LEFT JOIN reader_sign_ins s ON s.user_id=u.id GROUP BY u.id ORDER BY u.createdAt DESC,u.id LIMIT 100 OFFSET ?`).all(offset).map(u=>({...u,emailVerified:!!u.emailVerified,createdAt:new Date(u.createdAt).toISOString(),lastSignIn:u.lastSignIn?new Date(u.lastSignIn).toISOString():null}));
    const signIns=this.database.prepare(`SELECT s.id,u.email,s.occurred_at AS occurredAt,s.kind FROM reader_sign_ins s JOIN user u ON u.id=s.user_id
      WHERE s.occurred_at>=? AND s.occurred_at<? ORDER BY s.occurred_at DESC,s.id LIMIT 100 OFFSET ?`).all(start,end,offset).map(s=>({...s,occurredAt:new Date(s.occurredAt).toISOString()}));
    const delivery=this.database.prepare("SELECT status,COUNT(*) AS count FROM email_allowance WHERE day=? GROUP BY status").all(day);
    return {summary:{day,timezone:this.timezone,limit:this.limit,used,remaining:Math.max(0,this.limit-used),registrations,signIns:Number(eventTotals.count),uniqueSignIns:Number(eventTotals.uniqueCount),accepted:delivery.find(d=>d.status==='accepted')?.count??0,failed:delivery.find(d=>d.status==='failed')?.count??0,uncertain:delivery.find(d=>d.status==='unknown')?.count??0},users,signIns,pagination:{page,pageSize:100,totalUsers,totalSignIns:Number(eventTotals.count)}};
  }
}
// SMTP rejection or a connection failure before SMTP DATA means no message was accepted.
// A lost DATA response is ambiguous and continues to consume an allowance slot.
export function deliveryFailureIsDefinitive(error) {
  return Number(error?.responseCode)>=400||["EAUTH","EENVELOPE","EDNS","ECONNECTION"].includes(error?.code)||["CONN","EHLO","HELO","AUTH","MAIL FROM","RCPT TO"].includes(error?.command);
}

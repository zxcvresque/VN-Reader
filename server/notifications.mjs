// Private operator events include account identity, never credentials or reader content.
import schema from "./operatorEvents.json" with {type:"json"};
const escapeHTML=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const clip=(value,limit)=>Array.from(value).slice(0,limit).join("");
export function operatorFields(fields={}) {
  return Object.fromEntries(Object.entries(schema.fields).filter(([key])=>typeof fields[key]==="string"&&fields[key]).map(([key,{limit}])=>[key,clip(fields[key].replace(/[\r\n\t]/g," "),limit)]));
}
export function formatOperatorEvent(event,detail="",severity="routine",fields={}) {
  const tags=[...(severity==="critical"?["critical"]:[]),...(schema.events[event]??["system"])];
  const lines=[`<b>vn reader · ${escapeHTML(clip(event,80))}</b>`,tags.map(tag=>`#${tag}`).join(" ")];
  if(detail)lines.push("",`<blockquote>${escapeHTML(clip(detail,200))}</blockquote>`);
  const values=Object.entries(operatorFields(fields));
  if(values.length)lines.push("",...values.map(([key,value])=>`<b>${schema.fields[key].label}:</b> ${escapeHTML(value)}`));
  return lines.join("\n");
}
export function createNotifier({botToken,logTopicId,logDestination,eventUrl,ownerId},fetchImpl=fetch) {
  const last=new Map();
  async function send(key,url,body,headers,cooldown) {
    const now=Date.now();if(now-(last.get(key)??-Infinity)<cooldown)return;
    last.set(key,now);
    try {
      const response=await fetchImpl(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},signal:AbortSignal.timeout(8000),body:JSON.stringify(body)});
      if(!response.ok||!(await response.json()).ok)throw new Error("Notification rejected");
    }catch {console.warn("Operator notification could not be delivered");}
  }
  return async(event,detail="",cooldown=300000,{severity="routine",fields={}}={})=>{
    if(!["routine","critical"].includes(severity))throw new Error("Unsupported notification severity");
    if(!botToken)return;
    const tasks=[];const values=operatorFields(fields);const text=formatOperatorEvent(event,detail,severity,values);
    if(eventUrl||logTopicId&&logDestination)tasks.push(send(`topic:${severity}:${event}`,eventUrl??`https://api.telegram.org/bot${botToken}/sendMessage`,eventUrl?{event,detail:clip(detail,200),severity,...(Object.keys(values).length?{fields:values}:{})}:{chat_id:logDestination,message_thread_id:Number(logTopicId),text,parse_mode:"HTML"},eventUrl?{Authorization:`Bearer ${botToken}`}:{},cooldown));
    // Send directly so a failed archive relay cannot suppress a critical owner alert.
    if(severity==="critical"&&/^\d+$/.test(String(ownerId??"")))tasks.push(send(`owner:${event}`,`https://api.telegram.org/bot${botToken}/sendMessage`,{chat_id:String(ownerId),text,parse_mode:"HTML"},{},Math.max(300000,cooldown)));
    await Promise.all(tasks);
  };
}

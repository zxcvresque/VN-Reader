// Operator events exclude email addresses, OTPs, passwords, and saved reader content.
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
  return async(event,detail="",cooldown=300000,{severity="routine"}={})=>{
    if(!botToken)return;
    const tasks=[];const text=`vn reader · ${event}\n${detail}`.slice(0,1000);
    if(eventUrl||logTopicId&&logDestination)tasks.push(send(`topic:${event}`,eventUrl??`https://api.telegram.org/bot${botToken}/sendMessage`,eventUrl?{event,detail:detail.slice(0,200)}:{chat_id:logDestination,message_thread_id:Number(logTopicId),text},eventUrl?{Authorization:`Bearer ${botToken}`}:{},cooldown));
    // Send directly so a failed archive relay cannot suppress a critical owner alert.
    if(severity==="critical"&&/^\d+$/.test(String(ownerId??"")))tasks.push(send(`owner:${event}`,`https://api.telegram.org/bot${botToken}/sendMessage`,{chat_id:String(ownerId),text:`CRITICAL · ${text}`},{},Math.max(300000,cooldown)));
    await Promise.all(tasks);
  };
}

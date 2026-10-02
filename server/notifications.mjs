// Operator events exclude email addresses, OTPs, passwords, and saved reader content.
export function createNotifier({botToken,logTopicId,logDestination,eventUrl},fetchImpl=fetch) {
  const last=new Map();
  return async(event,detail="",cooldown=300000)=>{
    if(!botToken||(!eventUrl&&(!logTopicId||!logDestination)))return;
    const now=Date.now();if(now-(last.get(event)??-Infinity)<cooldown)return;
    last.set(event,now);
    try {
      const response=await fetchImpl(eventUrl??`https://api.telegram.org/bot${botToken}/sendMessage`,{
        method:"POST",headers:{"Content-Type":"application/json",...(eventUrl?{Authorization:`Bearer ${botToken}`}:{})},signal:AbortSignal.timeout(8000),
        body:JSON.stringify(eventUrl?{event,detail:detail.slice(0,200)}:{chat_id:logDestination,message_thread_id:Number(logTopicId),text:`vn reader · ${event}\n${detail}`.slice(0,1000)})});
      if(!response.ok||!(await response.json()).ok)throw new Error("Notification rejected");
    }catch {console.warn("Operator notification could not be delivered");}
  };
}

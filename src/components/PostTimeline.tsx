import CustomSelect from "./CustomSelect";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { MessageRecord } from "../types";
import { CONTENT_TYPES, monthRange, periodRange, timelinePosts, timelineSeries, timelineWeeks, timelineLabelPositions, STACK_TYPES, primaryContentType, pinchWindow, zoomWindow, type ContentType, type TimelineRange, type TimelineZoom } from "../lib/postTimeline";
import { getMediaObjectUrl } from "../lib/media";

const HEIGHT=320, LEFT=48, TOP=24, BOTTOM=42;
const dateFormat = new Intl.DateTimeFormat("en-IN", { timeZone:"Asia/Kolkata", dateStyle:"medium",timeStyle:"short" });
const monthFormat = new Intl.DateTimeFormat("en-IN", {timeZone:"Asia/Kolkata",month:"long",year:"numeric"});
const monthLabel=(month:string)=>monthFormat.format(new Date(monthRange(month)[0]));

function PreviewIcon({close=false}:{close?:boolean}) {
  return <svg className="post-timeline-preview-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={close?"M6 6l12 12M18 6L6 18":"M7 17L17 7M7 7h10v10"}/>
  </svg>;
}

function PreviewMedia({message,directoryHandle}:{message:MessageRecord;directoryHandle:FileSystemDirectoryHandle|null}) {
  const [url,setUrl]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let cancelled=false;setUrl(null);setFailed(false);
    if(!message.media_path)return;
    if(/^\/api\/media\/\d+$/.test(message.media_path)){setUrl(message.media_path);return;}
    if(directoryHandle)void getMediaObjectUrl(directoryHandle,message.media_path,message.message_key).then(value=>{if(!cancelled)setUrl(value);}).catch(()=>{if(!cancelled)setFailed(true);});
    return()=>{cancelled=true;};
  },[message.message_key,message.media_path,directoryHandle]);
  if(!url||failed)return null;
  if(["photo","image","sticker","gif"].includes(message.media_kind??""))return <img src={url} alt={`Preview of post #${message.message_id}`} onError={()=>setFailed(true)}/>;
  if(["video","animation"].includes(message.media_kind??""))return <video src={url} muted playsInline preload="metadata" onError={()=>setFailed(true)}/>;
  return null;
}

export default function PostTimeline({messages,directoryHandle,onOpenMessage}:{messages:MessageRecord[];directoryHandle:FileSystemDirectoryHandle|null;onOpenMessage:(key:string)=>void}) {
  const plotRef=useRef<HTMLDivElement>(null);
  const chartRef=useRef<SVGSVGElement>(null);
  const [WIDTH,setWidth]=useState(1000);
  const RIGHT=WIDTH>=900?150:24;
  useEffect(()=>{
    if(!plotRef.current)return;
    const observer=new ResizeObserver(entries=>setWidth(Math.max(280,entries[0].contentRect.width)));
    observer.observe(plotRef.current);return()=>observer.disconnect();
  },[messages.length]);
  const posts=useMemo(()=>timelinePosts(messages),[messages]);
  const months=useMemo(()=>Array.from(new Set(posts.map(p=>p.month))),[posts]);
  const [chosenMonth,setChosenMonth]=useState<string|null>(null);
  const month=chosenMonth&&months.includes(chosenMonth)?chosenMonth:months.at(-1)??"";
  const [scope,setScope]=useState<TimelineRange>("all");
  const [weekDate,setWeekDate]=useState<string|null>(null);
  const selectedWeek=weekDate??new Date((posts.at(-1)?.time??Date.now())+19800000).toISOString().slice(0,10);
  const [start,end]=scope!=="all"&&month?periodRange(scope,month,selectedWeek):[posts[0]?.time??0,(posts.at(-1)?.time??0)+86400000];
  const [visible,setVisible]=useState<ContentType[]>(CONTENT_TYPES.map(type=>type.id));
  const filtered=useMemo(()=>scope==="all"?posts:posts.filter(p=>p.time>=start&&p.time<end),[posts,start,end,scope]);
  const series=useMemo(()=>timelineSeries(filtered,visible),[filtered,visible]);
  const weeks=useMemo(()=>timelineWeeks(filtered,start,end),[filtered,start,end]);
  const [showPosts,setShowPosts]=useState(false);
  const [activeWeek,setActiveWeek]=useState<number|null>(null);
  const stackTypes=STACK_TYPES.filter(type=>visible.includes(type));
  const max=Math.max(1,filtered.filter(post=>visible.includes(primaryContentType(post))).length,visible.includes("link")?filtered.filter(post=>post.types.includes("link")).length:0);
  const selectedWeekData=activeWeek===null?null:weeks[activeWeek];
  const primaryTotals=useMemo(()=>Object.fromEntries(CONTENT_TYPES.map(type=>[type.id,type.id==="link"?filtered.filter(post=>post.types.includes("link")).length:filtered.filter(post=>primaryContentType(post)===type.id).length])) as Record<ContentType,number>,[filtered]);
  const dominant=CONTENT_TYPES.filter(type=>type.id!=="link").reduce((best,type)=>primaryTotals[type.id]>primaryTotals[best.id]?type:best,CONTENT_TYPES[0] as typeof CONTENT_TYPES[number]);
  const peak=weeks.reduce<typeof weeks[number]|null>((best,week)=>!best||week.total>best.total?week:best,null);
  const cumulativePointCounts=useMemo(()=>{
    const counts=Object.fromEntries(CONTENT_TYPES.map(type=>[type.id,0])) as Record<ContentType,number>;
    const positions=new Map<string,number>();
    for(const post of filtered){counts[primaryContentType(post)]++;if(post.types.includes("link"))counts.link++;for(const type of [primaryContentType(post),...(post.types.includes("link")?["link" as const]:[])]){const primary=type==="link"?"link":primaryContentType(post);positions.set(`${post.message.message_key}:${type}`,primary==="link"?counts.link:stackTypes.slice(0,stackTypes.indexOf(primary)+1).reduce((sum,id)=>sum+counts[id],0));}}
    return positions;
  },[filtered,visible]);
  const [zoom,setZoom]=useState<TimelineZoom>({from:0,to:1});
  const viewStart=start+(end-start)*zoom.from, viewEnd=start+(end-start)*zoom.to;
  const x=(time:number)=>LEFT+(time-viewStart)/Math.max(1,viewEnd-viewStart)*(WIDTH-LEFT-RIGHT);
  const y=(count:number)=>HEIGHT-BOTTOM-count/max*(HEIGHT-TOP-BOTTOM);
  const allPoints=useMemo(()=>series.flatMap(s=>s.points.map(p=>({...p,type:s.id,label:s.label,color:s.color}))).sort((a,b)=>a.time-b.time||a.message.message_id-b.message.message_id),[series]);
  const points=useMemo(()=>allPoints.filter(p=>p.time>=viewStart&&p.time<=viewEnd),[allPoints,viewStart,viewEnd]);
  const [active,setActive]=useState<string|null>(null);
  const [keyboardIndex,setKeyboardIndex]=useState(0);
  const preview=showPosts&&activeWeek===null?points.find(p=>`${p.message.message_key}:${p.type}`===active):undefined;
  const pinnedWeek=useRef<number|null>(null);
  const closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const pointerType=useRef("mouse");
  const touches=useRef(new Map<number,number>());
  const gesture=useRef<{initial:TimelineZoom;distance:number;center:number}|null>(null);
  const suppressClick=useRef(false);
  const mouseDrag=useRef<{id:number;x:number;y:number;position:number;initial:TimelineZoom;moved:boolean}|null>(null);
  const [dragging,setDragging]=useState(false);
  const zoomFrame=useRef<number|null>(null);
  const nextZoom=useRef<TimelineZoom>(zoom);
  const clipId=useId();
  useEffect(()=>{setZoom({from:0,to:1});nextZoom.current={from:0,to:1};gesture.current=null;touches.current.clear();},[scope,month,selectedWeek]);
  const updateZoom=(next:TimelineZoom)=>{
    nextZoom.current=next;
    if(zoomFrame.current!==null)return;
    zoomFrame.current=requestAnimationFrame(()=>{zoomFrame.current=null;setActive(null);setActiveWeek(null);setKeyboardIndex(0);setZoom(nextZoom.current);});
  };
  const localPosition=(event:ReactPointerEvent<SVGSVGElement>)=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    return (event.clientX-bounds.left-LEFT/WIDTH*bounds.width)/(bounds.width*(WIDTH-LEFT-RIGHT)/WIDTH);
  };
  const touchStart=(event:ReactPointerEvent<SVGSVGElement>)=>{
    if(event.pointerType!=="touch"){
      if(event.button!==0||(event.target as Element).closest?.(".post-timeline-point"))return;
      suppressClick.current=false;cancelClose();setActive(null);
      event.currentTarget.focus({preventScroll:true});
      mouseDrag.current={id:event.pointerId,x:event.clientX,y:event.clientY,position:localPosition(event),initial:nextZoom.current,moved:false};
      event.currentTarget.setPointerCapture(event.pointerId);return;
    }
    suppressClick.current=false;touches.current.set(event.pointerId,localPosition(event));
    const positions=Array.from(touches.current.values());
    if(positions.length===2){
      suppressClick.current=true;
      for(const id of touches.current.keys())event.currentTarget.setPointerCapture(id);
      gesture.current={initial:nextZoom.current,distance:Math.abs(positions[0]-positions[1]),center:(positions[0]+positions[1])/2};
    }else if(positions.length===1)gesture.current={initial:nextZoom.current,distance:0,center:positions[0]};
  };
  const touchMove=(event:ReactPointerEvent<SVGSVGElement>)=>{
    const drag=mouseDrag.current;
    if(drag&&drag.id===event.pointerId){
      if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<4)return;
      drag.moved=true;suppressClick.current=true;setDragging(true);
      const span=drag.initial.to-drag.initial.from;
      if(span<1)updateZoom(zoomWindow(drag.initial.from+(drag.position-localPosition(event))*span,span));
      window.scrollBy({top:drag.y-event.clientY,behavior:"instant"});drag.y=event.clientY;
      return;
    }
    if(!touches.current.has(event.pointerId)||!gesture.current)return;
    touches.current.set(event.pointerId,localPosition(event));
    const positions=Array.from(touches.current.values()),initial=gesture.current;
    if(positions.length===2&&initial.distance>0){
      suppressClick.current=true;updateZoom(pinchWindow(initial.initial,initial.center,(positions[0]+positions[1])/2,Math.abs(positions[0]-positions[1])/initial.distance));
    }else if(positions.length===1&&initial.initial.to-initial.initial.from<1&&Math.abs(positions[0]-initial.center)>.015){
      suppressClick.current=true;event.currentTarget.setPointerCapture(event.pointerId);
      const span=initial.initial.to-initial.initial.from;updateZoom(zoomWindow(initial.initial.from+(initial.center-positions[0])*span,span));
    }
  };
  const touchEnd=(event:ReactPointerEvent<SVGSVGElement>)=>{
    if(mouseDrag.current?.id===event.pointerId){mouseDrag.current=null;setDragging(false);}
    touches.current.delete(event.pointerId);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining=Array.from(touches.current.values());
    gesture.current=remaining.length===1?{initial:nextZoom.current,distance:0,center:remaining[0]}:null;
  };
  const zoomBy=(factor:number)=>{const span=(zoom.to-zoom.from)/factor;updateZoom(zoomWindow((zoom.from+zoom.to-span)/2,span));};
  useEffect(()=>{
    const node=chartRef.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{
      if(!event.ctrlKey)return;
      event.preventDefault();event.stopPropagation();cancelClose();
      const bounds=node.getBoundingClientRect();
      const center=Math.max(0,Math.min(1,(event.clientX-bounds.left-LEFT/WIDTH*bounds.width)/(bounds.width*(WIDTH-LEFT-RIGHT)/WIDTH)));
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?HEIGHT:1);
      updateZoom(pinchWindow(nextZoom.current,center,center,Math.exp(-Math.max(-200,Math.min(200,delta))*.004)));
    };
    node.addEventListener("wheel",wheel,{passive:false});
    return()=>node.removeEventListener("wheel",wheel);
  },[WIDTH,posts.length>0]);
  const pointNodes=useRef(new Map<string,SVGGElement>());
  const cancelClose=()=>{if(closeTimer.current)clearTimeout(closeTimer.current);};
  const dismiss=()=>{if(pinnedWeek.current!==null)return;cancelClose();closeTimer.current=setTimeout(()=>{setActive(null);setActiveWeek(null);},130);};
  useEffect(()=>{pinnedWeek.current=null;setActive(null);setActiveWeek(null);setKeyboardIndex(0);},[month,scope,visible,selectedWeek]);
  useEffect(()=>()=>{if(closeTimer.current)clearTimeout(closeTimer.current);if(zoomFrame.current!==null)cancelAnimationFrame(zoomFrame.current);},[]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!plotRef.current?.contains(event.target as Node)){pinnedWeek.current=null;cancelClose();setActive(null);setActiveWeek(null);}};
    document.addEventListener("pointerdown",outside);return()=>document.removeEventListener("pointerdown",outside);
  },[]);
  const explore=(event:ReactKeyboardEvent<SVGElement>,index?:number)=>{
    if(event.key==="Escape"){pinnedWeek.current=null;cancelClose();setActive(null);setActiveWeek(null);return;}
    if(!showPosts){
      if(["ArrowRight","ArrowLeft","Home","End"].includes(event.key)){
        event.preventDefault();event.stopPropagation();cancelClose();
        const available=weeks.map((week,index)=>({week,index})).filter(({week})=>week.end>viewStart&&week.start<viewEnd);
        const position=available.findIndex(item=>item.index===activeWeek);
        const next=event.key==="Home"?0:event.key==="End"?available.length-1:Math.max(0,Math.min(available.length-1,position<0?0:position+(event.key==="ArrowRight"?1:-1)));
        if(available[next])setActiveWeek(available[next].index);
      }else if(event.key==="Enter"&&selectedWeekData){event.preventDefault();setWeekDate(new Date(selectedWeekData.start+19800000).toISOString().slice(0,10));setScope("week");setShowPosts(true);setActiveWeek(null);}
      return;
    }
    if(!points.length)return;
    if(["ArrowRight","ArrowLeft","ArrowUp","ArrowDown","Home","End"].includes(event.key)){
      event.preventDefault();event.stopPropagation();cancelClose();
      const current=index??points.findIndex(p=>`${p.message.message_key}:${p.type}`===active);
      const next=event.key==="Home"?0:event.key==="End"?points.length-1:Math.max(0,Math.min(points.length-1,current<0?0:current+(["ArrowRight","ArrowDown"].includes(event.key)?1:-1)));
      const target=points[next],key=`${target.message.message_key}:${target.type}`;
      setKeyboardIndex(next);pointNodes.current.get(key)?.focus({preventScroll:true});cancelClose();setActiveWeek(null);setActive(key);
    }else if((event.key==="Enter"||event.key===" ")&&preview){
      event.preventDefault();event.stopPropagation();if(WIDTH>=600)choose(preview.message.message_key);
    }
  };
  const choose=(key:string)=>{cancelClose();setActive(null);setActiveWeek(null);onOpenMessage(key);};
  const toggle=(type:ContentType)=>setVisible(current=>current.includes(type)?current.filter(t=>t!==type):[...current,type]);
  const totals=useMemo(()=>["image","video","text","link","gif","poll","audio","file"].map(id=>CONTENT_TYPES.find(type=>type.id===id)!),[]);
  const monthIndex=months.indexOf(month);
  const years=Array.from(new Set(months.map(m=>m.slice(0,4))));
  const shiftWeek=(direction:number)=>setWeekDate(new Date(Date.parse(selectedWeek+"T00:00:00Z")+direction*7*86400000).toISOString().slice(0,10));
  const shortDate=(time:number)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",year:"numeric"}).format(time);
  const showWeek=(index:number,pin=false)=>{if(gesture.current||mouseDrag.current)return;if(pin)pinnedWeek.current=index;else if(pinnedWeek.current!==null)return;cancelClose();setActive(null);setActiveWeek(index);};
  const readWeek=()=>{if(!selectedWeekData)return;setWeekDate(new Date(selectedWeekData.start+19800000).toISOString().slice(0,10));setScope("week");setShowPosts(true);setActiveWeek(null);};
  const weekPosition=(week:typeof weeks[number])=>Math.max(viewStart,Math.min(viewEnd,week.end));
  const boundary=(week:typeof weeks[number],type:ContentType)=>stackTypes.slice(0,stackTypes.indexOf(type)+1).reduce((sum,id)=>sum+week.cumulative[id],0);
  const areaPath=(type:ContentType)=>{
    const upper=[`${x(start)},${y(0)}`,...weeks.map(week=>`${x(Math.min(end,week.end))},${y(boundary(week,type))}`)];
    const lower=[`${x(start)},${y(0)}`,...weeks.map(week=>`${x(Math.min(end,week.end))},${y(boundary(week,type)-week.cumulative[type])}`)];
    return `M${upper.join(" L")} L${lower.reverse().join(" L")} Z`;
  };
  const pointY=(p:typeof points[number])=>y(cumulativePointCounts.get(`${p.message.message_key}:${p.type}`)??p.count);
  const barHeight=116,barBottom=96;
  const weeklyMax=Math.max(1,...weeks.map(week=>stackTypes.reduce((sum,type)=>sum+week.counts[type],0)));
  const barY=(count:number)=>barBottom-count/weeklyMax*76;
  const axisDate=(time:number)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",...(viewEnd-viewStart<2*86400000?{hour:"numeric",minute:"2-digit"}:viewEnd-viewStart<200*86400000?{day:"numeric",month:"short"}:{month:"short",year:"2-digit"})}).format(time);
  const endpointLabels=weeks.length?timelineLabelPositions(["image","video","text","link"].flatMap(id=>{
    const type=CONTENT_TYPES.find(item=>item.id===id)!,last=weeks.at(-1)!;
    if(!visible.includes(type.id)||!last.cumulative[type.id])return [];
    const count=last.cumulative[type.id],level=type.id==="link"?count:boundary(last,type.id)-count/2;
    return [{type,count,idealY:y(level)+4}];
  }),TOP+8,HEIGHT-BOTTOM-4):[];
  const periodLabel=scope==="all"?"Entire stored archive":`${shortDate(start)} – ${shortDate(end-1)}`;

  return <section className={`post-timeline ${WIDTH<600?"is-compact":""}`} data-tour="post-timeline" aria-labelledby="post-timeline-title">
    <header className="post-timeline-heading"><div><p className="eyebrow">The archive, over time</p><h3 id="post-timeline-title">VN’s posting timeline</h3><p>{filtered.length.toLocaleString()} dated posts · India Standard Time</p></div>
      <div className="post-timeline-controls"><div className="post-timeline-scope" role="group" aria-label="Time range">{([["all","All time"],["year","By year"],["six","6 mo"],["three","3 mo"],["month","Month"],["week","Week"]] as const).map(([value,label])=><button key={value} type="button" aria-pressed={scope===value} onClick={()=>setScope(value)}>{label}</button>)}</div>
        {scope==="week"?<div className="post-timeline-month"><button type="button" aria-label="Previous timeline week" onClick={()=>shiftWeek(-1)}>←</button><input type="date" aria-label="Choose any date in the timeline week" value={selectedWeek} onInput={e=>{const value=e.currentTarget.value;if(value && Number.isFinite(Date.parse(value+"T00:00:00Z")))setWeekDate(value);}} onChange={e=>{if(/^\d{4}-\d{2}-\d{2}$/.test(e.target.value))setWeekDate(e.target.value);}}/><button type="button" aria-label="Next timeline week" onClick={()=>shiftWeek(1)}>→</button></div>:scope==="year"?<div className="post-timeline-month"><label>Year <CustomSelect aria-label="Timeline year" value={month.slice(0,4)} onChange={e=>setChosenMonth(months.find(m=>m.startsWith(e.target.value))??null)}>{years.map(year=><option key={year} value={year}>{year}</option>)}</CustomSelect></label></div>:scope!=="all"?<div className="post-timeline-month"><button type="button" aria-label="Previous timeline month" disabled={!month||monthIndex<=0} onClick={()=>setChosenMonth(months[monthIndex-1])}>←</button><label>{scope!=="month"?"Ending ":""}<CustomSelect aria-label="Timeline month" value={month} disabled={!months.length} onChange={e=>setChosenMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</CustomSelect></label><button type="button" aria-label="Next timeline month" disabled={!month||monthIndex>=months.length-1} onClick={()=>setChosenMonth(months[monthIndex+1])}>→</button></div>:null}
      </div>
    </header>
    {filtered.length>0?<p className="post-timeline-summary">Mostly <strong style={{color:dominant.color}}>{dominant.label.toLowerCase()} ({Math.round(primaryTotals[dominant.id]/filtered.length*100)}%)</strong>. {peak?<span>Busiest week: <strong>{shortDate(peak.start)}</strong>, with {peak.total.toLocaleString()} posts.</span>:null}</p>:null}
    <div className="post-timeline-legend" aria-label="Filter timeline content types">{totals.map(type=><button key={type.id} type="button" aria-pressed={visible.includes(type.id)} onClick={()=>toggle(type.id)} style={{"--series-color":type.color} as CSSProperties}><span className={`post-timeline-swatch ${type.id==="link"?"is-link":""}`}/>{type.id==="link"?"Has links":type.label}<span>{primaryTotals[type.id].toLocaleString()} · {filtered.length?Math.round(primaryTotals[type.id]/filtered.length*100):0}%</span></button>)}</div>
    <div className="post-timeline-chart-heading"><div><p className="eyebrow">Total posts so far</p><p className="post-timeline-instruction">Areas stack by type. Dashed line = posts with links, also counted under their own type.</p></div><label className="post-timeline-individual"><input type="checkbox" checked={showPosts} onChange={e=>{setShowPosts(e.target.checked);setActive(null);setActiveWeek(null);setKeyboardIndex(0);}}/>Show individual posts</label></div>
    <p className="post-timeline-instruction post-timeline-gesture-hint"><span className="timeline-desktop-hint">Hover a week to explore. Ctrl + scroll to zoom; drag empty chart space to pan or scroll.</span><span className="timeline-touch-hint">Pinch to zoom, drag to pan. Tap a week to explore; individual posts preview before you choose Read this post.</span></p>
    <div className="post-timeline-zoom"><span role="status">{(1/(zoom.to-zoom.from)).toFixed(1)}× zoom</span><button type="button" aria-label="Zoom out timeline" disabled={zoom.to-zoom.from>=1} onClick={()=>zoomBy(.5)}>−</button><button type="button" aria-label="Zoom in timeline" disabled={zoom.to-zoom.from<=.0005} onClick={()=>zoomBy(2)}>+</button><button type="button" disabled={zoom.to-zoom.from>=1} onClick={()=>updateZoom({from:0,to:1})}>Reset zoom</button></div>
    {!posts.length?<p className="empty-panel">No dated posts are available in this archive yet.</p>:<div className="post-timeline-plot" ref={plotRef}>
      <svg ref={chartRef} className={`post-timeline-chart ${dragging?"is-dragging":""}`} tabIndex={0} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-label="Posts by date and content type" role="group" onPointerDown={touchStart} onPointerMove={touchMove} onPointerUp={touchEnd} onPointerCancel={touchEnd} onKeyDown={e=>explore(e)}>
        <defs><clipPath id={clipId}><rect x={LEFT-8} y={TOP-8} width={WIDTH-LEFT-RIGHT+16} height={HEIGHT-TOP-BOTTOM+16}/></clipPath></defs>

        {Array.from(new Set([0,.25,.5,.75,1].map(f=>Math.round(max*f)))).map(value=><g key={value}><line x1={LEFT} x2={WIDTH-RIGHT} y1={y(value)} y2={y(value)} className="post-timeline-grid"/><text x={LEFT-10} y={y(value)+4} textAnchor="end" className="post-timeline-axis">{value}</text></g>)}
        {(WIDTH<600?[0,.5,1]:[0,.2,.4,.6,.8,1]).map(f=>{const time=viewStart+(viewEnd-viewStart-1)*f;return <text key={f} x={x(time)} y={HEIGHT-12} textAnchor={f===0?"start":f===1?"end":"middle"} className="post-timeline-axis">{new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",...(viewEnd-viewStart<2*86400000?{hour:"numeric",minute:"2-digit"}:viewEnd-viewStart<200*86400000?{day:"numeric",month:"short"}:{month:"short",year:"2-digit"})}).format(time)}</text>;})}
        <g clipPath={`url(#${clipId})`}>
        {stackTypes.map(type=>{const meta=CONTENT_TYPES.find(item=>item.id===type)!;return <g key={type}><path className="post-timeline-area" fill={meta.color} d={areaPath(type)}/><path className="post-timeline-line" stroke={meta.color} d={`M${x(start)},${y(0)} `+weeks.map(week=>`L${x(Math.min(end,week.end))},${y(boundary(week,type))}`).join(" ")}/></g>;})}
        {visible.includes("link")?<path className="post-timeline-line post-timeline-links-line" stroke={CONTENT_TYPES.find(type=>type.id==="link")!.color} d={`M${x(start)},${y(0)} `+weeks.map(week=>`L${x(Math.min(end,week.end))},${y(week.cumulative.link)}`).join(" ")}/>:null}
        {!showPosts?weeks.map((week,index)=>week.end>viewStart&&week.start<viewEnd?<rect key={week.start} className={`post-timeline-week-hit ${activeWeek===index?"is-active":""}`} x={x(Math.max(viewStart,week.start))} y={TOP} width={Math.max(1,x(Math.min(viewEnd,week.end))-x(Math.max(viewStart,week.start)))} height={HEIGHT-TOP-BOTTOM} fill="transparent" role="button" tabIndex={-1} aria-label={`Week of ${shortDate(week.start)}, ${week.total} posts. Preview week.`} onPointerEnter={()=>showWeek(index)} onPointerLeave={e=>{if(e.pointerType!=="touch")dismiss();}} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}showWeek(index,true);}}/>:null):null}
        {selectedWeekData&&!showPosts?<line x1={x(weekPosition(selectedWeekData))} x2={x(weekPosition(selectedWeekData))} y1={TOP} y2={HEIGHT-BOTTOM} className="post-timeline-crosshair"/>:null}
        {showPosts?points.map((p,index)=>{const key=`${p.message.message_key}:${p.type}`;return <g key={key} ref={node=>{if(node)pointNodes.current.set(key,node);else pointNodes.current.delete(key);}} role="button" tabIndex={index===keyboardIndex?0:-1} aria-label={`${p.label}, post #${p.message.message_id}, ${dateFormat.format(p.time)} IST. ${WIDTH<600?"Preview":"Open"} post.`} aria-describedby={active===key?"post-timeline-preview":undefined} className={`post-timeline-point ${active===key?"is-active":""}`} style={{"--series-color":p.color} as CSSProperties}
          onPointerDown={e=>{pointerType.current=e.pointerType;}} onPointerEnter={()=>{if(!gesture.current&&!mouseDrag.current){cancelClose();setActiveWeek(null);setActive(key);}}} onPointerLeave={e=>{if(e.pointerType!=="touch")dismiss();}} onFocus={()=>{cancelClose();setKeyboardIndex(index);setActiveWeek(null);setActive(key);}} onBlur={()=>{if(pointerType.current!=="touch")dismiss();}} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}if(pointerType.current==="touch"||WIDTH<600){cancelClose();setActiveWeek(null);setActive(key);setKeyboardIndex(index);}else choose(p.message.message_key);}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();if(WIDTH<600){cancelClose();setActiveWeek(null);setActive(key);}else choose(p.message.message_key);}else explore(e,index);}}>
          <circle cx={x(p.time)} cy={pointY(p)} r={8} fill="transparent"/><circle className="post-timeline-dot" cx={x(p.time)} cy={pointY(p)} r={active===key?5:2.8}/></g>;}):null}
        </g>
        {WIDTH>=900?endpointLabels.map(({type,count,idealY,labelY})=><g key={type.id}>
          {Math.abs(labelY-idealY)>3?<path className="post-timeline-label-leader" stroke={type.color} d={`M${WIDTH-RIGHT},${idealY-4} L${WIDTH-RIGHT+7},${labelY-4}`}/>:null}
          <text x={WIDTH-RIGHT+10} y={labelY} fill={type.color} className="post-timeline-end-label">{type.id==="link"?"Has links":type.label}<tspan dx="7" fill="var(--text-muted)">{count.toLocaleString()}</tspan></text>
        </g>):null}
      </svg>
      <p className="eyebrow post-timeline-week-title">Posts per week</p>
      <svg className="post-timeline-weekly" viewBox={`0 0 ${WIDTH} ${barHeight}`} role="group" aria-label="Weekly activity by content type" onKeyDown={e=>explore(e)} tabIndex={0}>
        <defs><clipPath id={`${clipId}-weekly`}><rect x={LEFT} y={0} width={WIDTH-LEFT-RIGHT} height={barHeight}/></clipPath></defs>
        {[0,.5,1].map(f=><g key={f}><line x1={LEFT} x2={WIDTH-RIGHT} y1={barY(weeklyMax*f)} y2={barY(weeklyMax*f)} className="post-timeline-grid"/><text x={LEFT-10} y={barY(weeklyMax*f)+4} textAnchor="end" className="post-timeline-axis">{Math.round(weeklyMax*f)}</text></g>)}
        <g clipPath={`url(#${clipId}-weekly)`}>{weeks.map((week,index)=>{
          if(week.end<=viewStart||week.start>=viewEnd)return null;
          const left=x(Math.max(viewStart,week.start)),right=x(Math.min(viewEnd,week.end)),width=Math.max(1,(right-left)*.7);let base=0;
          return <g key={week.start} className={`post-timeline-week-bar ${activeWeek===index?"is-active":""}`} role="button" tabIndex={-1} aria-label={`Week of ${shortDate(week.start)}, ${week.total} posts. Preview week.`} onPointerEnter={()=>showWeek(index)} onPointerLeave={e=>{if(e.pointerType!=="touch")dismiss();}} onClick={()=>showWeek(index,true)}>
            <rect x={left} y={0} width={Math.max(1,right-left)} height={barBottom} fill="transparent"/>
            {stackTypes.map(type=>{const count=week.counts[type],bottom=base;base+=count;return count?<rect key={type} x={left+(right-left-width)/2} y={barY(base)} width={width} height={barY(bottom)-barY(base)} fill={CONTENT_TYPES.find(item=>item.id===type)!.color} opacity={week.end>Date.now()?.4:.9}/>:null;})}
            {peak===week&&right-left>40?<text x={(left+right)/2} y={Math.max(12,barY(base)-6)} textAnchor="middle" className="post-timeline-peak">Peak · {week.total}</text>:null}
          </g>;
        })}</g>
        {(WIDTH<600?[0,.5,1]:[0,.2,.4,.6,.8,1]).map(f=>{const time=viewStart+(viewEnd-viewStart-1)*f;return <text key={f} x={x(time)} y={barHeight-2} textAnchor={f===0?"start":f===1?"end":"middle"} className="post-timeline-axis">{axisDate(time)}</text>;})}
      </svg>
      {selectedWeekData?<div role="tooltip" className="post-timeline-preview post-timeline-week-preview" style={{left:`${Math.min(Math.max(0,(WIDTH-280)/WIDTH*100),Math.max(0,x(weekPosition(selectedWeekData))/WIDTH*100))}%`,top:"8%"}} onPointerEnter={cancelClose} onPointerLeave={e=>{if(e.pointerType!=="touch")dismiss();}} onFocus={cancelClose}>
        <div className="post-timeline-preview-meta"><span>Week of {shortDate(selectedWeekData.start)}</span><button type="button" className="post-timeline-preview-close" aria-label="Dismiss week preview" onClick={()=>{pinnedWeek.current=null;cancelClose();setActiveWeek(null);}}><PreviewIcon close/></button></div>
        <strong className="post-timeline-week-total">{selectedWeekData.total.toLocaleString()} posts</strong>
        {STACK_TYPES.map(id=>{const type=CONTENT_TYPES.find(item=>item.id===id)!;return selectedWeekData.counts[id]?<div key={id} className="post-timeline-week-stat"><span><i style={{background:type.color}}/>{type.label}</span><span>{selectedWeekData.counts[id]} <small>· {selectedWeekData.cumulative[id]} total</small></span></div>:null;})}
        <p>{selectedWeekData.counts.link} contain links · Monday–Sunday</p>
        <button type="button" className="post-timeline-preview-action" disabled={!selectedWeekData.total} onClick={readWeek}><span>Explore this week’s posts</span><PreviewIcon/></button>
      </div>:null}
      {!points.length?<p className="post-timeline-no-points">{filtered.length?"No posts match these filters. Select a content type above.":"No posts were stored for this period. Try another date."}</p>:null}
      {preview?<div id="post-timeline-preview" role="tooltip" className="post-timeline-preview" style={{left:`${Math.min(Math.max(0,(WIDTH-280)/WIDTH*100),Math.max(0,x(preview.time)/WIDTH*100))}%`,top:`${Math.min(50,Math.max(5,pointY(preview)/HEIGHT*100))}%`,"--series-color":preview.color} as CSSProperties} onPointerEnter={cancelClose} onPointerLeave={e=>{if(e.pointerType!=="touch")dismiss();}} onFocus={cancelClose} onBlur={()=>{if(pointerType.current!=="touch")dismiss();}}>
        <div className="post-timeline-preview-meta"><span><i/>{preview.label}</span><strong>#{preview.message.message_id}</strong><button className="post-timeline-preview-close" type="button" aria-label="Dismiss post preview" onClick={()=>{cancelClose();setActive(null);}}><PreviewIcon close/></button></div><time dateTime={preview.message.date_utc??undefined}>{dateFormat.format(preview.time)} IST</time>
        <PreviewMedia key={preview.message.message_key} message={preview.message} directoryHandle={directoryHandle}/><p>{(preview.message.text||preview.message.quote_text||`A ${preview.label.toLowerCase()} post`).replace(/\s+/g," ").slice(0,260)}{preview.message.text.length>260?"…":""}</p>
        {preview.message.external_urls?.[0]?<p className="post-timeline-preview-url">{preview.message.external_urls[0]}</p>:null}
        <button type="button" className="post-timeline-preview-action" onClick={()=>choose(preview.message.message_key)}><span>Read this post</span><PreviewIcon/></button>
      </div>:null}
    </div>}
    <footer className="post-timeline-footer"><span>{zoom.to-zoom.from<1?`${shortDate(viewStart)} – ${shortDate(viewEnd-1)}`:periodLabel}{scope==="week"?" · Monday–Sunday":""}</span><span>Keyboard: ← → to explore · Enter to {!showPosts?"explore week":WIDTH<600?"preview":"read"} · Esc to dismiss</span></footer>
  </section>;
}

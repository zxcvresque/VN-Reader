import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
const source=await readFile(new URL("../src/lib/postTimeline.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {contentTypes,timelinePosts,monthRange,periodRange,timelineSeries,timelineWeeks,timelineLabelPositions,primaryContentType,STACK_TYPES,pinchWindow,zoomWindow}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const message=(id,date,extra={})=>({message_id:id,message_key:`1:${id}`,message_type:"Message",date_utc:date,text:"A post",media_kind:null,media_present:false,external_urls:[],...extra});

test("timeline separates media types and counts links alongside media",()=>{
  for(const [kind,expected] of [[null,"text"],["photo","image"],["video","video"],["animation","gif"],["poll","poll"],["audio","audio"],["voice","audio"],["document","file"]]){
    assert.deepEqual(contentTypes(message(1,null,{media_kind:kind,media_present:!!kind})),[expected]);
  }
  assert.deepEqual(contentTypes(message(1,null,{media_kind:"photo",media_present:true,external_urls:["https://example.com"]})),["image","link"]);
  assert.deepEqual(contentTypes(message(1,null,{text:"Read https://example.com"})),["link"]);
  assert.deepEqual(contentTypes(message(1,null,{media_kind:"webpage",media_present:true})),["link"]);
});
test("exported GIF documents are recognized before their video container",()=>{
  assert.deepEqual(contentTypes(message(1,null,{media_kind:"video",media_raw:{attributes:[{_:"DocumentAttributeAnimated"}]}})),["gif"]);
});
test("monthly boundaries use IST and preserve timestamps and post identity",()=>{
  const posts=timelinePosts([message(2,"2024-02-29T18:30:00Z"),message(1,"2024-02-29T18:29:59Z"),message(3,null),message(4,"invalid"),message(5,"2024-03-01T00:00:00Z",{message_type:"MessageService"})]);
  assert.equal(posts.length,2);assert.equal(posts[0].month,"2024-02");assert.equal(posts[1].month,"2024-03");assert.equal(posts[1].message.message_key,"1:2");
  assert.equal(new Date(monthRange("2024-03")[0]).toISOString(),"2024-02-29T18:30:00.000Z");
  assert.equal(new Date(monthRange("2024-03")[1]).toISOString(),"2024-03-31T18:30:00.000Z");
});
test("series counts reset to the displayed period and filters retain post targets",()=>{
  const posts=timelinePosts([message(1,"2024-02-01T00:00:00Z"),message(2,"2024-03-01T00:00:00Z"),message(3,"2024-03-02T00:00:00Z",{media_kind:"poll"}),message(4,"2024-03-03T00:00:00Z")]);
  const series=timelineSeries(posts.filter(p=>p.month==="2024-03"),["text","poll"]);
  assert.deepEqual(series[0].points.map(p=>[p.message.message_id,p.count]),[[2,1],[4,2]]);
  assert.deepEqual(series[1].points.map(p=>[p.message.message_id,p.count]),[[3,1]]);
  assert.deepEqual(timelineSeries(posts,[]),[]);
});
test("year, quarter, half-year and week ranges handle calendar boundaries",()=>{
  const iso=range=>range.map(t=>new Date(t).toISOString());
  assert.deepEqual(iso(periodRange("year","2024-09","2024-09-04")),["2023-12-31T18:30:00.000Z","2024-12-31T18:30:00.000Z"]);
  assert.deepEqual(iso(periodRange("three","2024-02","2024-02-04")),["2023-11-30T18:30:00.000Z","2024-02-29T18:30:00.000Z"]);
  assert.deepEqual(iso(periodRange("six","2024-02","2024-02-04")),["2023-08-31T18:30:00.000Z","2024-02-29T18:30:00.000Z"]);
  assert.deepEqual(iso(periodRange("week","2024-01","2024-01-07")),["2023-12-31T18:30:00.000Z","2024-01-07T18:30:00.000Z"]);
});
test("pinch zoom preserves the finger anchor and pan remains inside the archive",()=>{
  assert.deepEqual(pinchWindow({from:0,to:1},.5,.5,2),{from:.25,to:.75});
  assert.deepEqual(pinchWindow({from:.25,to:.75},.5,.7,1),{from:.15000000000000002,to:.65});
  assert.deepEqual(zoomWindow(-.5,.5),{from:0,to:.5});
  assert.deepEqual(zoomWindow(.9,.5),{from:.5,to:1});
  assert.deepEqual(pinchWindow({from:.25,to:.75},.5,.5,.1),{from:0,to:1});
});


test("weekly stacks count every post once while links remain overlapping",()=>{
  const posts=timelinePosts([message(1,"2024-01-01T01:00:00Z",{media_kind:"photo",external_urls:["https://example.com"]}),message(2,"2024-01-03T01:00:00Z",{text:"https://example.com"}),message(3,"2024-01-15T01:00:00Z",{media_kind:"poll"})]);
  const [start,end]=periodRange("month","2024-01","2024-01-01");const weeks=timelineWeeks(posts,start,end);
  assert.equal(weeks.length,5);assert.equal(weeks[0].total,2);assert.equal(weeks[0].counts.image,1);assert.equal(weeks[0].counts.text,1);assert.equal(weeks[0].counts.link,2);
  assert.equal(weeks[1].total,0,"empty weeks remain in the graph");assert.equal(weeks[1].cumulative.image,1);
  assert.equal(STACK_TYPES.reduce((sum,type)=>sum+weeks.at(-1).cumulative[type],0),posts.length);
  assert.equal(weeks.at(-1).cumulative.link,2);assert.equal(primaryContentType(posts[1]),"text");
  assert.equal(timelineSeries(posts,["text"])[0].points[0].message.message_id,2);
});

test("weekly aggregation clips calendar edges and keeps Monday boundaries in IST",()=>{
  const posts=timelinePosts([message(1,"2024-02-29T18:29:59Z"),message(2,"2024-02-29T18:30:00Z"),message(3,"2024-03-31T18:30:00Z")]);
  const [start,end]=monthRange("2024-03");const weeks=timelineWeeks(posts,start,end);
  assert.equal(weeks.reduce((sum,week)=>sum+week.total,0),1);
  assert.equal(new Date(weeks[0].start).toISOString(),"2024-02-25T18:30:00.000Z");
  assert.equal(weeks[0].posts[0].message.message_id,2);
});


test("endpoint labels stay ordered, separated and within chart bounds",()=>{
  const placed=timelineLabelPositions([{id:"a",idealY:270},{id:"b",idealY:270},{id:"c",idealY:272},{id:"d",idealY:20}],32,274);
  assert.deepEqual(placed.map(label=>label.id),["d","a","b","c"]);
  assert.ok(placed.every(label=>label.labelY>=32&&label.labelY<=274));
  assert.ok(placed.slice(1).every((label,index)=>label.labelY-placed[index].labelY>=22));
});

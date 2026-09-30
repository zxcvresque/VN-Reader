import type { MessageRecord } from "../types";

export const CONTENT_TYPES = [
  { id: "text", label: "Text only", color: "#6ea8fe" },
  { id: "video", label: "Videos", color: "#f06fa8" },
  { id: "link", label: "Links", color: "#f5c451" },
  { id: "image", label: "Images", color: "#3ecf9e" },
  { id: "gif", label: "GIFs", color: "#a78bfa" },
  { id: "poll", label: "Polls", color: "#fb923c" },
  { id: "audio", label: "Audio", color: "#22d3ee" },
  { id: "file", label: "Other files", color: "#a3a3a3" }
] as const;
export type ContentType = typeof CONTENT_TYPES[number]["id"];
export type TimelineRange = "all" | "year" | "six" | "three" | "month" | "week";
export interface TimelineZoom { from: number; to: number }
export function zoomWindow(from:number,span:number):TimelineZoom {
  const width=Math.min(1,Math.max(.0005,span));
  const left=Math.max(0,Math.min(1-width,from));
  return {from:left,to:left+width};
}
export function pinchWindow(initial:TimelineZoom,initialCenter:number,currentCenter:number,scale:number):TimelineZoom {
  const span=Math.min(1,Math.max(.0005,(initial.to-initial.from)/Math.max(.01,scale)));
  const anchor=initial.from+initialCenter*(initial.to-initial.from);
  return zoomWindow(anchor-currentCenter*span,span);
}
export interface TimelinePost { message: MessageRecord; time: number; month: string; types: ContentType[] }
const IST_OFFSET = 19800000;

export function contentTypes(message: MessageRecord): ContentType[] {
  const raw = JSON.stringify(message.media_raw ?? {});
  const kind = message.media_kind;
  const types: ContentType[] = [];
  if (kind === "animation" || kind === "gif" || /DocumentAttributeAnimated|image\/gif/.test(raw)) types.push("gif");
  else if (kind === "video") types.push("video");
  else if (kind === "photo" || kind === "image" || kind === "sticker") types.push("image");
  else if (kind === "poll" || /MessageMediaPoll/.test(raw)) types.push("poll");
  else if (kind === "audio" || kind === "voice") types.push("audio");
  else if (message.media_present && kind !== "webpage") types.push("file");
  if (kind === "webpage" || message.external_urls?.length || /https?:\/\//i.test(message.text)) types.push("link");
  if (!types.length) types.push("text");
  return types;
}

export function timelinePosts(messages: MessageRecord[]): TimelinePost[] {
  return messages.filter(m => m.message_type !== "MessageService").flatMap(message => {
    const time = message.date_utc ? Date.parse(message.date_utc) : NaN;
    if (!Number.isFinite(time)) return [];
    return [{ message, time, month: new Date(time + IST_OFFSET).toISOString().slice(0,7), types: contentTypes(message) }];
  }).sort((a,b) => a.time-b.time || a.message.message_id-b.message.message_id);
}

export function monthRange(month: string): [number,number] {
  const [year,index] = month.split("-").map(Number);
  return [Date.UTC(year,index-1,1)-IST_OFFSET, Date.UTC(year,index,1)-IST_OFFSET];
}

export function periodRange(range: Exclude<TimelineRange,"all">, month: string, weekDate: string): [number,number] {
  const [year,index] = month.split("-").map(Number);
  if(range==="year")return [Date.UTC(year,0,1)-IST_OFFSET,Date.UTC(year+1,0,1)-IST_OFFSET];
  if(range==="week"){
    const day=new Date(weekDate+"T00:00:00Z");
    const monday=day.getTime()-((day.getUTCDay()+6)%7)*86400000-IST_OFFSET;
    return [monday,monday+7*86400000];
  }
  const months=range==="six"?6:range==="three"?3:1;
  return [Date.UTC(year,index-months,1)-IST_OFFSET,Date.UTC(year,index,1)-IST_OFFSET];
}

export function timelineSeries(posts: TimelinePost[], visible: ContentType[]) {
  return CONTENT_TYPES.filter(type => visible.includes(type.id)).map(type => {
    let count = 0;
    return { ...type, points: posts.filter(post => type.id === "link" ? post.types.includes("link") : primaryContentType(post) === type.id).map(post => ({ ...post, count: ++count })) };
  });
}

/** Every post has one primary type; links are an overlapping annotation. */
export const STACK_TYPES: ContentType[] = ["image", "video", "text", "gif", "poll", "audio", "file"];
export function primaryContentType(post: TimelinePost): ContentType {
  return post.types.find(type => type !== "link") ?? "text";
}
export interface TimelineWeek {
  start: number;
  end: number;
  posts: TimelinePost[];
  counts: Record<ContentType, number>;
  cumulative: Record<ContentType, number>;
  total: number;
}
export function timelineWeeks(posts: TimelinePost[], start: number, end: number): TimelineWeek[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const empty = () => Object.fromEntries(CONTENT_TYPES.map(type => [type.id, 0])) as Record<ContentType, number>;
  const day = new Date(start + IST_OFFSET);
  const monday = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - ((day.getUTCDay() + 6) % 7) * 86400000 - IST_OFFSET;
  const weeks: TimelineWeek[] = [];
  const cumulative = empty();
  let cursor = 0;
  for (let time = monday; time < end; time += 7 * 86400000) {
    const counts = empty(), entries: TimelinePost[] = [];
    const weekEnd = time + 7 * 86400000;
    while (cursor < posts.length && posts[cursor].time < weekEnd) {
      const post = posts[cursor++];
      if (post.time < start || post.time >= end) continue;
      entries.push(post);
      counts[primaryContentType(post)]++;
      if (post.types.includes("link")) counts.link++;
    }
    for (const type of CONTENT_TYPES) cumulative[type.id] += counts[type.id];
    weeks.push({ start: time, end: weekEnd, posts: entries, counts, cumulative: { ...cumulative }, total: entries.length });
  }
  return weeks;
}

/** Place chart-end labels without overlapping, retaining the series' vertical order. */
export function timelineLabelPositions<T extends { idealY: number }>(labels: T[], top: number, bottom: number, gap = 22): (T & { labelY: number })[] {
  const sorted = [...labels].sort((a, b) => a.idealY - b.idealY);
  const spacing = Math.min(gap, (bottom - top) / Math.max(1, sorted.length - 1));
  const placed = sorted.map((label, index) => ({ ...label, labelY: Math.max(top + index * spacing, Math.min(bottom, label.idealY)) }));
  for (let index = 1; index < placed.length; index++) placed[index].labelY = Math.max(placed[index].labelY, placed[index - 1].labelY + spacing);
  for (let index = placed.length - 1; index >= 0; index--) placed[index].labelY = Math.min(placed[index].labelY, bottom - (placed.length - 1 - index) * spacing);
  return placed;
}

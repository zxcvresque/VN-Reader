import type { AppSnapshot, BookmarkRecord, MessageReadOverride, ReadCursor } from "../types";
import { validatePreferences, type ReaderPreferences } from "./preferences";
import { validateReadingState, type ReadingState } from "./readingState";

export interface ReadingBackup {
  format: "vn-reader-reading-state";
  version: 1;
  exportedAt: string;
  chatId: number | null;
  preferences: ReaderPreferences;
  readingState: ReadingState;
  bookmarks: BookmarkRecord[];
  readOverrides: MessageReadOverride[];
  readCursor: ReadCursor | null;
}
export function createBackup(snapshot: AppSnapshot, readingState: ReadingState, preferences: ReaderPreferences): ReadingBackup {
  return { format:"vn-reader-reading-state", version:1, exportedAt:new Date().toISOString(),
    chatId:snapshot.manifest?.source.chat_id??null, preferences, readingState,
    bookmarks:snapshot.bookmarks, readOverrides:snapshot.readOverrides, readCursor:snapshot.readCursor };
}
function record(value:unknown): Record<string,unknown> {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw new Error("The selected file is not a reading-state backup.");
  return value as Record<string,unknown>;
}
function timestamp(value:unknown):string {
  if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new Error("Backup contains an invalid timestamp.");
  return value;
}
export function parseBackup(value:unknown,snapshot:AppSnapshot):ReadingBackup {
  const input=record(value);const chatId=snapshot.manifest?.source.chat_id??null;
  if(input.format!=="vn-reader-reading-state"||input.version!==1)throw new Error("Unsupported reading-state backup format.");
  if(input.chatId!==chatId)throw new Error("This backup belongs to a different archive. Import that archive first.");
  const preferences=validatePreferences(input.preferences);
  const readingState=validateReadingState(input.readingState,chatId);
  const knownMessages=new Set(snapshot.messages.map(m=>m.message_key));
  const knownThreads=new Set(snapshot.threads.map(t=>t.thread_key));
  // The reader derives quote-only threads; the same archive may contain derived keys absent in the persisted index.
  snapshot.messages.forEach(m=>knownThreads.add(m.thread_key));
  const messageKey=(value:unknown):string=>{
    if(typeof value!=="string"||!knownMessages.has(value))throw new Error("Backup references a post missing from this archive. Import the matching full archive first.");
    return value;
  };
  const keys=[...Object.keys(readingState.positions),...Object.keys(readingState.statuses),...readingState.queue,...Object.keys(readingState.notes),...readingState.passages.map(p=>p.messageKey),...readingState.collections.flatMap(c=>c.items.map(i=>i.messageKey)),...Object.keys(readingState.media)];
  keys.forEach(messageKey);
  if(!Array.isArray(input.bookmarks)||!Array.isArray(input.readOverrides))throw new Error("Backup bookmarks or progress are invalid.");
  const bookmarks:BookmarkRecord[]=input.bookmarks.map(entry=>{
    const item=record(entry);
    if(item.chat_id!==chatId||!['message','thread'].includes(String(item.target_type))||!Array.isArray(item.tags)||item.tags.some(t=>typeof t!=="string"))throw new Error("Backup contains an invalid bookmark.");
    const type=item.target_type as 'message'|'thread';
    const target=type==='message'?messageKey(item.message_key):item.thread_key;
    if(typeof target!=="string"||(type==='thread'&&!knownThreads.has(target)))throw new Error("Backup references a thread missing from this archive.");
    if(item.target_key!==target||item.bookmark_id!==`${type}:${target}`)throw new Error("Backup contains inconsistent bookmark identifiers.");
    return {bookmark_id:item.bookmark_id,target_type:type,target_key:target,chat_id:chatId!,message_key:type==='message'?target:null,
      thread_key:typeof item.thread_key==='string'?item.thread_key:null,tags:item.tags as string[],updated_at_utc:timestamp(item.updated_at_utc)};
  });
  const readOverrides:MessageReadOverride[]=input.readOverrides.map(entry=>{
    const item=record(entry);
    if(item.status!=='read'&&item.status!=='unread')throw new Error("Backup contains invalid seen progress.");
    return {message_key:messageKey(item.message_key),status:item.status,updated_at_utc:timestamp(item.updated_at_utc)};
  });
  if(new Set(bookmarks.map(b=>b.bookmark_id)).size!==bookmarks.length||new Set(readOverrides.map(o=>o.message_key)).size!==readOverrides.length)throw new Error("Backup contains duplicate reading records.");
  let readCursor:ReadCursor|null=null;
  if(input.readCursor!==null){
    const item=record(input.readCursor);const key=messageKey(item.message_key);const message=snapshot.messages.find(m=>m.message_key===key)!;
    if(item.chat_id!==chatId||item.message_id!==message.message_id||item.date_utc!==message.date_utc)throw new Error("Backup has an inconsistent reading cursor.");
    readCursor={chat_id:chatId!,message_key:key,message_id:message.message_id,date_utc:message.date_utc,updated_at_utc:timestamp(item.updated_at_utc)};
  }
  return {format:'vn-reader-reading-state',version:1,exportedAt:timestamp(input.exportedAt),chatId,preferences,readingState,bookmarks,readOverrides,readCursor};
}

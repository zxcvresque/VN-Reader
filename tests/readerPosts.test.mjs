import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/readerPosts.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { groupAlbumMessages, indexReaderPosts, albumCaptionOffset } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const message = (id, album = null, text = '', extra = {}) => ({
 message_id: id, message_key: `chat:${id}`, chat_id: 1, grouped_id: album, text, text_length: text.length,
 raw: { entities: [] }, external_urls: [], search_text: text.toLowerCase(), media_path: `/api/media/${id}`, ...extra
});

test('a two-photo Telegram album becomes one post without changing original rows or IDs', () => {
 const rows = [message(4818, null, 'Previous'), message(4819, 99, 'Full caption'), message(4820, 99)];
 const original = JSON.stringify(rows);
 const posts = groupAlbumMessages(rows);
 assert.equal(posts.length, 2);
 assert.equal(posts[1].message_id, 4819);
 assert.equal(posts[1].text, 'Full caption');
 assert.deepEqual(posts[1].album_members.map(m => m.media_path), ['/api/media/4819', '/api/media/4820']);
 const index = indexReaderPosts(posts);
 assert.equal(index.get('chat:4820'), posts[1]);
 assert.equal(index.get('chat:4819'), posts[1]);
 assert.equal(JSON.stringify(rows), original);
});

test('later captions and multiple captions preserve formatting offsets and quote metadata', () => {
 const quote = { is_quote_reply: true, quote_text: 'Source quote', reply_to_msg_id: 7 };
 const rows = [message(1, 90), message(2, 90, '😀 caption', { ...quote, raw: { entities: [{ _: 'MessageEntityBlockquote', offset: 3, length: 7 }] } }),
  message(3, 90, 'Second', { raw: { entities: [{ _: 'MessageEntityBold', offset: 0, length: 6 }] } })];
 const [post] = groupAlbumMessages(rows);
 assert.equal(post.text, '😀 caption\n\nSecond');
 assert.equal(post.quote_text, 'Source quote');
 assert.equal(post.reply_to_msg_id, 7);
 assert.deepEqual(post.raw.entities.map(e => e.offset), [3, 12]);
 assert.equal(albumCaptionOffset(post, 'chat:3'), 12);
 assert.equal(albumCaptionOffset(post, 'chat:2'), 0);
});

test('albums are isolated by channel and ungrouped or partial albums remain readable', () => {
 const rows = [message(1, 90, 'A'), message(2, 90, 'B', { chat_id: 2, message_key: 'other:2' }), message(3)];
 assert.deepEqual(groupAlbumMessages(rows), rows);
});

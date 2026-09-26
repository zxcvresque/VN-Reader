# VN Reader

A local-first reader for a Telegram channel archive. Export the channel with Python, then read it in a quiet browser interface with quote-aware threads, search, bookmarks, and saved progress.

## Start

1. Use a Python environment with Telethon and cryptg installed.
2. Run `python telegram_extract_media_quotes.py` and follow the prompts. Include raw payloads for full Telegram text-formatting fidelity.
3. Run `npm install`, then `npm run dev`.
4. Open the local URL shown by Vite, choose **Import archive folder**, and select `telegram_archive`.

The reader requires a Chromium-based browser with the File System Access API. It imports `manifest.json` and `messages.jsonl`, and reads media directly from the selected folder.

## Reading features

- **Read:** chronological, virtualized stream with day dividers, rich text, inline media, and text filtering.
- **Threads:** conversations derived from quote-replies, with a thread list and full chain.
- **Bookmarks:** saved messages and threads; message bookmarks support free-form tags.
- **Progress:** read/unread counts, unread streaks, tags, and import history.
- **Quote navigation:** jump to a quoted source, highlight the quoted passage, and return using the back button.
- **Reading paths:** start at the beginning, resume the saved anchor, jump to first unread or latest, or open a random message.
- **Direct navigation:** jump by message ID, thread root ID, or date.
- **Read state:** mark individual messages read/unread or mark everything through a message as read.
- **Media:** inline photos, video, and audio, plus a fullscreen photo/video viewer.
- **Reading width:** adjustable from 40ch to 120ch and remembered across sessions.
- **Navigation header:** compact on scroll, with responsive navigation and reduced-motion support.

Press **Ctrl+K** / **Cmd+K**, or **/** outside a text field, to open the command palette. Use the reader's inline text field to narrow the stream.

## Search filters

Mix literal text with these command-palette filters:

| Token | Effect |
|---|---|
| `media:photo`, `media:video`, `media:audio`, `media:sticker` | Media kind |
| `media:any` | Any media |
| `from:2024-01-01` / `to:2024-06-30` | Date window |
| `read:` / `unread:` | Reading state |
| `bookmarked:` | Bookmarked messages, including messages in bookmarked threads |
| `thread:` | Messages belonging to a quote-thread |

For example: `media:photo unread: from:2024-01-01`.

Text matching is literal and case-insensitive. The command palette shows up to 30 matching messages.

## Exporter maintenance

```powershell
# Resume the existing archive using saved settings
python telegram_extract_media_quotes.py --last-run

# Retry failed media
python telegram_extract_media_quotes.py --last-run --retry-failed-media-only

# Repair and sort locally, without Telegram calls
python telegram_extract_media_quotes.py --repair-archive --output-dir telegram_archive

# Audit against Telegram
python telegram_extract_media_quotes.py --last-run --audit-source-only

# Backfill external URLs
python telegram_extract_media_quotes.py --last-run --backfill-urls
```

Normal resume skips already archived message IDs; it does not refresh edits to those posts.

## Local storage

IndexedDB database `vn-reader`, schema version 4, stores the imported messages, thread index, bookmarks, read overrides, reading cursor, import history, manifest, and folder handle. Reading width lives in localStorage.

Upgrading from an older reader preserves the archive, bookmarks, and reading progress. Media stays in the archive folder; use **Reattach media folder** if browser access expires.

The reader supports one channel at a time. Resetting local data clears the reader's imported archive and saved reading state. Keep the Telegram session and archive files private.

## Development

- React 18, TypeScript, Vite, and cmdk.
- `npm run dev`: development server.
- `npm run build`: TypeScript check and production bundle.
- `npm run preview`: preview the production build.

The Python exporter and browser reader are separate programs. Reader use stays local; running the exporter contacts Telegram.

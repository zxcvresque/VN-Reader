# VN Reader

A reader for the VidurNeeti Telegram archive, with browser-local guest reading, optional Better Auth accounts, quote-aware threads, search, a personal library and saved progress. The hosted archive loads automatically, including Telegram media streaming. Hosted setup and Oracle A1 deployment are documented in [server/README.md](server/README.md).

## Start

1. Use Node 24.15+ and run `pnpm install --frozen-lockfile`, then `pnpm dev`.
2. Configure the hosted archive service using [server/README.md](server/README.md).
3. Open the local URL shown by Vite. The archive loads automatically; choose **Read as guest** or sign in.

Telegram extraction scripts remain available for server-side archive preparation. The public reader no longer exposes local archive import, folder reattachment, or archive reset actions.

## Reading features

- **Read:** chronological, virtualized stream with day dividers, rich text, inline media, and text filtering.
- **Threads:** conversations derived from quote-replies, with a thread list and full chain.
- **Bookmarks:** saved messages and threads; message bookmarks support free-form tags.
- **Progress:** seen/unseen counts, reading status, unread streaks, and bookmark tags.
- **Quote navigation:** jump to a quoted source, highlight the quoted passage, and return using the back button.
- **Reading paths:** start at the beginning, resume the saved anchor, jump to first unread or latest, or open a random message.
- **Direct navigation:** jump by message ID, thread root ID, or date.
- **Read state:** mark individual messages read/unread or mark everything through a message as read.
- **Media:** inline photos, video, and audio, plus a fullscreen photo/video viewer.
- **Global appearance:** Settings offers Vercel, Editorial, Cobalt Index, and Liquid Opal, each with distinct surfaces, typography accents, and button treatments. A first visit uses Vercel for system dark mode or Liquid Opal for system light mode. Your choice applies to every view and overlay and survives reloads; signed-in account appearance also syncs.
- **Page controls:** font family/size, line height, paragraph spacing, 40–120ch width, warm ivory or sepia reading paper, and named appearance presets.
- **Exact resume:** autosaves the post, paragraph, fraction within the paragraph, and scroll offset. Resume preserves the same passage through theme and width changes.
- **Focus:** hides navigation, statistics, session controls, and post actions; use Exit focus to bring them back.
- **Source peek:** open quoted source posts alongside your current reading, then expand them or read their surrounding context.
- **Reading trail:** back/forward through visited posts and views, restoring the return position after a detour.
- **Search beside reading:** find archive posts in a side panel, highlight matching phrases, read surrounding posts, then close search to return to your original passage.
- **Personal library:** keep a manually ordered read-later queue, named collections with introductions and ordered posts/passages, and searchable notes, saved passages, and collection titles.
- **Reading states:** Seen/Unseen remains separate from In progress, Finished, and Revisit. Finishing a queued post removes it from read later.
- **Session boundaries:** choose a post count, rough reading-minute target (220 words/minute), or ending date. The stream stops after the last post, with an explicit Keep reading action.
- **Media preferences:** compact, full-width, or collapsed previews; inline audio/video remembers time and playback speed.
- **Reading backup:** export/restore bookmarks, seen progress, exact positions, notes, saved passages, collections, queue, media positions, appearance, and presets in Settings. Restore requires the same imported archive and validates the file before changing state.
- **Sample archive:** explore the reader before importing; importing a real archive replaces the clearly labeled sample.
- **Navigation placement:** choose Top, Bottom, Left, or Right in Settings, independently of theme. Side navigation becomes a compact icon rail on narrow screens. Placement is saved across reloads and included in presets and backups.
- **Help and page tours:** a five-step basic tour opens automatically on the first reader visit. Open Menu → Help & tours to restart it or explore the detailed reading, library, search, appearance and account tours. Mobile tours use tap instructions; desktop tours include keyboard shortcuts. Tours preserve your reading place and saved work.
- **Minimal controls:** Search, Focus and Menu stay close to the reading. Each post has Bookmark, Seen and More controls; More keeps notes, Read later, reading states and context. Reading tools contains resume, history, side search, library and session boundaries. The supplied VN light/dark artwork appears in the interface, favicon and touch icon.

Press **Ctrl+K** / **Cmd+K**, or **/** outside a text field, to open the command palette. Use the reader's inline text field to narrow the stream.

Message footers keep the reading state, read-later clock, bookmark and More buttons in one row. Open **More** for notes, context, seen controls, labels and source links.

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

First-time visitors choose **Read as guest** or create an account on the welcome page. **Why vn reader** opens a seven-slide introduction to the philosophy and reading tools. A basic tour starts automatically on first entry and can be replayed from Menu → Help & tours. Read has labelled Save, Mark seen, and More actions; Tools, Width, and Filter stay beside its heading. Mobile navigation combines views and account/settings/help in one panel. Guest entry is remembered in this browser; a returning signed-in account opens the reader automatically. The hosted archive loads in the background and offers Retry if unavailable. Local archive management actions are no longer offered.

IndexedDB database `vn-reader`, schema version 4, stores the imported messages, thread index, bookmarks, read overrides, reading cursor, import history, manifest, and folder handle. Appearance and presets live in localStorage; personal reading data is stored in validated localStorage records scoped to the channel ID. Guest preferences and progress are local to this browser. Signed-in readers use a separate account cache and revisioned server sync for preferences, exact positions, notes, passages, collections, queue, media state and bookmarks. SMTP must be configured before live account signup is enabled.

Upgrading from an older reader preserves bookmarks and reading progress. Hosted media loads through the archive service.

The reader supports one channel at a time. Keep Telegram session and server archive files private. Reading-state backup export and restore remain available in settings.

## Docker deployment

Docker Compose runs the hosted reader as separate services:

- `web` serves the React reader.
- `accounts` provides Better Auth email/password login and saved reading progress.
- `archive` serves post metadata through the API and streams media from Telegram.
- `mirror` listens for new posts and copies them into the private Telegram archive group.
- `tunnel` runs cloudflared to connect `vidurneeti.xyz` to the reader.

Telegram stores the posts and media. Docker persistent volumes store accounts, password hashes, reading progress, the archive index, mirror checkpoints, and Telegram sessions. Compose manages the service network and restart policies; with Docker enabled at boot, services restart after a reboot.

For migration, build the images, restore the existing data into the persistent volumes, then start the services. See [deploy/README.md](deploy/README.md) for the full deployment and migration guide.

## Development

- React 18, TypeScript, Vite, and cmdk.
- `npm run dev`: development server.
- `npm run build`: TypeScript check and production bundle.
- `npm test`: Node tests for reading-state persistence, paragraph metadata, backup validation/roundtrips, and ordering.
- `npm run preview`: preview the production build.

The Python exporter and browser reader are separate programs. Reader use stays local; running the exporter contacts Telegram.

Email/password delivery setup and the live two-device sync checklist are in [deploy/EMAIL.md](deploy/EMAIL.md).

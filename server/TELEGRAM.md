# Telegram archive and streaming service

The archive worker reads the authorized public channel through a dedicated Telethon
user session and copies its messages to your own private supergroup. A separate
Telegram bot session reads the copied files in that group and relays them through the
VPS to browsers. This is the file-to-link architecture: browsers request HTTP byte
ranges, the server downloads only the requested chunks through MTProto, and the VPS
pays the bandwidth. It avoids downloading complete video files before playback.
Throughput still depends on Telegram, the VPS network and concurrent viewers; it is
not a guarantee that every Telegram file will be faster than other hosting.

The website receives indexed text/formatting/quote metadata from SQLite and media
from the private group's mapped message IDs. The database is the durable index of
successful copies. Channel message keys stay stable across imports, so notes and
reading progress remain attached to the same posts. Neither private-group IDs nor
Telegram credentials are returned to browser clients. Only indexed archive media is
publicly viewable; users cannot ask the service to fetch arbitrary Telegram files.

## Operator setup

Create a bot through BotFather and add it to the private destination supergroup with
permission to see its messages. The dedicated source reader account needs access to
the public channel and permission to post in the destination. This two-session design
is necessary because Telegram's history API is restricted to user accounts; a bot is
not a substitute for the account that reads old public channel history. Do not share
session files or bot tokens. Use dedicated session files for these processes, not the
same session file in multiple running clients.

Configure the following in the ignored `server/.env`, or provide them as environment
variables. `python -m server.mirror` reads that file; `uvicorn --env-file server/.env`
loads it for the API.

```dotenv
VN_DATABASE_PATH=./data/vn-reader.sqlite3
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_BOT_TOKEN=
TELEGRAM_SOURCE=@Vidurneeti
TELEGRAM_DESTINATION=
TELEGRAM_READER_SESSION=./data/telegram-reader
TELEGRAM_BOT_SESSION=./data/telegram-streamer
# Optional existing forum topic. Without this, the worker creates one archive topic.
# TELEGRAM_ARCHIVE_TOPIC_ID=
```

Get API credentials from [my.telegram.org](https://my.telegram.org). The destination
must be the numeric `-100…` ID of your private supergroup, not a username or invite
link. If it has topics, the worker creates one `VidurNeeti archive` topic on first
run and remembers the ID in SQLite. All mirrored posts and their mapped replies go
inside that topic. You can instead specify an existing topic's ID.

1. Install the repository's `requirements.txt` in a Python virtual environment.
2. Run `python -m server.mirror login` once to authorize the dedicated user account.
   It asks for Telegram's login code and account 2FA password if required. These are
   separate from the website's email/password accounts.
3. Run `python -m server.mirror backfill` for a complete historical copy. The worker
   processes messages oldest first, groups albums together, and maps replies to
   their copied parents. Telegram quotes and original text entities are retained.
4. Run `python -m server.mirror watch` under your VPS process manager. It resumes
   historical copying if interrupted, then listens for new posts and edits. A
   periodic history catch-up repairs missed new-message events. Edits received by
   the listener are queued durably and applied to the original copied post.
5. Run `uvicorn server.app:app --env-file server/.env --host 127.0.0.1 --port 8000`.
   Put the website and API behind the same HTTPS reverse proxy. Configure the proxy
   not to buffer `/api/media/` responses, and allow long-lived video streams.

Backfill and watch are alternatives: run one archive worker at a time, not both
simultaneously. Run a single API worker per bot session. A successful copy commits
the destination mapping before advancing the checkpoint. Failed copies halt progress;
retries keep the same durable Telegram random IDs to avoid duplicate sends after a
lost response. If Telegram cannot return a previous ID mapping after an ambiguous
send, the worker stops at that item for operator reconciliation instead of guessing
or skipping it. Back up SQLite and both Telegram session files together. Changing
the source/destination of an existing database is rejected.

Telegram service messages are not archive posts. Deleted source posts are retained
as archived copies. Quotes of parents outside the chosen channel retain quote text,
but cannot be remapped into a local reply. The worker respects channels which disable
saving/forwarding. No Telegram action takes place merely by importing a module or
running tests; API startup starts only the configured media bot, and does not copy
content or log in an interactive user.

## API and behavior

- `GET /api/archive` returns `{manifest,messages}` compatible with local imports.
  Only successfully copied posts are returned, sorted by source ID.
- `GET /api/media/{source_id}` streams the private copy. Range requests support
  bounded, open-ended and suffix byte ranges; valid ranges return 206. Unsatisfiable,
  malformed and multipart ranges return 416 with the total size.
- `HEAD /api/media/{source_id}` returns the same metadata without downloading bytes.
  `Accept-Ranges`, `Content-Length`, ETag and 206 `Content-Range` support seeking.
- Each stream buffers at most 256 KiB per Telegram chunk, cleans up download senders
  on browser disconnect, and refreshes expired Telegram file references. A maximum
  of eight active media streams protects the bot session; a busy service returns 503.
- HTML, SVG and other documents download as attachments. Only raster images,
  video and audio render inline. Headers prevent MIME sniffing and active document
  execution on the website origin.

Run `python -m unittest server.tests.test_telegram -v` for fake-client tests covering
reply/album mappings, restart/checkpoint recovery, edit synchronization, range
validation, exact byte slicing, disconnection cleanup and safe content headers.
These tests never connect to Telegram.

## Design sources

Reviewed [tulir/tgfilestream](https://github.com/tulir/tgfilestream) and
[EverythingSuckz/TG-FileStreamBot's HTTP streaming route](https://github.com/EverythingSuckz/TG-FileStreamBot/blob/python/WebStreamer/server/stream_routes.py)
for the file-to-link pattern. This implementation is original code rather than a
copy of those projects. The relevant protocols are
[Telethon's download iterator](https://docs.telethon.dev/en/stable/modules/client.html#telethon.client.downloads.DownloadMethods.iter_download),
[Telegram file downloads](https://core.telegram.org/api/files),
[history API](https://core.telegram.org/method/messages.getHistory),
[album sends](https://core.telegram.org/method/messages.sendMultiMedia) and
[quoted replies](https://core.telegram.org/constructor/inputReplyToMessage).

### Operator logs topic

The archive service automatically creates a private Logs topic and saves its ID in the existing archive database. Enable Manage Topics for the bot. Optionally set `TELEGRAM_LOG_TOPIC_ID` in `.env.production` to reuse an existing topic. The bot must be able to post in that topic. Notifications cover startup, archive catch-up, mirror and media failures/recovery, new accounts, email verification, and OTP delivery failures. They exclude passwords, OTPs, email addresses and reader content. Repeated operational failures are throttled to one event per category every five minutes; signup and verification events are individual. Delivery is best effort and does not block reader requests; Docker logs remain the fallback if Telegram itself is unavailable. Account events use an authenticated internal endpoint; this endpoint is not routed through the public web proxy. Rebuild and recreate accounts, archive and mirror when deploying this update.

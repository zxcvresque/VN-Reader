# Hosted archive and accounts

The website uses two services on the same origin. Better Auth runs in Node 24 with
SQLite; FastAPI and Telethon expose the private Telegram archive and stream media.
Guest reading stays in the browser. Account reading documents are stored by user and
archive in the account database, separately from guest data and Telegram credentials.

## Local setup

Use Node 24.15 or newer and Python 3.12. From the repository root:

```sh
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp server/.env.example server/.env
chmod 600 server/.env
```

Fill the private configuration, then run these in separate terminals:

```sh
pnpm accounts
.venv/bin/uvicorn server.app:app --env-file server/.env --host 127.0.0.1 --port 8000
pnpm dev
```

Vite proxies account routes to port 3005 and archive/media routes to port 8000.
Leave `VN_ARCHIVE_ENABLED=false` to use only imported browser archives.

## Better Auth and email

Set a persistent `BETTER_AUTH_SECRET` of at least 32 random characters. Set
`BETTER_AUTH_URL` and `VN_ALLOWED_ORIGINS` to the exact website origin. Production
uses Secure, HttpOnly session cookies; local HTTP requires `VN_ENV=development`.
Accounts stay disabled until a secret, SMTP host and sender are configured. There
is no production test code or verification bypass.

Configure authenticated TLS SMTP with `VN_SMTP_HOST`, `VN_SMTP_PORT`,
`VN_SMTP_USERNAME`, `VN_SMTP_PASSWORD` and `VN_SMTP_FROM`. Brevo's free transactional
SMTP is a suitable starting option; confirm its current limits and verify a sender
or domain in your provider account. This repository does not create that account.
Port 587 uses mandatory STARTTLS; use `VN_SMTP_SSL=true` for implicit TLS on 465.

[Better Auth email/password](https://better-auth.com/docs/authentication/email-password)
and its [email OTP plugin](https://better-auth.com/docs/plugins/email-otp) implement
signup, verified login, resend and password reset. Passwords require 12–128 characters.
Verification codes have six digits, expire after 10 minutes, allow five failed attempts
and are stored hashed. Sessions last 30 days; reset revokes existing sessions. Delivery
errors prevent a successful signup response; codes and credentials are never logged.

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Account/archive availability |
| `POST /api/auth/sign-up/email` | Create an email/password account |
| `POST /api/auth/email-otp/verify-email` | Verify `{email,otp}` and establish a session |
| `POST /api/auth/email-otp/send-verification-otp` | Resend verification |
| `POST /api/auth/sign-in/email` | Sign in after verification |
| `GET /api/auth/get-session` | Current session, or `null` |
| `POST /api/auth/sign-out` | End the session |
| `POST /api/auth/email-otp/request-password-reset` | Send a reset code |
| `POST /api/auth/email-otp/reset-password` | Reset with `{email,otp,password}` |
| `GET /api/state/:chatId` | Get `{revision,data}` and ETag |
| `PUT /api/state/:chatId` | Save `{data}` using `If-Match` revision |

Every mutation also requires an allowed `Origin` and `X-VN-CSRF: 1`. State routes
require a verified account. Missing revisions return 428; stale revisions return 409.
The browser merges independent edits and asks which copy to keep for competing edits.
Offline account changes use an account-scoped device cache. Guest progress is imported
only through the explicit account dialog action. Export a reading backup for portability.
The sync document limit is 1 MiB; exports preserve larger documents locally.

## Telegram archive

Set Telegram API ID/hash from your Telegram developer application, the bot token,
public source and private destination. The bot must be able to send messages there.
For a forum it tries to create one archive topic with Manage Topics; otherwise it uses
General. User accounts, passwords and progress belong in SQLite, not group topics.

A Telegram **user session** is needed to enumerate public channel history. The bot
retrieves known public message IDs and writes the private copies; a separate bot
session streams those copies. Bot sessions are kept in memory and authorized from the
configured bot token on each start. Local and VPS instances never share a bot auth key;
legacy bot `.session` files are ignored. The user reader session remains persistent
and must only run in one location. Authorize the reader session interactively once:

```sh
.venv/bin/python -m server.mirror login
.venv/bin/python -m server.mirror backfill
.venv/bin/python -m server.mirror watch
```

`watch` performs historical catch-up then listens for new messages and edits, with
native forwarding of up to 100 independent posts per request. Media stays on Telegram;
the copier does not download and re-upload files. Replies use native server-side copies
to attach them to the corresponding archived parents. Polls retain the original Telegram
poll and appear as question/options/results snapshots on the website.
For copied media replies, captions exceeding the bot limit continue in text replies to
the archived media. The website retains the complete original caption in one post.
Follow-up mappings are saved so interrupted transfers resume without resending the album;
edits also update or remove those caption continuations.
Quoted replies to continuation text target the saved continuation with an adjusted
UTF-16 offset. Quotes spanning two parts retain the parent reply and full website quote.
If Telegram rejects a native quote because its parent text changed or the quote is no
longer a valid substring, the copier retries only `QUOTE_TEXT_INVALID` with the same
message IDs and parent, omitting the native quote. The full original quote is saved as
a separate context reply in the private archive and remains in website metadata.
Context mappings are durable: an interruption resumes the context reply without
resending the main post or advancing past incomplete text.

For live terminal progress, run `./scripts/telegram-backfill.sh` from the project root.
It shows colored date (IST), post number and completion percentage pills, copied counts,
and a countdown when Telegram imposes a rate limit. Ctrl+C stops safely; rerunning resumes
from the saved checkpoint. Pass `backfill` to exit after history instead of watching.
Only one mirror process may use the reader session at a time.

The mirror uses
polling to repair missed events. Each copy has a durable random ID and mapping; a
failure or Telegram FloodWait keeps the checkpoint before that message. Albums copy
as a batch; replies and quoted text map to copied parents. External-channel quotes
never link to an unrelated local message ID. Deleted source posts remain archived.
Edits received while connected or caught up through the user session update their copy;
a bulk audit of every historical edit is not implemented.

The API exposes copied records at `/api/archive` and mapped files at
`/api/media/:sourceMessageId`. Only mapped private archive files can be requested.
HEAD, single byte ranges, suffix ranges and seeking are supported. Transfers use bounded
MTProto chunks through the server's bandwidth, with refreshed file references and
cleanup on disconnect. No full media cache is required. Sixteen-byte live range requests
were verified against a copied video; this is not a bandwidth benchmark.

This follows the MTProto streaming pattern studied in
[TG-FileStreamBot](https://github.com/EverythingSuckz/TG-FileStreamBot) and
[FileToLink](https://github.com/Tamilupdates/FileToLink); their code was not copied.

## Oracle A1 deployment

Run the full stack on Oracle A1 through a Cloudflare Tunnel at `vidurneeti.xyz`.
The numbered instructions, private-token setup, existing-archive migration and
operating commands are in [deploy/README.md](../deploy/README.md).

The frontend, Better Auth, archive/media API and persistent mirror all run on the VPS.
Telegram stores copied posts and media; Docker volumes retain account data, reading
progress, archive mappings and Telegram sessions. The tunnel publishes the internal
HTTP Caddy service through Cloudflare HTTPS without exposing VPS web ports.

Preserve the existing mapping database and authorized reader session using
`scripts/prepare-vps-migration.py`; the deployment should resume from its checkpoint.
Do not run that reader session on the local machine and VPS simultaneously.
Configure SMTP and verify actual email delivery before enabling production login.
Container images have not been built here because Docker is not installed.

## Verification

```sh
pnpm test
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s server/tests -v
pnpm build
```

Account tests inject an in-memory mailer and test the real Better Auth handler without
sending mail. Telegram tests exercise restart mappings, failures, quoted replies,
albums, edits, external references and bounded streaming. Live email delivery must be
verified after SMTP is configured.

## Archive readiness and recovery

`GET /api/archive-health` returns HTTP 200 only when the stored archive and Telegram
media connection are ready. Otherwise it returns HTTP 503 with `archiveReady`,
`mediaReady`, and a sanitized symbolic error. Docker uses this endpoint for readiness.
The durable `/api/archive` remains readable during a Telegram connection outage.

Startup connections are bounded, and the archive retries unavailable connections
automatically with a delay capped at 60 seconds. Invalidated bot authorization is
recreated with a fresh in-memory session, including `AuthKeyDuplicatedError` during
media lookup. Critical connection failures notify the configured owner; recovery
and routine events go to the existing Logs topic. No Telegram keys are logged.

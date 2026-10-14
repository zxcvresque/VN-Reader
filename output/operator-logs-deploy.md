# Operator logs and media FloodWait update

The source update is implemented and tested in the local VN Reader workspace.
It has not been applied to the VPS. `operator-logs-update.tar.gz` contains the
changed backend source, shared event schema, Dockerfiles, documentation and
regression tests. It contains no environment files, credentials, account data,
Telegram sessions or media.

## New log format

Telegram uses HTML formatting: a bold main title, searchable category tags,
a quoted summary and bold field labels. For example (illustrative account):

**vn reader · Account created**

\#signup

> Reader account created; verification email sent.

**Reader:** Example Reader  
**Email:** reader@example.com  
**Reader ID:** account-123  
**Status:** Awaiting email verification

Verification also logs automatic sign-in; successful password login logs the
persisted reader identity and method. Rejected logins include the attempted
email and a symbolic reason, throttled to one event per five minutes. Duplicate
signup responses do not manufacture new-account events. Passwords, OTPs,
session tokens and saved reading content are excluded.

The shared schema defines `#critical`, `#signup`, `#login`, `#media`, `#archive`,
`#account`, `#email`, `#verification`, `#system`, `#recovery` and `#ratelimit`.
Account relay events preserve severity and allowlisted account fields.

## FloodWait fix

The old media endpoint treated every unhandled Telegram error as a critical
delivery failure. Telethon's `flood_sleep_threshold=0` exposes FloodWaits to the
application, so lookup rate limits reached that generic error handler. See
[Telethon RPC errors](https://docs.telethon.dev/en/stable/concepts/errors.html).
The supplied historical notification does not include the wait duration or
request type, so it cannot establish what triggered Telegram's limit.

FloodWait now logs **Media rate limited** with `#media #ratelimit`, the post,
lookup/download stage and retry delay. All new media requests share a cooldown
and return HTTP 503 with `Retry-After` and `X-Media-Status: rate-limited`.
Short download pauses (up to five seconds including a safety margin) retry twice
at most and resume the exact byte range. Longer pauses terminate the stream;
subsequent requests advertise the cooldown. Already-sent HTTP headers cannot
be replaced with a 503 status. FloodWait retains Telegram authorization and
does not send a critical owner DM. Genuine delivery failures still do.

## Apply to the VPS

Transfer the bundle using your usual SSH hostname/key:

```bash
scp "/Users/vr/Code-space/VN Reader/output/operator-logs-update.tar.gz" ubuntu@VPS_IP:~/operator-logs-update.tar.gz
```

On the VPS, back up the existing application data using the procedure in
`deploy/README.md`, then save the source files this bundle will replace:

```bash
cd ~/vn-reader
tar -czf "../operator-logs-source-before-$(date +%Y%m%d-%H%M%S).tar.gz" \
  server/accounts.mjs server/accountService.mjs server/notifications.mjs \
  server/notifications.py server/telegram.py server/streaming.py server/mirror.py \
  deploy/Dockerfile deploy/Dockerfile.telegram server/TELEGRAM.md \
  server/README.md deploy/README.md tests/notifications.test.mjs \
  server/tests/test_notifications.py server/tests/test_media_api.py
tar -xzf ~/operator-logs-update.tar.gz -C ~/vn-reader
dc() {
  docker compose --env-file .env.production \
    -f compose.yaml -f deploy/compose.tunnel.yaml "$@"
}
dc config --quiet
dc build archive accounts mirror
dc up -d --no-deps archive accounts mirror
dc ps archive accounts mirror
dc logs --tail 30 archive accounts mirror
curl -fsS https://vidurneeti.xyz/api/health
curl -fsS https://vidurneeti.xyz/api/archive-health
```

Rebuilding only `web` cannot apply these changes. Both backend Dockerfiles
now copy `server/operatorEvents.json`. No database migration or frontend build
is needed. Keep these source changes in the VN-Reader repository before future
Git pulls; direct archive extraction changes the VPS checkout.

Confirm bold titles, quotes and tags on the next genuine signup/login/archive
event. No live test account or Telegram test message was created during local
verification. Historical Telegram notifications keep their previous format.

## Validation

- JavaScript regression suite: 157 passed.
- Python archive/media/notification regression suite: 104 passed.
- Coverage includes private identity fields, HTML escaping, authenticated relay
  validation, critical severity, duplicate signup, failed login, retry deadlines,
  exact stream resumption, retry bounds and semaphore cleanup.
- Docker builds and VPS deployment were not run locally.

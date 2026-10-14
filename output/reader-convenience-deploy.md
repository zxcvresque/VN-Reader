# Reader convenience, navigation and operator logs update

Implemented and verified locally; not deployed to the VPS. This combined bundle
supersedes the earlier operator-logs and navigation-usability bundles for the
files it contains. It includes their changes plus the approved convenience fixes.
The archive contains source, tests and documentation, with no environment files,
credentials, databases, Telegram sessions, media or sample QA data.

Colors and theme palettes are retained. Stable post URLs/browser history are
explanation-only and are not included.

## Apply

Transfer using your usual SSH hostname/key:

```bash
scp "/Users/vr/Code-space/VN Reader/output/reader-convenience-update.tar.gz" ubuntu@VPS_IP:~/reader-convenience-update.tar.gz
```

On the VPS, back up application data using `deploy/README.md`. Also preserve
the source before extracting this update:

```bash
cd ~/vn-reader
tar -czf "../reader-convenience-source-before-$(date +%Y%m%d-%H%M%S).tar.gz" \
  src server deploy tests docs
tar -xzf ~/reader-convenience-update.tar.gz -C ~/vn-reader
dc() {
  docker compose --env-file .env.production \
    -f compose.yaml -f deploy/compose.tunnel.yaml "$@"
}
dc config --quiet
dc build archive accounts mirror web
dc up -d --no-deps archive accounts mirror web
dc ps archive accounts mirror web
dc logs --tail 30 archive accounts mirror web
curl -fsS https://vidurneeti.xyz/api/health
curl -fsS https://vidurneeti.xyz/api/archive-health
```

Rebuild all four services: the frontend, Caddy archive caching policy, Python
metadata/revision logic and Node operator logs have changed. Revision tracking
creates its table and triggers automatically in the existing SQLite archive.
Keep these source changes in the VN-Reader repository before future Git pulls.

## Verify

- On a phone, visit Read, Threads, Bookmarks and Progress, hide navigation and
  restore it from each toolbar. Progress must have no Focus button and its title
  must stay above the scrolling chart. Timeline filters should expand on demand.
- Preview a timeline post and choose Read this post. Scroll above and below it.
  Your reading should show the number/date of the post occupying most of the
  viewport; returning to a saved position should preserve its paragraph.
- Save a display name. The account dialog should stay open and show success.
  After an initial session-network failure, Retry connection should discover
  the existing session without mixing guest and account data.
- In browser Network tools, a first archive response should contain ETag.
  Unchanged polling sends If-None-Match and reuses the archive. New posts or
  edited stored post records must change the validator.
- During a genuine Telegram cooldown, media shows a disabled retry countdown
  and retries only after the advertised wait while visible. Operator logs use
  bold titles/labels, quotes, category tags, reader identity and cooldown detail.
  Historical notifications retain their old format.

## Local validation

Production TypeScript/Vite build passed; 188 JavaScript tests and 130 Python
tests passed. Sample-data mobile browser checks cover full-feed post navigation,
the current-post label, compact filters and toolbar bounds. No Docker build,
live Telegram request, production traffic measurement or VPS deployment was run.
See `docs/ux-backend-review-2026-10-13.md` for the findings and explanations.

# R2 media archive for vidurneeti.xyz

Media is archived durably in Cloudflare R2 and served with byte-range support.
The Telegram private group remains the source of truth; R2 is a CDN offload.
If R2 is unavailable the reader falls back to Telegram streaming.

## Key facts (correct)

* Free tier **per Cloudflare account**: **10 GiB stored**, **1M Class A** (writes/lists), **10M Class B** (reads), **free egress**.
* Beyond the quota Cloudflare **auto-bills** (`$0.015/GB-mo` storage, `$4.50/M` Class A). This project adds **hard caps so it never bills**.
* A **custom domain** (`media.vidurneeti.xyz`) can only be attached to **one account's bucket**. So: **primary bucket is public** (`media.vidurneeti.xyz`), **secondary bucket stays private** and is served **through the VPS** (`/api/media` via `r2_stream`). No second domain needed.

---

## 1) Cloudflare setup — step by step

You need **two Cloudflare accounts** to get 2 × 10 GB free (e.g. personal + workspace). Only the **primary** needs a custom domain.

### Account 1 — primary (public)

1. Log in to Cloudflare dashboard for account 1.
2. **R2 → Create bucket** → name `vn-reader-media` (lowercase, DNS-safe). Location: Automatic.
3. Bucket → **Settings** → **Custom Domains** → **Connect Domain** → enter `media.vidurneeti.xyz` → **Connect**.
   * Cloudflare validates that `vidurneeti.xyz` is in **this** account's zone and creates proxied DNS + TLS.
4. **R2 → Manage R2 API Tokens** → **Create API Token** → choose *Admin Read & Write* or custom **Object Read & Write** scoped to `vn-reader-media`. Copy:
   * **Account ID** (shown at top of R2 page / URL)
   * **Access Key ID**
   * **Secret Access Key**
5. Bucket → **Settings** → enable **Public access** via the custom domain (R2 does this when you connect a domain; object ACL stays private but CDN is public).

### Account 2 — secondary (private, no domain)

1. Log in to Cloudflare dashboard for account 2 (different email).
2. **R2 → Create bucket** → name `vn-reader-media-2`.
3. **Do NOT** add a custom domain — it would fail because `vidurneeti.xyz` already belongs to account 1, and we don't need one. The VPS fetches from this bucket via the S3 API and re-serves it; the browser never hits it directly.
4. **Manage R2 API Tokens** → Create token scoped to `vn-reader-media-2`. Copy Account ID + keys.

> If you later want a second public hostname (e.g. `media2.vidurneeti.xyz`), add it as a CNAME to a different zone or use Cloudflare's `r2.dev` subdomain — not required.

---

## 2) Server configuration

Edit the existing `.env` in the repository root (see `server/.env.example` for available settings). Keep Telegram, authentication, SMTP and R2 settings in that same file; Compose forwards R2 settings to both `archive` and `mirror`.

```ini
# Primary (public, media.vidurneeti.xyz)
R2_ENABLED=1
R2_ACCOUNT_ID=<account-1 id>
R2_ACCESS_KEY_ID=<...>
R2_SECRET_ACCESS_KEY=<...>
R2_BUCKET=vn-reader-media
R2_PUBLIC_BASE_URL=https://media.vidurneeti.xyz

# Leave empty until a second account is configured (private; VPS will proxy)
R2_SECONDARY_ACCOUNT_ID=
R2_SECONDARY_ACCESS_KEY_ID=
R2_SECONDARY_SECRET_ACCESS_KEY=
R2_SECONDARY_BUCKET=vn-reader-media-2
R2_SECONDARY_PUBLIC_BASE_URL=

# Optional kill switches
# R2_DISABLE_WRITES=0   # set to 1 to pause all R2 uploads without disabling reads
```

Install deps + restart:

```sh
pip install -r requirements.txt   # adds boto3 + botocore
# restart archive + mirror (see VPS commands below)
```

`R2_ENABLED` must be `1` for writes. Writes are no-op until a primary bucket is cred-complete.

---

## 3) How it works

* **Writes:** after Telegram copy, the mirror downloads bytes from Telegram and `PUT`s to R2 as `{year}/{postId}/{filename}` (e.g. `2026/18420/photo.jpg`). Primary is used until **100%**; then writes auto-switch to secondary. Each `PUT` is counted in `tg_r2_counters` for the monthly Class A cap.
* **Reads:** `GET /api/media/:postId` checks `tg_r2_media`:
  * If an R2 row exists → if it's a **primary** object, redirect/serve with `X-Media-Source: r2` and `public, max-age=1y`; if **secondary**, stream through the VPS via `r2_stream` (still `X-Media-Source: r2`).
  * Otherwise → fall back to Telegram streaming (`telegram_chunks`). No client change.
* **Archive ETag:** each `tg_r2_media` write bumps `tg_archive_state.revision`, so `/api/archive` ETag changes and browsers refetch the new `media_path` URLs.
* **Caching:** `Cache-Control: public, max-age=31536000, immutable` on R2 objects; Cloudflare edge caches primary domain hits.

---

## 4) Hard caps — multilayer billing lock

So free tier is never exceeded:

| Layer | What | Where | Fails to |
|-------|------|-------|----------|
| **1 — Storage ceiling** | `bytes_used + upcoming_bytes + 50 MiB headroom > 10 GiB` blocks the write | `r2_store._check_limits()` per `PUT` | Telegram fallback |
| **2 — Class A counter** | SQLite `tg_r2_counters` counts `PUT`s per UTC month; cap **1,000,000** | `record_class_a()` after each successful write; checked pre-flight | Pause writes till next month |
| **3 — Stats cache** | `ListObjectsV2` (itself Class A) cached **5 min** TTL | `bucket_stats()` memo | Avoid spam |
| **4 — Kill switches** | `R2_ENABLED=0` or `R2_DISABLE_WRITES=1` | `load_r2_config()` + `_check_limits()` | Fully pause writes |

* **Class B (10M reads/month)** is *not* hard-capped — it's 10× headroom and capping reads would break the reader. Still: primary reads hit CF edge, not R2.
* Layer 1 keeps a **50 MiB headroom** so a single large upload can't tip the bucket over.
* When **all buckets are capped**, `upload_to_r2` returns `None`; the post remains on Telegram and will be retried on next `backfill`.

---

## 5) Admin & alerts

* **Widget:** admin panel → R2 bars per bucket (percent, objects, free bytes), refreshable. Source: `GET /api/admin/r2-stats` → `GET /api/r2-stats` (bearer-gated for direct callers).
* **Operator bot** (Logs topic + owner DM):
  * **90%** — routine `R2 storage 90% full`
  * **95%** — **critical** `R2 storage 95% full` (also owner DM)
  * **100%** → **critical** `R2 storage full — switched to secondary bucket` (owner DM)
* API also exposes `localR2Rows` (SQLite index count/size, no R2 call).

---

## 6) Backfill existing media

Already-copied posts still serve from Telegram until migrated:

```sh
python -m server.r2_backfill --dry-run
python -m server.r2_backfill --dry-run --limit 100
python -m server.r2_backfill
python -m server.r2_backfill --limit 500
```

Streams from the private group via the bot; respects `FloodWait`; skips rows already in `tg_r2_media`. Safe to interrupt and resume. Honors Class A + storage caps.

---

## 7) VPS commands — vidurneeti.xyz deploy

Assume `deploy/` Compose stack from `deploy/README.md`. `dc` loads that same root `.env` for the Compose stack:

```sh
dc() { docker compose --env-file .env -f compose.yaml -f deploy/compose.tunnel.yaml "$@"; }

# --- one-time secrets ---
# Put Cloudflare tunnel token in deploy/secrets/cloudflare-tunnel-token (600 perms)
# Put R2 creds in .env on the VPS (600 perms), NOT in git.

# Validate configuration without printing secrets
dc config --quiet

# --- deploy / restart ---
# After editing .env on the VPS, rebuild the python image + restart
dc build archive mirror web        # or: docker compose build archive mirror web
dc up -d archive mirror web
dc logs -f archive                 # check: "Telegram media connection ready"
dc logs -f mirror                  # check: "R2 uploaded post #..." on new posts

# --- verify ---
curl -fsS http://127.0.0.1:8000/api/archive | jq .counts
curl -H "Authorization: Bearer $TELEGRAM_BOT_TOKEN" http://127.0.0.1:8000/api/r2-stats | jq
curl -I https://media.vidurneeti.xyz/2026/<id>/photo.jpg   # direct R2 object (primary only)
curl -I http://127.0.0.1:8000/api/media/<id> | grep -i x-media-source  # r2 or telegram

# Range smoke test
curl -H 'Range: bytes=0-99' http://127.0.0.1:8000/api/media/<id> -o /tmp/part && wc -c /tmp/part  # → 100

# --- backfill on VPS (stop mirror so only one reader session is active) ---
dc stop mirror
trap 'dc up -d mirror' EXIT
dc run --rm --no-deps mirror python -u -m server.r2_backfill --dry-run
dc run --rm --no-deps mirror python -u -m server.r2_backfill
# rerun with --limit 200 in batches if you prefer

# --- emergency pause (no billing) ---
# On VPS .env:
# R2_DISABLE_WRITES=1
dc up -d --force-recreate archive mirror
# Writes stop; reads still served from R2 + Telegram.

# --- local dev ---
# Same .env vars; Vite proxies /api/media → :8000 (R2-aware) and /api/admin/r2-stats → :3005
```

---

## 8) Cost note (updated)

Per Cloudflare account: **10 GB + 1M Class A + 10M Class B per month** free; beyond that `$0.015/GB-mo` and `$4.50/M` Class A (egress still free). With primary public + secondary private, 20 GB total stays free. Hard caps above keep the free tier from billing — if you outgrow 20 GB, create a third account or enable paid overage deliberately.

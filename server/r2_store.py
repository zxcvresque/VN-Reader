"""Cloudflare R2 archive — dual-account sharded storage for vidurneeti.xyz.

Why two accounts
────────────────
A Cloudflare account's free quota is per-account.  A custom domain
(media.vidurneeti.xyz) can only be connected to ONE account's bucket.
So the primary bucket is public (media.vidurneeti.xyz) and the secondary
bucket stays **private** — served only through the VPS's /api/media
(r2_stream).  The browser never contacts the secondary domain directly.

Free tier (per account, auto-bills if exceeded — so we hard-cap)
──────────────────────────────────────────────────────────────────
  Storage: 10 GiB
  Class A (writes: PUT, POST, List): 1M / month
  Class B (reads: GET, HEAD):        10M / month
  Egress: free

Hard-cap design (multilayer, local-first)
─────────────────────────────────────────
  Layer 1  Per-bucket storage ceiling — refuse upload when bytes would
           exceed the free quota.
  Layer 2  Monthly Class A counter in SQLite (tg_r2_counters) — refuse
           when 1M writes would be exceeded in the current UTC month.
           Class B is intentionally not capped (10M headroom); still tracked
           would add noise.  Writes are the scarcer resource.
  Layer 3  Stats cache (5 min TTL) — avoid repeated ListObjectsV2 that
           itself burns Class A ops.
  Layer 4  Kill switches — R2_ENABLED + R2_DISABLE_WRITES env flags.

Requires ``boto3`` and ``botocore`` at runtime.  Absence degrades to no-op.
"""
from __future__ import annotations

import logging
import mimetypes
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# Free tier — Cloudflare bills $0.015/GB-mo + $4.50/M Class A beyond this.
FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB
FREE_TIER_CLASS_A = 1_000_000             # 1M writes/lists per month
FREE_TIER_CLASS_B = 10_000_000            # 10M reads per month (not hard-capped)

# Alert thresholds (percent of storage quota)
WARN_90_PCT = 0.90
WARN_95_PCT = 0.95
# Switch primary→secondary at 100% (after 95% owner DM)
AUTO_SWITCH_PCT = 1.0

# Safety floor: even before 100%, keep at least this headroom before allowing a write
# (prevents a single large upload tipping the bucket over).
WRITE_HEADROOM_BYTES = 50 * 1024 * 1024  # 50 MiB

_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$")
_MISSING_BOTO = "boto3 is required for R2 operations (pip install boto3 botocore)"

# Stats cache — ListObjectsV2 costs Class A, so avoid hammering it.
_STATS_TTL_SECONDS = 300  # 5 minutes
_stats_cache: dict[str, tuple[float, "BucketStats"]] = {}


@dataclass
class R2Account:
    account_id: str
    access_key: str
    secret_key: str
    bucket: str
    public_base: str  # e.g. https://media.vidurneeti.xyz (empty for secondary/private)

    @property
    def endpoint(self) -> str:
        return f"https://{self.account_id}.r2.cloudflarestorage.com"

    @property
    def cache_key(self) -> str:
        return f"{self.account_id}:{self.bucket}"


@dataclass
class R2Config:
    primary: R2Account | None
    secondary: R2Account | None
    enabled: bool = False
    writes_disabled: bool = False

    @property
    def active_accounts(self) -> list[R2Account]:
        return [a for a in (self.primary, self.secondary) if a is not None]


def _account(prefix: str) -> R2Account | None:
    aid = os.getenv(f"{prefix}_ACCOUNT_ID", "").strip()
    key = os.getenv(f"{prefix}_ACCESS_KEY_ID", "").strip()
    secret = os.getenv(f"{prefix}_SECRET_ACCESS_KEY", "").strip()
    bucket = os.getenv(f"{prefix}_BUCKET", "").strip()
    base = os.getenv(f"{prefix}_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not (aid and key and secret and bucket):
        return None
    if not _BUCKET_RE.match(bucket):
        log.warning("R2 bucket name %r looks invalid — check %s_BUCKET", bucket, prefix)
    return R2Account(account_id=aid, access_key=key, secret_key=secret, bucket=bucket, public_base=base)


def load_r2_config() -> R2Config:
    enabled = os.getenv("R2_ENABLED", "").lower() in {"1", "true", "yes"}
    primary = _account("R2")
    secondary = _account("R2_SECONDARY")
    if primary and os.getenv("R2_ENABLED", "") == "":
        enabled = True
    writes_disabled = os.getenv("R2_DISABLE_WRITES", "").lower() in {"1", "true", "yes"}
    return R2Config(primary=primary, secondary=secondary, enabled=bool(enabled and primary), writes_disabled=writes_disabled)


def _client_for(account: R2Account):
    try:
        import boto3  # type: ignore
    except ImportError as exc:
        raise RuntimeError(_MISSING_BOTO) from exc
    return boto3.client(
        "s3",
        endpoint_url=account.endpoint,
        aws_access_key_id=account.access_key,
        aws_secret_access_key=account.secret_key,
        region_name="auto",
    )


# ───────────────────────── key helpers ─────────────────────────


def r2_key(year: int | str, source_id: int, filename: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename or "media")[:180] or "media"
    return f"{year}/{source_id}/{safe}"


def year_from_date(date_utc: str | None) -> str:
    if date_utc and len(date_utc) >= 4 and date_utc[:4].isdigit():
        return date_utc[:4]
    return str(time.gmtime().tm_year)


# ──────────────── upload / download helpers ────────────────

def public_url(account: R2Account, key: str) -> str:
    if account.public_base:
        return f"{account.public_base}/{key}"
    # Private secondary — VPS will proxy via /api/media, not a direct URL
    return f"r2://{account.bucket}/{key}"


def upload_bytes(
    account: R2Account,
    key: str,
    data: bytes,
    content_type: str | None = None,
    cache_control: str = "public, max-age=31536000, immutable",
) -> str:
    client = _client_for(account)
    ct = content_type or mimetypes.guess_type(key)[0] or "application/octet-stream"
    client.put_object(
        Bucket=account.bucket,
        Key=key,
        Body=data,
        ContentType=ct,
        CacheControl=cache_control,
    )
    return public_url(account, key)


def upload_file(account: R2Account, key: str, path: str | Path, content_type: str | None = None) -> str:
    data = Path(path).read_bytes()
    return upload_bytes(account, key, data, content_type=content_type)


def download_bytes(account: R2Account, key: str) -> bytes:
    client = _client_for(account)
    resp = client.get_object(Bucket=account.bucket, Key=key)
    return resp["Body"].read()


def head_object(account: R2Account, key: str) -> dict | None:
    client = _client_for(account)
    try:
        return client.head_object(Bucket=account.bucket, Key=key)
    except Exception as exc:
        if "404" in str(exc) or "NoSuchKey" in str(exc.__class__.__name__) or "NotFound" in str(exc):
            return None
        raise


def delete_object(account: R2Account, key: str) -> None:
    _client_for(account).delete_object(Bucket=account.bucket, Key=key)


# ─────────────────────── capacity / stats ──────────────────────

@dataclass
class BucketStats:
    bucket: str
    account_id: str
    objects: int
    bytes_used: int
    quota_bytes: int = FREE_TIER_BYTES

    @property
    def percent(self) -> float:
        return (self.bytes_used / self.quota_bytes * 100) if self.quota_bytes else 0

    @property
    def bytes_free(self) -> int:
        return max(0, self.quota_bytes - self.bytes_used)

    def to_dict(self) -> dict:
        return {
            "bucket": self.bucket,
            "accountId": self.account_id[:8] + "…",
            "objects": self.objects,
            "bytesUsed": self.bytes_used,
            "bytesFree": self.bytes_free,
            "quotaBytes": self.quota_bytes,
            "percentUsed": round(self.percent, 2),
        }


def bucket_stats(account: R2Account, *, force: bool = False) -> BucketStats:
    """Sum size via ListObjectsV2 — cached for 5 min to save Class A ops."""
    now = time.monotonic()
    ck = account.cache_key
    if not force and ck in _stats_cache:
        ts, cached = _stats_cache[ck]
        if now - ts < _STATS_TTL_SECONDS:
            return cached
    client = _client_for(account)
    total_bytes = 0
    total_objects = 0
    token: str | None = None
    while True:
        kwargs: dict = {"Bucket": account.bucket, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            total_bytes += int(obj.get("Size", 0))
            total_objects += 1
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    stats = BucketStats(bucket=account.bucket, account_id=account.account_id, objects=total_objects, bytes_used=total_bytes)
    _stats_cache[ck] = (now, stats)
    return stats


def invalidate_stats_cache(account: R2Account | None = None) -> None:
    if account:
        _stats_cache.pop(account.cache_key, None)
    else:
        _stats_cache.clear()


# ──────────────────── monthly Class A counter ────────────────────

def _month_key() -> str:
    return time.strftime("%Y-%m", time.gmtime())


def _counter_table(db) -> None:
    db.execute(
        "CREATE TABLE IF NOT EXISTS tg_r2_counters("
        " month TEXT NOT NULL, bucket TEXT NOT NULL, class TEXT NOT NULL,"
        " count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(month, bucket, class))"
    )


def record_class_a(db, bucket: str, n: int = 1) -> int:
    """Increment Class A counter for this UTC month. Returns new count."""
    _counter_table(db)
    mk = _month_key()
    db.execute(
        "INSERT INTO tg_r2_counters(month,bucket,class,count) VALUES(?,?, 'A', ?) "
        "ON CONFLICT(month,bucket,class) DO UPDATE SET count=count+excluded.count",
        (mk, bucket, n),
    )
    db.commit()
    row = db.execute("SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='A'", (mk, bucket)).fetchone()
    return int(row[0] if row else n)


def class_a_used(db, bucket: str) -> int:
    try:
        _counter_table(db)
        row = db.execute("SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='A'", (_month_key(), bucket)).fetchone()
        return int(row[0] if row else 0)
    except Exception:
        return 0


def _check_limits(db, account: R2Account, upcoming_bytes: int = 0) -> tuple[bool, str]:
    """Return (allowed, reason_if_blocked).  Layer 1+2 hard caps."""
    # Layer 4: global kill switch
    cfg = load_r2_config()
    if cfg.writes_disabled:
        return False, "R2 writes disabled by R2_DISABLE_WRITES=1"
    # Layer 2: Class A monthly cap
    used_a = class_a_used(db, account.bucket)
    if used_a >= FREE_TIER_CLASS_A:
        return False, f"Class A limit reached ({used_a}/{FREE_TIER_CLASS_A} this month) — writes paused until next month"
    # Layer 1: storage ceiling (+ headroom)
    try:
        stats = bucket_stats(account)
    except Exception:
        # If we can't probe, be conservative: deny if Class A already high
        if used_a >= FREE_TIER_CLASS_A * 0.9:
            return False, "Cannot verify R2 storage — Class A already at 90% so writes are paused"
        return True, ""
    if stats.bytes_used + upcoming_bytes + WRITE_HEADROOM_BYTES > FREE_TIER_BYTES:
        return False, f"Bucket {account.bucket} at {stats.percent:.1f}% ({stats.bytes_used} bytes) — headroom would be exceeded"
    return True, ""


# ──────────────────── write account chooser ────────────────────

def choose_account_for_write(config: R2Config, db=None, *, upcoming_bytes: int = 0, primary_stats: "BucketStats | None" = None) -> R2Account | None:
    """Return the account that should receive the next upload, or None if blocked.

    Probes storage + Class A counters; auto-switches to secondary at 100%.
    """
    if not config.enabled or not config.primary:
        return None
    if config.writes_disabled:
        log.warning("R2 writes disabled by R2_DISABLE_WRITES")
        return None

    # Resolve primary fullness
    if db is not None:
        ok, reason = _check_limits(db, config.primary, upcoming_bytes)
        if not ok:
            log.warning("Primary R2 blocked: %s", reason)
            if config.secondary:
                # Try secondary
                ok2, reason2 = _check_limits(db, config.secondary, upcoming_bytes)
                if not ok2:
                    log.error("Secondary R2 also blocked: %s", reason2)
                    return None
                log.warning("Switching R2 writes to secondary (%s) — primary: %s", config.secondary.bucket, reason)
                return config.secondary
            return None
        return config.primary

    # No DB available — fall back to storage percent only
    if not config.secondary:
        return config.primary
    if primary_stats is None:
        try:
            primary_stats = bucket_stats(config.primary)
        except Exception:
            log.warning("Could not probe primary R2 bucket — using primary anyway", exc_info=True)
            return config.primary
    if primary_stats.bytes_used + upcoming_bytes + WRITE_HEADROOM_BYTES > FREE_TIER_BYTES:
        log.warning("Primary R2 bucket at %.1f%% — switching writes to secondary", primary_stats.percent)
        return config.secondary
    return config.primary


def find_account_for_key(config: R2Config, key: str) -> R2Account | None:
    for acct in config.active_accounts:
        try:
            if head_object(acct, key) is not None:
                return acct
        except Exception:
            continue
    return None


# ──────────────── threshold check ────────────

@dataclass
class ThresholdState:
    pct: float
    crossed_90: bool
    crossed_95: bool
    crossed_100: bool


_last_thresholds: dict[str, ThresholdState] = {}


def check_thresholds(stats: BucketStats, bucket_label: str = "primary") -> ThresholdState | None:
    pct = stats.percent / 100
    crossed_90 = pct >= WARN_90_PCT
    crossed_95 = pct >= WARN_95_PCT
    crossed_100 = pct >= 1.0
    prev = _last_thresholds.get(bucket_label)
    if prev and prev.pct >= pct:
        return None
    should_emit = False
    if crossed_95 and (not prev or not prev.crossed_95):
        should_emit = True
    elif crossed_90 and (not prev or not prev.crossed_90):
        should_emit = True
    elif crossed_100 and (not prev or not prev.crossed_100):
        should_emit = True
    _last_thresholds[bucket_label] = ThresholdState(pct=pct, crossed_90=crossed_90, crossed_95=crossed_95, crossed_100=crossed_100)
    return _last_thresholds[bucket_label] if should_emit else None


def reset_threshold_state() -> None:
    _last_thresholds.clear()

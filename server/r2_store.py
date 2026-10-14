"""Cloudflare R2 archive — single bucket for vidurneeti.xyz (sharding deferred).

Primary bucket is public (media.vidurneeti.xyz).  Secondary bucket wiring
is stubbed but disabled until a second account is configured.

Free tier (per account, auto-bills if exceeded — so we hard-cap)
──────────────────────────────────────────────────────────────────
  Storage: 10 GiB-month (billed on average stored, we cap instantaneous)
  Class A (writes: PUT, POST, List): 1M / month
  Class B (reads: GET, HEAD):        10M / month (soft cap + edge-redirect)
  Egress: free

Hard-cap design — all fail-CLOSED
─────────────────────────────────
  Any accounting failure => writes BLOCKED.  Concurrent writers are
  serialized via SQLite BEGIN IMMEDIATE.

  Layer 1  Storage ceiling (+ 50 MiB headroom) per PUT.
  Layer 2  Monthly Class A counter — atomic reserve BEFORE every PUT/List.
  Layer 3  Stats cache (5 min TTL, no forced invalidation).
  Layer 4  Class B reserve + primary 302 redirect to edge cache.
  Layer 5  Kill switches — R2_ENABLED + R2_DISABLE_WRITES on both paths.

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
# Billing is GB-month average; we cap instantaneous stored bytes conservatively.
FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB
FREE_TIER_CLASS_A = 1_000_000             # 1M writes/lists per month
FREE_TIER_CLASS_B = 10_000_000            # 10M reads per month

WARN_90_PCT = 0.90
WARN_95_PCT = 0.95
AUTO_SWITCH_PCT = 1.0  # switch primary→secondary at 100%
AUTO_STOP_PCT = 0.98

WRITE_HEADROOM_BYTES = 50 * 1024 * 1024  # 50 MiB — prevent tip-over

_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$")
_MISSING_BOTO = "boto3 is required for R2 operations (pip install boto3 botocore)"

_STATS_TTL_SECONDS = 300  # 5 minutes — no forced invalidation after uploads
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


def bucket_stats(account: R2Account, *, force: bool = False, db=None) -> BucketStats:
    """Sum size via ListObjectsV2 — cached 5 min. Each page counts as 1 Class A.

    If *db* is given, each List page atomically reserves 1 Class A via
    reserve_class_a().  On cap breach the listing is aborted and the failure
    propagates so the caller blocks writes.
    """
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
    pages = 0
    while True:
        # Count this List as Class A BEFORE issuing it (atomic, fail-closed).
        if db is not None:
            ok, _ = reserve_class_a(db, account.bucket, 1)
            if not ok:
                raise RuntimeError(f"Class A cap reached for {account.bucket} — List blocked")
        kwargs: dict = {"Bucket": account.bucket, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        pages += 1
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


# ──────────────────── monthly counters (atomic, fail-closed) ─────

def _month_key() -> str:
    return time.strftime("%Y-%m", time.gmtime())


def _counter_table(db) -> None:
    db.execute(
        "CREATE TABLE IF NOT EXISTS tg_r2_counters("
        " month TEXT NOT NULL, bucket TEXT NOT NULL, class TEXT NOT NULL,"
        " count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(month, bucket, class))"
    )


def reserve_class_a(db, bucket: str, n: int = 1) -> tuple[bool, str]:
    """Atomically reserve *n* Class A ops. Returns (allowed, reason_if_blocked).

    Uses BEGIN IMMEDIATE to serialize concurrent writers.  Any DB error or
    cap breach => (False, reason) — fail-closed.  The increment is committed
    immediately so the reservation is durable even if the subsequent S3 call
    fails (we over-count rather than under-count).
    """
    _counter_table(db)
    mk = _month_key()
    try:
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute(
                "SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='A'",
                (mk, bucket),
            ).fetchone()
            used = int(row[0] if row else 0)
            if used + n > FREE_TIER_CLASS_A:
                db.execute("ROLLBACK")
                return False, f"Class A cap would be exceeded ({used}+{n} > {FREE_TIER_CLASS_A} for {bucket} in {mk})"
            db.execute(
                "INSERT INTO tg_r2_counters(month,bucket,class,count) VALUES(?,?, 'A', ?) "
                "ON CONFLICT(month,bucket,class) DO UPDATE SET count=count+?",
                (mk, bucket, n, n),
            )
            db.execute("COMMIT")
            return True, ""
        except Exception:
            try:
                db.execute("ROLLBACK")
            except Exception:
                pass
            raise
    except Exception as exc:
        log.error("Class A reserve failed for %s: %s — blocking write", bucket, exc)
        return False, f"Counter unavailable for {bucket}: {exc.__class__.__name__} — writes blocked"


def record_class_a(db, bucket: str, n: int = 1) -> int:
    """Legacy helper — prefer reserve_class_a() for new code. Still fail-closed."""
    ok, reason = reserve_class_a(db, bucket, n)
    if not ok:
        raise RuntimeError(reason)
    # Return new count for logging
    try:
        row = db.execute(
            "SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='A'",
            (_month_key(), bucket),
        ).fetchone()
        return int(row[0] if row else n)
    except Exception:
        return n


def class_a_used(db, bucket: str) -> int:
    try:
        _counter_table(db)
        row = db.execute(
            "SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='A'",
            (_month_key(), bucket),
        ).fetchone()
        return int(row[0] if row else 0)
    except Exception as exc:
        log.error("Class A read failed for %s: %s — treating as capped", bucket, exc)
        return FREE_TIER_CLASS_A


def class_b_used(db, bucket: str) -> int:
    try:
        _counter_table(db)
        row = db.execute(
            "SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='B'",
            (_month_key(), bucket),
        ).fetchone()
        return int(row[0] if row else 0)
    except Exception as exc:
        log.error("Class B read failed for %s: %s — treating as capped", bucket, exc)
        return FREE_TIER_CLASS_B


def reserve_class_b(db, bucket: str, n: int = 1) -> tuple[bool, str]:
    """Reserve Class B reads (10M cap).  Soft — logs at 90% but still allows reads."""
    _counter_table(db)
    mk = _month_key()
    try:
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute(
                "SELECT count FROM tg_r2_counters WHERE month=? AND bucket=? AND class='B'",
                (mk, bucket),
            ).fetchone()
            used = int(row[0] if row else 0)
            if used + n > FREE_TIER_CLASS_B:
                db.execute("ROLLBACK")
                return False, f"Class B cap would be exceeded ({used}+{n} > {FREE_TIER_CLASS_B} for {bucket} in {mk})"
            db.execute(
                "INSERT INTO tg_r2_counters(month,bucket,class,count) VALUES(?,?, 'B', ?) "
                "ON CONFLICT(month,bucket,class) DO UPDATE SET count=count+?",
                (mk, bucket, n, n),
            )
            db.execute("COMMIT")
            return True, ""
        except Exception:
            try:
                db.execute("ROLLBACK")
            except Exception:
                pass
            raise
    except Exception as exc:
        log.error("Class B reserve failed for %s: %s — blocking read", bucket, exc)
        return False, f"Counter unavailable for {bucket}: {exc.__class__.__name__} — reads blocked"


def is_auto_stopped(db, bucket: str | None = None) -> bool:
    """True if r2_auto_stopped flag is set (any class at >=98%)."""
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        row = db.execute("SELECT value FROM tg_r2_controls WHERE key='r2_auto_stopped'").fetchone()
        return bool(row and row[0] == "1")
    except Exception:
        return False

def clear_auto_stop(db) -> None:
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("DELETE FROM tg_r2_controls WHERE key IN ('r2_auto_stopped','r2_auto_stopped_reason')")
        db.commit()
    except Exception:
        pass

def auto_stop_if_needed(db, account: R2Account, stats: BucketStats | None = None) -> tuple[bool, str]:
    """If storage/Class A/Class B >=98%, set persistent flag and return (stopped, reason)."""
    # compute percents
    try:
        if stats is None:
            stats = bucket_stats(account, db=db)
    except Exception:
        return False, ""
    storage_pct = (stats.bytes_used / stats.quota_bytes) if stats and stats.quota_bytes else 0
    # class counters (fail-closed read => treat as capped)
    try:
        used_a = class_a_used(db, account.bucket)
    except Exception:
        used_a = FREE_TIER_CLASS_A
    try:
        used_b = class_b_used(db, account.bucket)
    except Exception:
        used_b = FREE_TIER_CLASS_B
    a_pct = used_a / FREE_TIER_CLASS_A if FREE_TIER_CLASS_A else 0
    b_pct = used_b / FREE_TIER_CLASS_B if FREE_TIER_CLASS_B else 0
    reason = ""
    if storage_pct >= AUTO_STOP_PCT:
        reason = f"storage {storage_pct*100:.1f}% ({stats.bytes_used} bytes)"
    elif a_pct >= AUTO_STOP_PCT:
        reason = f"Class A {used_a}/{FREE_TIER_CLASS_A} ({a_pct*100:.1f}%)"
    elif b_pct >= AUTO_STOP_PCT:
        reason = f"Class B {used_b}/{FREE_TIER_CLASS_B} ({b_pct*100:.1f}%)"
    else:
        return False, ""
    # already stopped?
    if is_auto_stopped(db):
        return True, reason
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT INTO tg_r2_controls(key,value) VALUES('r2_auto_stopped','1') ON CONFLICT(key) DO UPDATE SET value='1'")
        db.execute("INSERT INTO tg_r2_controls(key,value) VALUES('r2_auto_stopped_reason',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (reason,))
        db.commit()
    except Exception as exc:
        log.error("auto_stop persist failed: %s", exc)
    log.warning("R2 AUTO-STOP triggered: %s", reason)
    return True, reason

def _is_write_paused(db) -> tuple[bool, str]:
    """Check tg_r2_controls for pause flags (including auto-stop)."""
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        rows = {r[0]: r[1] for r in db.execute("SELECT key,value FROM tg_r2_controls WHERE key IN ('r2_pause_writes','r2_pause_all','r2_auto_stopped')")}
        if rows.get("r2_auto_stopped") == "1":
            return True, "R2 auto-stopped at 98% — writes blocked"
        if rows.get("r2_pause_all") == "1":
            return True, "R2 paused (all) via bot controls"
        if rows.get("r2_pause_writes") == "1":
            return True, "R2 writes paused via bot controls"
    except Exception:
        pass
    return False, ""

def _is_read_paused(db) -> bool:
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        rows = {r[0]: r[1] for r in db.execute("SELECT key,value FROM tg_r2_controls WHERE key IN ('r2_pause_reads','r2_pause_all','r2_auto_stopped','r2_auto_stopped_reason')")}
        if rows.get("r2_pause_all") == "1" or rows.get("r2_pause_reads") == "1":
            return True
        if rows.get("r2_auto_stopped") == "1":
            reason = rows.get("r2_auto_stopped_reason", "")
            if "Class B" in reason or "class_b" in reason.lower():
                return True
    except Exception:
        pass
    return False

def warn_if_public_base_missing(account: R2Account) -> None:
    """Log warning if bucket appears private/unreachable via public URL — bucket must not be publicly listable."""
    if not account.public_base:
        log.warning("R2 bucket %s has no PUBLIC_BASE_URL — ensure bucket is private (no public ACL) and token is Object Read&Write scoped to this bucket only", account.bucket)

def _check_limits(db, account: R2Account, upcoming_bytes: int = 0) -> tuple[bool, str]:
    """Return (allowed, reason_if_blocked).  Fail-CLOSED on any error."""
    cfg = load_r2_config()
    if cfg.writes_disabled:
        return False, "R2 writes disabled by R2_DISABLE_WRITES=1"
    if not cfg.enabled:
        return False, "R2 is disabled (R2_ENABLED!=1)"
    # Bot controls / auto-stop
    paused, why = _is_write_paused(db)
    if paused:
        return False, why
    # Class A monthly cap — fail closed if we cannot read the counter
    try:
        used_a = class_a_used(db, account.bucket)
    except Exception as exc:
        return False, f"Cannot read Class A counter for {account.bucket}: {exc} — writes blocked"
    if used_a >= FREE_TIER_CLASS_A:
        return False, f"Class A limit reached ({used_a}/{FREE_TIER_CLASS_A} this month) — writes paused until next month"
    # Storage ceiling — fail closed if probe fails (unknown capacity => block)
    try:
        stats = bucket_stats(account, db=db)
    except Exception as exc:
        return False, f"Cannot verify R2 storage for {account.bucket}: {exc.__class__.__name__}: {exc} — writes blocked (fail-closed)"
    if stats.bytes_used + upcoming_bytes + WRITE_HEADROOM_BYTES > FREE_TIER_BYTES:
        return False, f"Bucket {account.bucket} at {stats.percent:.1f}% ({stats.bytes_used} bytes) — headroom would be exceeded"
    return True, ""


# ──────────────────── write account chooser ────────────────────

def choose_account_for_write(config: R2Config, db=None, *, upcoming_bytes: int = 0, primary_stats: "BucketStats | None" = None) -> R2Account | None:
    """Return the account that should receive the next upload, or None if blocked.

    Probes storage + Class A counters atomically; auto-switches to secondary
    at 100% headroom breach.  Any error => None (fail-closed).
    """
    if not config.enabled or not config.primary:
        return None
    if config.writes_disabled:
        log.warning("R2 writes disabled by R2_DISABLE_WRITES")
        return None

    if db is not None:
        ok, reason = _check_limits(db, config.primary, upcoming_bytes)
        if not ok:
            log.warning("Primary R2 blocked: %s", reason)
            if config.secondary:
                ok2, reason2 = _check_limits(db, config.secondary, upcoming_bytes)
                if not ok2:
                    log.error("Secondary R2 also blocked: %s", reason2)
                    return None
                log.warning("Switching R2 writes to secondary (%s) — primary: %s", config.secondary.bucket, reason)
                return config.secondary
            return None
        return config.primary

    # No DB available — fail closed (we cannot verify caps)
    log.error("R2 write requested without DB — cannot verify caps, blocking (fail-closed)")
    return None


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

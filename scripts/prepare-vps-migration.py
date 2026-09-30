#!/usr/bin/env python3
"""Snapshot reader databases/sessions without exposing credentials or copying WAL files."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import sqlite3
import tarfile
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone


def settings(env_file):
    result = {}
    for line in Path(env_file).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        key, separator, value = line.partition('=')
        if separator:
            parts = shlex.split(value, comments=True)
            result[key.strip()] = ' '.join(parts)
    result.update(os.environ)
    return result


def session_path(value):
    return Path(value if value.endswith('.session') else value + '.session')


@contextmanager
def mirror_stopped(reader):
    lock_path = Path(str(reader) + '.mirror.lock')
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Stop the local Telegram mirror with Ctrl+C before preparing migration.') from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def snapshot(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as original:
        with sqlite3.connect(destination) as copy:
            original.backup(copy)
            if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('A database snapshot failed its integrity check.')
    destination.chmod(0o600)


def prepare(env_file, output):
    config = settings(env_file)
    reader_base = config.get('TELEGRAM_READER_SESSION', 'server/data/archive-reader')
    reader = session_path(reader_base)
    archive = Path(config.get('VN_DATABASE_PATH', config.get('DATABASE_PATH', 'data/vn-reader.sqlite3')))
    if not reader.is_file() or not archive.is_file():
        raise RuntimeError('Archive database or authorized reader session is missing; check the environment file paths.')
    output = Path(output)
    if output.exists():
        raise RuntimeError('Output already exists. Choose a new --output path to preserve the previous backup.')
    output.parent.mkdir(parents=True, exist_ok=True)
    sources = [(archive, 'telegram/vn-reader.sqlite3'), (reader, 'telegram/telegram-reader.session')]
    for key, default, target in [
        ('TELEGRAM_BOT_SESSION', 'server/data/archive-streamer', 'telegram/telegram-bot.session'),
        ('TELEGRAM_MIRROR_BOT_SESSION', 'data/telegram-mirror-bot', 'telegram/telegram-mirror-bot.session')
    ]:
        source = session_path(config.get(key, default))
        if source.is_file():
            sources.append((source, target))
    accounts = Path(config.get('VN_ACCOUNT_DATABASE_PATH', 'data/accounts.sqlite3'))
    if accounts.is_file():
        sources.append((accounts, 'accounts/accounts.sqlite3'))
    with mirror_stopped(reader_base), tempfile.TemporaryDirectory(prefix='vn-migration-') as staging:
        staging = Path(staging)
        for source, target in sources:
            snapshot(source, staging / target)
        manifest = {'format': 'vn-reader-vps-migration', 'version': 1,
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'files': [target for _, target in sources],
                    'includes_environment': False}
        (staging / 'migration.json').write_text(json.dumps(manifest, indent=2) + '\n')
        fd, temporary = tempfile.mkstemp(prefix='.vn-migration-', dir=output.parent)
        try:
            with os.fdopen(fd, 'wb') as stream, tarfile.open(fileobj=stream, mode='w:gz') as bundle:
                for name in manifest['files'] + ['migration.json']:
                    bundle.add(staging / name, arcname=name, recursive=False)
            os.replace(temporary, output)
            output.chmod(0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='server/.env')
    parser.add_argument('--output', default='data/vps-migration.tar.gz')
    args = parser.parse_args()
    try:
        manifest = prepare(args.env_file, args.output)
    except (OSError, sqlite3.Error, ValueError, RuntimeError):
        # Do not print exception values: configuration or SQLite errors can include sensitive paths/data.
        raise SystemExit('Migration not created. Stop the local mirror, check database/session paths, and use a new output filename.')
    print(f'Created private migration bundle: {args.output} ({len(manifest["files"])} database/session snapshots).')
    print('Transfer securely. Keep the local mirror stopped when the VPS mirror starts. Environment secrets are not included.')

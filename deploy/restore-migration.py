"""Run once in the archive container as root to restore a private migration bundle."""
import json
import os
from pathlib import Path
import tarfile

ALLOWED = {
    "telegram/vn-reader.sqlite3", "telegram/telegram-reader.session",
    "telegram/telegram-bot.session", "telegram/telegram-mirror-bot.session",
    "accounts/accounts.sqlite3", "migration.json",
}
REQUIRED = {"telegram/vn-reader.sqlite3", "telegram/telegram-reader.session", "migration.json"}


def restore(bundle_path="/migration.tar.gz", targets=None, set_owner=True):
    targets = targets or {"telegram": Path("/data"), "accounts": Path("/accounts")}
    with tarfile.open(bundle_path, "r:gz") as bundle:
        members = bundle.getmembers()
        names = {member.name for member in members}
        if not REQUIRED <= names:
            raise SystemExit("Migration bundle is missing required archive/session files.")
        if len(names) != len(members) or any(member.name not in ALLOWED or not member.isfile() for member in members):
            raise SystemExit("Unexpected or duplicate migration file; nothing restored.")
        for member in members:
            limit = 64 * 1024 if member.name == 'migration.json' else (16 * 1024 * 1024 if member.name.endswith('.session') else 10 * 1024**3)
            if member.size < 0 or member.size > limit:
                raise SystemExit("Migration file exceeds supported size; nothing restored.")
        manifest = json.load(bundle.extractfile("migration.json"))
        listed = manifest.get('files') if isinstance(manifest, dict) else None
        if (not isinstance(manifest, dict) or manifest.get('format') != 'vn-reader-vps-migration'
                or manifest.get('version') != 1 or manifest.get('includes_environment') is not False
                or not isinstance(listed, list) or any(not isinstance(name, str) for name in listed)
                or len(listed) != len(set(listed)) or set(listed) != names - {'migration.json'}):
            raise SystemExit("Invalid migration manifest; nothing restored.")
        files = [(member, Path(targets[member.name.split('/')[0]]) / member.name.split('/')[1])
                 for member in members if member.name != "migration.json"]
        if any(path.exists() for _, path in files):
            raise SystemExit("Destination already contains data. Refusing to overwrite; nothing restored.")
        for member, path in files:
            path.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, path.open("xb") as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
            path.chmod(0o600)
            if set_owner:
                os.chown(path, 1000, 1000)
                os.chown(path.parent, 1000, 1000)
            print(f"Restored {member.name}")
    print("Migration restored. Start the services; do not run backfill again.")


if __name__ == '__main__':
    restore()

import fcntl
import importlib.util
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('migration', Path(__file__).parents[1] / 'scripts/prepare-vps-migration.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class MigrationTests(unittest.TestCase):
    def fixture(self, root):
        archive, session = root / 'archive.sqlite3', root / 'reader.session'
        for source in [archive, session]:
            with sqlite3.connect(source) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE test(value TEXT)')
                db.execute('INSERT INTO test VALUES (?)', ('saved',))
        env = root / '.env'
        env.write_text(f'VN_DATABASE_PATH="{archive}"\nTELEGRAM_READER_SESSION="{session}"\nTELEGRAM_BOT_SESSION="{root / "missing-bot"}"\nTELEGRAM_MIRROR_BOT_SESSION="{root / "missing-mirror"}"\nVN_ACCOUNT_DATABASE_PATH="{root / "missing-account.sqlite3"}"\nTELEGRAM_BOT_TOKEN=must-not-export\n')
        return env, session

    def test_preserves_databases_without_secrets_or_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env, _ = self.fixture(root)
            output = root / 'migration.tar.gz'
            migration.prepare(env, output)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            with tarfile.open(output) as bundle:
                self.assertEqual(sorted(bundle.getnames()), ['migration.json', 'telegram/telegram-reader.session', 'telegram/vn-reader.sqlite3'])
                self.assertNotIn(b'must-not-export', bundle.extractfile('migration.json').read())
                data = bundle.extractfile('telegram/vn-reader.sqlite3').read()
                restored = root / 'restored.sqlite3'
                restored.write_bytes(data)
                with sqlite3.connect(restored) as db:
                    self.assertEqual(db.execute('SELECT value FROM test').fetchone()[0], 'saved')
            with self.assertRaises(RuntimeError):
                migration.prepare(env, output)

    def test_refuses_active_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env, session = self.fixture(root)
            with (root / 'reader.session.mirror.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):
                    migration.prepare(env, root / 'migration.tar.gz')
            self.assertFalse((root / 'migration.tar.gz').exists())

if __name__ == '__main__':
    unittest.main()

import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('restore_migration', Path(__file__).with_name('restore-migration.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.targets = {'telegram': self.root / 'telegram', 'accounts': self.root / 'accounts'}
        self.bundle = self.root / 'migration.tar.gz'
        self.files = {'telegram/vn-reader.sqlite3': b'index', 'telegram/telegram-reader.session': b'session', 'accounts/accounts.sqlite3': b'accounts'}

    def tearDown(self):
        self.temp.cleanup()

    def make_bundle(self, extra=None, manifest_update=None):
        manifest = {'format': 'vn-reader-vps-migration', 'version': 1, 'includes_environment': False, 'files': list(self.files)}
        manifest.update(manifest_update or {})
        entries = list(self.files.items()) + [('migration.json', json.dumps(manifest).encode())] + (extra or [])
        with tarfile.open(self.bundle, 'w:gz') as bundle:
            for name, content in entries:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))

    def test_restore_and_refuse_overwrite(self):
        self.make_bundle()
        module.restore(self.bundle, self.targets, set_owner=False)
        path = self.targets['telegram'] / 'vn-reader.sqlite3'
        self.assertEqual(path.read_bytes(), b'index')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(SystemExit, 'Refusing to overwrite'):
            module.restore(self.bundle, self.targets, set_owner=False)
        self.assertEqual(path.read_bytes(), b'index')

    def test_refuse_duplicate_and_traversal_before_write(self):
        for extra in [[('telegram/vn-reader.sqlite3', b'duplicate')], [('../escape', b'outside')]]:
            self.make_bundle(extra=extra)
            with self.assertRaisesRegex(SystemExit, 'Unexpected or duplicate'):
                module.restore(self.bundle, self.targets, set_owner=False)
            self.assertFalse(self.targets['telegram'].exists())

    def test_refuse_invalid_manifest_before_write(self):
        for update in [{'version': 2}, {'files': []}, {'includes_environment': True}]:
            self.make_bundle(manifest_update=update)
            with self.assertRaisesRegex(SystemExit, 'Invalid migration manifest'):
                module.restore(self.bundle, self.targets, set_owner=False)
            self.assertFalse(self.targets['telegram'].exists())


if __name__ == '__main__':
    unittest.main()

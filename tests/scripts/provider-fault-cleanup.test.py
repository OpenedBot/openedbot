"""Profile restoration must continue when one resource cannot be restored."""
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("provider_fault", Path(__file__).parents[1] / "e2e/provider-fault-proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def backup(path):
    info = path.stat()
    return (path.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)


class RestorationTests(unittest.TestCase):
    def test_restores_exact_bytes_and_removes_a_created_auth_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            auth = Path(directory) / "auth.json"
            config.write_bytes(b"original\r\nconfiguration\n")
            os.chmod(config, 0o640)
            saved = {config: backup(config), auth: None}
            config.write_bytes(b"temporary config")
            auth.write_bytes(b"temporary auth")
            result = proxy.restore_saved_files(saved)
            self.assertEqual(result, {"config.yaml": True, "auth.json": True})
            self.assertEqual(backup(config), saved[config])
            self.assertFalse(auth.exists())

    def test_a_failed_first_mode_restore_cannot_skip_the_next_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            auth = Path(directory) / "auth.json"
            config.write_bytes(b"original config")
            auth.write_bytes(b"original auth")
            os.chmod(config, 0o600)
            os.chmod(auth, 0o640)
            saved = {config: backup(config), auth: backup(auth)}
            config.write_bytes(b"temporary config")
            auth.write_bytes(b"temporary auth")
            os.chmod(config, 0o660)
            chmod = os.chmod

            def fail_first(path, mode):
                if path == config:
                    raise PermissionError("fixture restore failure")
                chmod(path, mode)

            with patch.object(proxy.os, "chmod", side_effect=fail_first):
                result = proxy.restore_saved_files(saved)
            self.assertEqual(result, {"config.yaml": False, "auth.json": True})
            self.assertEqual(config.read_bytes(), saved[config][0])
            self.assertEqual(backup(auth), saved[auth])


if __name__ == "__main__":
    unittest.main()

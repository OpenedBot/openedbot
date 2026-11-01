from __future__ import annotations

from contextvars import ContextVar
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from ohb_a2a_policy.runtime_scope import RuntimeHomeError, managed_profile_guards_ready, resolve_runtime_home, root_home_scope


class RuntimeHomeScopeTests(unittest.TestCase):
    def test_management_requires_bound_enabled_identical_guards_in_every_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_directory(Path(tmp) / "runtime")
            self.assertTrue(managed_profile_guards_ready(root))
            _install_marker(root, root)
            _make_directory(root / "profiles" / "deleted-profile" / "logs")
            self.assertTrue(managed_profile_guards_ready(root))
            profile = _make_directory(root / "profiles" / "bot-one")
            (profile / "config.yaml").write_text("fixture: profile exists\n")
            self.assertFalse(managed_profile_guards_ready(root))
            _install_marker(profile, root)
            names = ("plugin.yaml", "__init__.py", "policy.py", "snapshot.py", "runtime_scope.py")
            for home in (root, profile):
                for name in names:
                    path = home / "plugins" / "ohb_a2a_policy" / name
                    path.write_bytes(b"same shipped companion")
                    path.chmod(0o600)
            config = types.ModuleType("hermes_cli.config")
            config.load_config = lambda: {"plugins": {"enabled": ["ohb_a2a_policy"], "disabled": []}}
            constants = types.ModuleType("hermes_constants")
            scope: ContextVar[str | None] = ContextVar("coverage_home", default=None)
            constants.set_hermes_home_override = scope.set
            constants.reset_hermes_home_override = scope.reset
            with patch.dict(sys.modules, {"hermes_cli.config": config, "hermes_constants": constants}):
                self.assertTrue(managed_profile_guards_ready(root))
                self.assertIsNone(scope.get())
                config.load_config = lambda: {"plugins": {"enabled": ["ohb_a2a_policy"], "disabled": ["ohb_a2a_policy"]}}
                self.assertFalse(managed_profile_guards_ready(root))
                config.load_config = lambda: {"plugins": {"enabled": ["ohb_a2a_policy"]}}
                (profile / "plugins" / "ohb_a2a_policy" / "policy.py").write_bytes(b"different code")
                self.assertFalse(managed_profile_guards_ready(root))

    def test_root_and_profile_homes_resolve_to_same_installed_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_directory(Path(tmp) / "runtime")
            root_marker = _install_marker(root, root)
            profile = _make_directory(root / "profiles" / "bot-one")
            profile_marker = _install_marker(profile, root)
            profile_link = Path(tmp) / "profile-link"
            profile_link.symlink_to(profile, target_is_directory=True)

            self.assertEqual(resolve_runtime_home(root, root_marker), root)
            self.assertEqual(resolve_runtime_home(profile, profile_marker), root)
            self.assertEqual(resolve_runtime_home(profile_link, profile_link / "plugins" / "ohb_a2a_policy" / "runtime-home"), root)

    def test_missing_symlink_loose_hardlinked_and_noncanonical_markers_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_directory(Path(tmp) / "runtime")
            profile = _make_directory(root / "profiles" / "bot-one")
            marker = _install_marker(profile, root)

            marker.unlink()
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(profile, marker)

            marker.write_text(str(root) + "\n", encoding="utf-8")
            os.chmod(marker, 0o600)
            target = profile / "plugins" / "ohb_a2a_policy" / "target"
            target.write_text(str(root) + "\n", encoding="utf-8")
            os.chmod(target, 0o600)
            marker.unlink()
            marker.symlink_to(target)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(profile, marker)

            marker.unlink()
            marker.write_text(str(root) + "\n", encoding="utf-8")
            os.chmod(marker, 0o644)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(profile, marker)

            os.chmod(marker, 0o600)
            linked = marker.with_name("runtime-home-link")
            os.link(marker, linked)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(profile, marker)

            linked.unlink()
            marker.write_text(str(root / ".." / "runtime") + "\n", encoding="utf-8")
            os.chmod(marker, 0o600)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(profile, marker)

    def test_profile_outside_root_and_bad_profile_slug_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_directory(Path(tmp) / "runtime")
            outside = _make_directory(Path(tmp) / "outside")
            marker = _install_marker(outside, root)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(outside, marker)

            invalid_profile = _make_directory(root / "profiles" / "Bad")
            invalid_marker = _install_marker(invalid_profile, root)
            with self.assertRaises(RuntimeHomeError):
                resolve_runtime_home(invalid_profile, invalid_marker)

    def test_context_override_is_nested_thread_local_and_does_not_change_environment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_directory(Path(tmp) / "runtime")
            profile = _make_directory(root / "profiles" / "bot-one")
            marker = _install_marker(profile, root)
            current_override: ContextVar[str | None] = ContextVar("test_hermes_home", default=None)
            fake_constants = types.ModuleType("hermes_constants")

            def get_home() -> Path:
                override = current_override.get()
                return Path(override if override is not None else os.environ["HERMES_HOME"])

            def set_home(path: str | Path | None):
                return current_override.set(None if path is None else str(path))

            def reset_home(token: object) -> None:
                current_override.reset(token)

            fake_constants.get_hermes_home = get_home
            fake_constants.set_hermes_home_override = set_home
            fake_constants.reset_hermes_home_override = reset_home
            environment = os.environ.copy()
            environment["HERMES_HOME"] = str(root / "not-the-active-home")
            environment["OHB_SCOPE_TEST_SENTINEL"] = "unchanged"

            with patch.dict(os.environ, environment, clear=True), patch.dict(
                sys.modules, {"hermes_constants": fake_constants}
            ):
                profile_token = set_home(profile)
                try:
                    self.assertEqual(get_home(), profile)
                    before = os.environ.copy()
                    with root_home_scope(profile, marker):
                        self.assertEqual(get_home(), root)
                    self.assertEqual(get_home(), profile)
                    self.assertEqual(os.environ, before)
                finally:
                    reset_home(profile_token)
                self.assertEqual(os.environ, environment)


def _make_directory(path: Path) -> Path:
    missing: list[Path] = []
    cursor = path
    while not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
    os.chmod(path, 0o700)
    return path


def _install_marker(active_home: Path, runtime_root: Path) -> Path:
    plugins = _make_directory(active_home / "plugins")
    plugin = _make_directory(plugins / "ohb_a2a_policy")
    marker = plugin / "runtime-home"
    marker.write_text(str(runtime_root) + "\n", encoding="utf-8")
    os.chmod(marker, 0o600)
    return marker


if __name__ == "__main__":
    unittest.main()

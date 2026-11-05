"""Resolve the host-installed policy root and scope Hermes config reads to it."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import re
import stat
from typing import Iterator


_PROFILE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_MARKER_NAME = "runtime-home"
_MAX_MARKER_BYTES = 4096
_PLUGIN_NAME = "openedbot_a2a_policy"


class RuntimeHomeError(RuntimeError):
    """The local plugin marker or its runtime home failed validation."""


def resolve_runtime_home(active_home: str | os.PathLike[str], marker_path: str | os.PathLike[str]) -> Path:
    """Read the fixed installer marker and verify this home belongs to it."""
    active = Path(active_home)
    marker = Path(marker_path)
    if not active.is_absolute() or not marker.is_absolute():
        raise RuntimeHomeError("runtime marker is invalid")

    expected_plugin_dir = active / "plugins" / _PLUGIN_NAME
    if marker != expected_plugin_dir / _MARKER_NAME:
        raise RuntimeHomeError("runtime marker is invalid")
    plugins_stat = _lstat(active / "plugins")
    plugin_stat = _lstat(marker.parent)
    if (
        not stat.S_ISDIR(plugins_stat.st_mode)
        or stat.S_ISLNK(plugins_stat.st_mode)
        or plugins_stat.st_uid != os.geteuid()
        or stat.S_IMODE(plugins_stat.st_mode) & 0o022
        or not stat.S_ISDIR(plugin_stat.st_mode)
        or stat.S_ISLNK(plugin_stat.st_mode)
        or plugin_stat.st_uid != os.geteuid()
        or stat.S_IMODE(plugin_stat.st_mode) & 0o022
    ):
        raise RuntimeHomeError("runtime marker is invalid")

    try:
        before_open = os.lstat(marker)
    except OSError as exc:
        raise RuntimeHomeError("runtime marker is unavailable") from exc
    if (
        not stat.S_ISREG(before_open.st_mode)
        or stat.S_ISLNK(before_open.st_mode)
        or before_open.st_uid != os.geteuid()
        or before_open.st_nlink != 1
        or stat.S_IMODE(before_open.st_mode) != 0o600
        or before_open.st_size <= 0
        or before_open.st_size > _MAX_MARKER_BYTES
    ):
        raise RuntimeHomeError("runtime marker is invalid")
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NONBLOCK", 0)
        fd = os.open(marker, flags)
    except OSError as exc:
        raise RuntimeHomeError("runtime marker is unavailable") from exc
    try:
        marker_stat = os.fstat(fd)
        if (
            not stat.S_ISREG(marker_stat.st_mode)
            or marker_stat.st_uid != os.geteuid()
            or marker_stat.st_nlink != 1
            or stat.S_IMODE(marker_stat.st_mode) != 0o600
            or marker_stat.st_size <= 0
            or marker_stat.st_size > _MAX_MARKER_BYTES
            or marker_stat.st_dev != before_open.st_dev
            or marker_stat.st_ino != before_open.st_ino
        ):
            raise RuntimeHomeError("runtime marker is invalid")
        raw = os.read(fd, _MAX_MARKER_BYTES + 1)
        if len(raw) != marker_stat.st_size or len(raw) > _MAX_MARKER_BYTES:
            raise RuntimeHomeError("runtime marker is invalid")
    finally:
        os.close(fd)

    if not raw.endswith(b"\n") or b"\n" in raw[:-1] or b"\r" in raw:
        raise RuntimeHomeError("runtime marker is invalid")
    try:
        root_text = raw[:-1].decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise RuntimeHomeError("runtime marker is invalid") from exc
    root = Path(root_text)
    if (
        not root.is_absolute()
        or str(root) != root_text
        or os.path.normpath(root_text) != root_text
    ):
        raise RuntimeHomeError("runtime marker is invalid")

    root_stat = _lstat(root)
    try:
        active_stat = os.stat(active)
        active_real = active.resolve(strict=True)
    except OSError as exc:
        raise RuntimeHomeError("active Hermes home is unavailable") from exc
    if (
        not stat.S_ISDIR(root_stat.st_mode)
        or stat.S_ISLNK(root_stat.st_mode)
        or root_stat.st_uid != os.geteuid()
        or not stat.S_ISDIR(active_stat.st_mode)
        or active_stat.st_uid != os.geteuid()
    ):
        raise RuntimeHomeError("runtime home is unsafe")
    try:
        if root.resolve(strict=True) != root:
            raise RuntimeHomeError("runtime home is not canonical")
    except OSError as exc:
        raise RuntimeHomeError("runtime home is unavailable") from exc

    if active_real != root:
        try:
            relative = active_real.relative_to(root)
        except ValueError as exc:
            raise RuntimeHomeError("active profile is outside the runtime home") from exc
        if (
            len(relative.parts) != 2
            or relative.parts[0] != "profiles"
            or not _PROFILE_SLUG.fullmatch(relative.parts[1])
        ):
            raise RuntimeHomeError("active profile is outside the runtime home")
    return root


@contextmanager
def root_home_scope(
    active_home: str | os.PathLike[str],
    marker_path: str | os.PathLike[str],
) -> Iterator[Path]:
    """Temporarily read runtime config under the verified root HERMES_HOME."""
    root = resolve_runtime_home(active_home, marker_path)
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(root))
    try:
        yield root
    finally:
        reset_hermes_home_override(token)


def _lstat(path: Path) -> os.stat_result:
    try:
        return os.lstat(path)
    except OSError as exc:
        raise RuntimeHomeError("runtime path is unavailable") from exc


def managed_profile_guards_ready(root: Path) -> bool:
    """Do not announce management while a managed profile lacks its guard."""
    try:
        profiles = root / "profiles"
        if not profiles.exists() and not profiles.is_symlink():
            return True
        info = _lstat(profiles)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            return False
        entries = list(profiles.iterdir())
        if len(entries) > 1024:
            return False
        homes = []
        for entry in entries:
            if not _PROFILE_SLUG.fullmatch(entry.name):
                continue
            # Upstream can recreate a deleted profile's log directory. A
            # managed profile exists only while its config.yaml exists.
            config_path = entry / "config.yaml"
            if not config_path.exists() and not config_path.is_symlink():
                continue
            config_info = _lstat(config_path)
            if not stat.S_ISREG(config_info.st_mode) or config_info.st_uid != os.geteuid():
                return False
            homes.append(entry)
        if len(homes) > 32:
            return False
        if not homes:
            return True
        from hermes_cli.config import load_config
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        for home in homes:
            info = _lstat(home)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
                return False
            plugin = home / "plugins" / _PLUGIN_NAME
            if resolve_runtime_home(home, plugin / _MARKER_NAME) != root:
                return False
            for filename in ("plugin.yaml", "__init__.py", "policy.py", "snapshot.py", "runtime_scope.py"):
                path = plugin / filename
                info = _lstat(path)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 128 * 1024):
                    return False
                if path.read_bytes() != (root / "plugins" / _PLUGIN_NAME / filename).read_bytes():
                    return False
            token = set_hermes_home_override(str(home))
            try:
                config = load_config()
            finally:
                reset_hermes_home_override(token)
            plugin_config = config.get("plugins") if isinstance(config, dict) else None
            if (not isinstance(plugin_config, dict) or not isinstance(plugin_config.get("enabled"), list)
                    or _PLUGIN_NAME not in plugin_config["enabled"]
                    or _PLUGIN_NAME in (plugin_config.get("disabled") or [])):
                return False
        return True
    except Exception:
        return False

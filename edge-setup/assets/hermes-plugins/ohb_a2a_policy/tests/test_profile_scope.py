from __future__ import annotations

from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from ohb_a2a_policy import _policy_state
from ohb_a2a_policy.policy import make_pre_tool_call_guard, make_tool_execution_middleware
from ohb_a2a_policy.runtime_scope import root_home_scope


class ProfileRootPolicyTests(unittest.TestCase):
    def test_two_profile_contexts_use_root_for_preflight_and_native_callback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _home(Path(tmp) / "runtime")
            profile_a = _home(root / "profiles" / "bot-a")
            profile_b = _home(root / "profiles" / "bot-b")
            marker_a = _marker(profile_a, root)
            marker_b = _marker(profile_b, root)
            configs = {
                str(root): {
                    "a2a_agents": {"alpha": {"url": "https://root.example/a2a"}},
                    "trusted_peers": {"alpha"},
                },
                str(profile_a): {
                    "a2a_agents": {"alpha": {"url": "https://profile-a.invalid/a2a"}},
                    "trusted_peers": {"alpha"},
                },
                str(profile_b): {
                    "a2a_agents": {"alpha": {"url": "https://profile-b.invalid/a2a"}},
                    "trusted_peers": {"alpha"},
                },
            }
            with _fake_hermes_modules(configs) as fake:
                with patch.dict(os.environ, {"HERMES_HOME": str(root), "A2A_TRUSTED_PEERS": ""}):
                    env_before = os.environ.copy()
                    barrier = threading.Barrier(2)

                    def run_profile(profile: Path, marker: Path) -> tuple[dict, dict, dict, Path, str]:
                        profile_token = fake.set_home(profile)
                        try:
                            barrier.wait(timeout=3)
                            preflight = _policy_state(profile)
                            denials: list[dict[str, str]] = []
                            guard = make_pre_tool_call_guard(
                                lambda: _policy_state(profile),
                                lambda **row: denials.append(row),
                            )
                            middleware = make_tool_execution_middleware(
                                guard,
                                lambda: root_home_scope(profile, marker),
                            )
                            seen: dict[str, object] = {}

                            def native_tool(args: object) -> dict[str, object]:
                                native_config = fake.load_config()
                                seen["home"] = fake.get_home()
                                seen["url"] = native_config["a2a_agents"]["alpha"]["url"]
                                return {"url": seen["url"]}

                            result = middleware(
                                tool_name="a2a_call",
                                args={"agent": "alpha"},
                                next_call=native_tool,
                            )
                            inventory = middleware(
                                tool_name="a2a_list",
                                args={},
                                next_call=native_tool,
                            )
                            return (
                                preflight,
                                result,
                                inventory,
                                fake.get_home(),
                                str(seen.get("url", "")),
                            )
                        finally:
                            fake.reset_home(profile_token)

                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = [
                            pool.submit(run_profile, profile_a, marker_a),
                            pool.submit(run_profile, profile_b, marker_b),
                        ]
                        results = [future.result(timeout=5) for future in futures]

                    self.assertEqual(results[0][3], profile_a)
                    self.assertEqual(results[1][3], profile_b)
                    for preflight, result, inventory, _home_after, native_url in results:
                        self.assertEqual(preflight["a2a_agents"]["alpha"]["url"], "https://root.example/a2a")
                        self.assertEqual(result["url"], "https://root.example/a2a")
                        self.assertEqual(inventory["url"], "https://root.example/a2a")
                        self.assertEqual(native_url, "https://root.example/a2a")
                    self.assertEqual(os.environ, env_before)
                    self.assertEqual(fake.load_calls.count(str(root)), 12)
                    self.assertEqual(fake.get_home(), root)

    def test_profile_allow_does_not_override_root_denial_or_profile_only_alias(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _home(Path(tmp) / "runtime")
            profile = _home(root / "profiles" / "bot-a")
            marker = _marker(profile, root)
            configs = {
                str(root): {
                    "a2a_agents": {
                        "root-denied": {"url": "https://root.example/denied"},
                        "root-allowed": {"url": "https://root.example/allowed"},
                    },
                    "trusted_peers": {"root-allowed"},
                },
                str(profile): {
                    "a2a_agents": {
                        "root-denied": {"url": "https://profile.example/allowed"},
                        "profile-only": {"url": "https://profile.example/private"},
                    },
                    "trusted_peers": {"root-denied", "profile-only"},
                },
            }
            with _fake_hermes_modules(configs) as fake:
                profile_token = fake.set_home(profile)
                try:
                    denials: list[dict[str, str]] = []
                    guard = make_pre_tool_call_guard(
                        lambda: _policy_state(profile),
                        lambda **row: denials.append(row),
                    )
                    middleware = make_tool_execution_middleware(
                        guard,
                        lambda: root_home_scope(profile, marker),
                    )
                    native_calls: list[object] = []
                    next_call = lambda args: native_calls.append(args) or {"ok": True}

                    self.assertEqual(
                        guard(tool_name="a2a_call", args={"agent": "root-denied"})["action"],
                        "block",
                    )
                    denied = middleware(
                        tool_name="a2a_call",
                        args={"agent": "root-denied"},
                        next_call=next_call,
                    )
                    profile_only = middleware(
                        tool_name="a2a_call",
                        args={"agent": "profile-only"},
                        next_call=next_call,
                    )
                    unknown_network = middleware(
                        tool_name="a2a_task_send_v3",
                        args={"agent": "root-allowed"},
                        next_call=next_call,
                    )
                    self.assertIn("error", denied)
                    self.assertIn("error", profile_only)
                    self.assertIn("error", unknown_network)
                    self.assertEqual(native_calls, [])
                    unrelated_args = {"command": "echo ok"}
                    unrelated = middleware(
                        tool_name="shell_exec",
                        args=unrelated_args,
                        next_call=next_call,
                    )
                    self.assertEqual(unrelated, {"ok": True})
                    self.assertEqual(native_calls, [unrelated_args])
                    self.assertEqual(denials[0]["peer"], "root-denied")
                    self.assertEqual(denials[-1]["peer"], "unknown")
                    self.assertEqual(fake.get_home(), profile)
                finally:
                    fake.reset_home(profile_token)

    def test_downstream_exception_runs_once_and_restores_profile_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _home(Path(tmp) / "runtime")
            profile = _home(root / "profiles" / "bot-a")
            marker = _marker(profile, root)
            configs = {
                str(root): {
                    "a2a_agents": {"alpha": {"url": "https://root.example/a2a"}},
                    "trusted_peers": {"alpha"},
                },
                str(profile): {"a2a_agents": {}, "trusted_peers": set()},
            }
            with _fake_hermes_modules(configs) as fake:
                profile_token = fake.set_home(profile)
                try:
                    guard = make_pre_tool_call_guard(lambda: _policy_state(profile), lambda **_: None)
                    middleware = make_tool_execution_middleware(
                        guard,
                        lambda: root_home_scope(profile, marker),
                    )
                    calls = 0
                    failure = RuntimeError("native failure")

                    def fail_once(_args: object) -> object:
                        nonlocal calls
                        calls += 1
                        self.assertEqual(fake.get_home(), root)
                        raise failure

                    with self.assertRaisesRegex(RuntimeError, "native failure"):
                        middleware(
                            tool_name="a2a_call",
                            args={"agent": "alpha"},
                            next_call=fail_once,
                        )
                    self.assertEqual(calls, 1)
                    self.assertEqual(fake.get_home(), profile)
                finally:
                    fake.reset_home(profile_token)


class FakeHermesState:
    def __init__(self, configs: dict[str, dict[str, object]]) -> None:
        self.override: ContextVar[str | None] = ContextVar("fake_hermes_home", default=None)
        self.configs = configs
        self.load_calls: list[str] = []

    def get_home(self) -> Path:
        selected = self.override.get() or os.environ["HERMES_HOME"]
        return Path(selected)

    def set_home(self, home: Path):
        return self.override.set(str(home))

    def reset_home(self, token: object) -> None:
        self.override.reset(token)

    def get_config_path(self) -> Path:
        return self.get_home() / "config.yaml"

    def load_config(self) -> dict[str, object]:
        key = str(self.get_home())
        self.load_calls.append(key)
        return self.configs[key]

    def get_trusted_peers(self) -> set[str]:
        override = os.environ.get("A2A_TRUSTED_PEERS", "").strip()
        if override:
            return {peer.strip() for peer in override.split(",") if peer.strip()}
        config = self.load_config()
        return set(config.get("trusted_peers", set()))


class _fake_hermes_modules:
    def __init__(self, configs: dict[str, dict[str, object]]) -> None:
        self.fake = FakeHermesState(configs)
        self.modules = _modules(self.fake)
        self._patch = patch.dict(sys.modules, self.modules)

    def __enter__(self) -> FakeHermesState:
        self._patch.__enter__()
        return self.fake

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> object:
        return self._patch.__exit__(exc_type, exc, traceback)


def _modules(fake: FakeHermesState) -> dict[str, types.ModuleType]:
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = fake.get_home
    constants.set_hermes_home_override = lambda path: fake.override.set(None if path is None else str(path))
    constants.reset_hermes_home_override = fake.reset_home

    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.__path__ = []
    config = types.ModuleType("hermes_cli.config")
    config.get_config_path = fake.get_config_path
    config.load_config = fake.load_config
    hermes_cli.config = config

    plugins = types.ModuleType("plugins")
    plugins.__path__ = []
    platforms = types.ModuleType("plugins.platforms")
    platforms.__path__ = []
    a2a = types.ModuleType("plugins.platforms.a2a")
    a2a.__path__ = []
    security = types.ModuleType("plugins.platforms.a2a.security")
    security.get_trusted_peers = fake.get_trusted_peers
    a2a.security = security
    platforms.a2a = a2a
    plugins.platforms = platforms
    return {
        "hermes_constants": constants,
        "hermes_cli": hermes_cli,
        "hermes_cli.config": config,
        "plugins": plugins,
        "plugins.platforms": platforms,
        "plugins.platforms.a2a": a2a,
        "plugins.platforms.a2a.security": security,
    }


def _home(path: Path) -> Path:
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


def _marker(active_home: Path, root: Path) -> Path:
    plugin_dir = _home(active_home / "plugins" / "ohb_a2a_policy")
    marker = plugin_dir / "runtime-home"
    marker.write_text(str(root) + "\n", encoding="utf-8")
    os.chmod(marker, 0o600)
    return marker


if __name__ == "__main__":
    unittest.main()

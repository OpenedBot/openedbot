from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import openedbot_a2a_policy


class FakePluginContext:
    def __init__(self) -> None:
        self.hooks: dict[str, Any] = {}
        self.middlewares: dict[str, Any] = {}
        self.subscriptions: dict[str, Any] = {}
        self.unload: Any = None

    def register_hook(self, name: str, callback: Any) -> None:
        self.hooks[name] = callback

    def register_middleware(self, name: str, callback: Any) -> None:
        self.middlewares[name] = callback

    def subscribe(self, name: str, callback: Any) -> None:
        self.subscriptions[name] = callback

    def on_unload(self, callback: Any) -> None:
        self.unload = callback


class PluginLifecycleTests(unittest.TestCase):
    def tearDown(self) -> None:
        openedbot_a2a_policy._on_unload()
        openedbot_a2a_policy._atexit_registered = False
        openedbot_a2a_policy._guard_registered = False

    def test_public_registration_and_named_gateway_bridge_start_live_socket(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            home = Path(tmp)
            plugins_dir = home / "plugins"
            plugins_dir.mkdir(mode=0o700)
            os.chmod(plugins_dir, 0o700)
            marker_dir = plugins_dir / "openedbot_a2a_policy"
            marker_dir.mkdir(mode=0o700)
            os.chmod(marker_dir, 0o700)
            (marker_dir / "runtime-home").write_text(str(home) + "\n")
            os.chmod(marker_dir / "runtime-home", 0o600)
            context = FakePluginContext()
            metadata = {
                "peerTokens": {"private-token": "alpha"},
                "trustedPeers": {"alpha"},
                "peerTokensOverride": False,
                "trustedPeersOverride": False,
                "allowAllUsers": False,
                "localhostOnly": False,
            }
            with (
                patch.object(openedbot_a2a_policy, "_hermes_home", return_value=home),
                patch.object(openedbot_a2a_policy, "_metadata_provider", return_value=lambda: metadata),
                patch.object(openedbot_a2a_policy.atexit, "register"),
            ):
                openedbot_a2a_policy.register(context)
                self.assertIn("pre_tool_call", context.hooks)
                self.assertIn("tool_execution", context.middlewares)
                self.assertEqual(
                    set(context.subscriptions),
                    {"openedbot_a2a_policy:gateway_start"},
                )
                callback = context.subscriptions["openedbot_a2a_policy:gateway_start"]
                self.assertFalse(callback(gatewayStart=False))
                self.assertTrue(callback(gatewayStart=True))
                self.assertTrue((home / ".openedbot-a2a-policy" / "state.sock").exists())

                # The public bridge gets a success only after the listener is live.
                self.assertTrue(context.unload is not None)
                context.unload()
                self.assertFalse((home / ".openedbot-a2a-policy" / "state.sock").exists())
                self.assertFalse(callback(gatewayStart=True))

    def test_peer_token_override_is_frozen_for_the_gateway_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            env_file = home / ".env"
            env_file.write_text("A2A_PEER_TOKENS=managed-value\n")
            config = types.ModuleType("hermes_cli.config")
            config.load_env = Mock(return_value={"A2A_PEER_TOKENS": "managed-value"})
            with (
                patch.dict(sys.modules, {"hermes_cli.config": config}),
                patch.dict(os.environ, {"A2A_PEER_TOKENS": "managed-value"}),
                patch.object(openedbot_a2a_policy, "root_home_scope", lambda *_args: nullcontext(home)),
                patch.object(
                    openedbot_a2a_policy,
                    "_startup_metadata",
                    side_effect=lambda override: {"peerTokensOverride": override},
                ),
            ):
                provider = openedbot_a2a_policy._metadata_provider(home)
                env_file.write_text("A2A_PEER_TOKENS=pending-host-write\n")
                config.load_env.return_value = {"A2A_PEER_TOKENS": "pending-host-write"}
                self.assertFalse(provider()["peerTokensOverride"])
                config.load_env.assert_called_once()

    def test_missing_or_unsafe_marker_keeps_both_guards_registered_and_blocks(self) -> None:
        for marker_state in ("missing", "symlink", "loose-mode"):
            with self.subTest(marker_state=marker_state), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                plugin_dir = home / "plugins" / "openedbot_a2a_policy"
                plugin_dir.mkdir(parents=True, mode=0o700)
                marker = plugin_dir / "runtime-home"
                if marker_state != "missing":
                    marker.write_text(str(home) + "\n")
                    os.chmod(marker, 0o644 if marker_state == "loose-mode" else 0o600)
                    if marker_state == "symlink":
                        target = plugin_dir / "target"
                        target.write_text(str(home) + "\n")
                        os.chmod(target, 0o600)
                        marker.unlink()
                        marker.symlink_to(target)

                context = FakePluginContext()
                with (
                    patch.object(openedbot_a2a_policy, "_hermes_home", return_value=home),
                    patch.object(
                        openedbot_a2a_policy,
                        "_policy_state",
                        side_effect=RuntimeError("configuration unavailable"),
                    ),
                ):
                    openedbot_a2a_policy.register(context)
                    self.assertIn("pre_tool_call", context.hooks)
                    self.assertIn("tool_execution", context.middlewares)
                    decision = context.hooks["pre_tool_call"](
                        tool_name="a2a_call",
                        args={"agent": "alpha"},
                    )
                    self.assertEqual(decision["action"], "block")

                    calls = 0

                    def next_call(_args: object) -> object:
                        nonlocal calls
                        calls += 1
                        return {"ok": True}

                    result = context.middlewares["tool_execution"](
                        tool_name="a2a_call",
                        args={"agent": "alpha"},
                        next_call=next_call,
                    )
                    self.assertIn("error", result)
                    self.assertEqual(calls, 0)
                    self.assertIsNotNone(context.unload)
                    context.unload()

    def test_named_profile_does_not_start_an_additional_snapshot_socket(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "runtime"
            root.mkdir(mode=0o700)
            os.chmod(root, 0o700)
            home = root / "profiles" / "bot-one"
            home.mkdir(parents=True, mode=0o700)
            os.chmod(root / "profiles", 0o700)
            os.chmod(home, 0o700)
            plugin_dir = home / "plugins" / "openedbot_a2a_policy"
            plugin_dir.mkdir(parents=True, mode=0o700)
            os.chmod(home / "plugins", 0o700)
            os.chmod(plugin_dir, 0o700)
            marker = plugin_dir / "runtime-home"
            marker.write_text(str(root) + "\n")
            os.chmod(marker, 0o600)
            context = FakePluginContext()
            with patch.object(openedbot_a2a_policy, "_hermes_home", return_value=home):
                openedbot_a2a_policy.register(context)
                callback = context.subscriptions["openedbot_a2a_policy:gateway_start"]
                self.assertFalse(callback(gatewayStart=True))
                self.assertFalse((root / ".openedbot-a2a-policy" / "state.sock").exists())
                self.assertFalse((home / ".openedbot-a2a-policy" / "state.sock").exists())
                self.assertIsNotNone(context.unload)
                context.unload()


if __name__ == "__main__":
    unittest.main()

import asyncio
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def _upstream_format(output):
    # Hermes 0.22.2 `_format_backend_probe`, verbatim behaviour.
    parsed = {k.strip(): v.strip() for k, _, v in (line.partition("=") for line in output.splitlines() if "=" in line)}
    known = lambda key: parsed.get(key) if parsed.get(key) != "unknown" else None
    os_line = " ".join(x for x in (known("os"), known("kernel")) if x)
    return f"  OS: {os_line}" if os_line else ""


def _fake_prompt_builder():
    calls = []

    def upstream(env_type):
        calls.append(env_type)
        return "  OS: container"

    return types.SimpleNamespace(_probe_remote_backend=upstream, _format_backend_probe=_upstream_format, calls=calls)


class BackendProbeHookTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("ohb_backend_probe_hook_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        # Outside Hermes the import-time install finds no prompt builder: it warns and stays off.
        with self.assertLogs("ohb.backend_probe", level="WARNING"):
            spec.loader.exec_module(self.module)
        self.assertFalse(self.module._installed)

    def test_docker_on_linux_answers_from_host_kernel_without_a_container(self):
        builder = _fake_prompt_builder()
        uname = os.uname_result(("Linux", "host", "6.12.113+deb13-cloud-amd64", "#1", "x86_64"))
        self.assertTrue(self.module.install(builder))
        with patch.object(self.module.sys, "platform", "linux"), patch.object(self.module.os, "uname", return_value=uname):
            self.assertEqual(builder._probe_remote_backend("docker"), "  OS: Linux 6.12.113+deb13-cloud-amd64")
        self.assertEqual(builder.calls, [])

    def test_other_backends_and_non_linux_hosts_keep_the_upstream_probe(self):
        builder = _fake_prompt_builder()
        self.module.install(builder)
        with patch.object(self.module.sys, "platform", "linux"):
            self.assertEqual(builder._probe_remote_backend("ssh"), "  OS: container")
            self.assertEqual(builder._probe_remote_backend("modal"), "  OS: container")
        with patch.object(self.module.sys, "platform", "darwin"):
            self.assertEqual(builder._probe_remote_backend("docker"), "  OS: container")
        self.assertEqual(builder.calls, ["ssh", "modal", "docker"])

    def test_install_is_idempotent_and_never_wraps_twice(self):
        builder = _fake_prompt_builder()
        self.module.install(builder)
        first = builder._probe_remote_backend
        self.assertTrue(self.module.install(builder))
        self.assertIs(builder._probe_remote_backend, first)
        self.assertEqual(first.__wrapped__.__name__, "upstream")

    def test_missing_upstream_probe_leaves_hermes_untouched(self):
        builder = types.SimpleNamespace(_format_backend_probe=_upstream_format)
        with self.assertLogs("ohb.backend_probe", level="WARNING"):
            self.assertFalse(self.module.install(builder))
        self.assertFalse(hasattr(builder, "_probe_remote_backend"))

    def test_unusable_kernel_answer_falls_back_to_upstream_description(self):
        builder = _fake_prompt_builder()
        self.module.install(builder)
        uname = os.uname_result(("unknown", "host", "unknown", "#1", "x86_64"))
        with patch.object(self.module.sys, "platform", "linux"), patch.object(self.module.os, "uname", return_value=uname):
            # None makes Hermes print its own "probe didn't respond" fallback text.
            self.assertIsNone(builder._probe_remote_backend("docker"))

    def test_gateway_startup_installs_and_other_events_do_nothing(self):
        builder = _fake_prompt_builder()
        fake_agent = types.ModuleType("agent")
        fake_agent.prompt_builder = builder
        with patch.dict(sys.modules, {"agent": fake_agent, "agent.prompt_builder": builder}):
            asyncio.run(self.module.handle("agent:start", {}))
            self.assertFalse(self.module._installed)
            asyncio.run(self.module.handle("gateway:startup", {"platforms": []}))
        self.assertTrue(self.module._installed)
        self.assertTrue(hasattr(builder._probe_remote_backend, "__wrapped__"))


if __name__ == "__main__":
    unittest.main()

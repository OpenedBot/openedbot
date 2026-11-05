from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

from openedbot_a2a_policy.policy import append_policy_denial, make_pre_tool_call_guard


class PolicyGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state: dict[str, Any] = {
            "trusted_peers": {"alpha", "beta"},
            "a2a_agents": {
                "alpha": {"url": "https://alpha.example/a2a"},
                "beta": {"url": "https://beta.example/a2a"},
            },
        }
        self.denials: list[dict[str, Any]] = []

        def write_denial(**record: Any) -> None:
            self.denials.append(record)

        self.guard = make_pre_tool_call_guard(lambda: self.state, write_denial)

    def test_declared_and_trusted_named_peer_is_allowed(self) -> None:
        self.assertIsNone(self.guard(tool_name="a2a_call", args={"agent": "alpha", "message": "hello"}))
        self.assertEqual(self.denials, [])

    def test_agent_alias_fallbacks_are_allowed_but_conflicts_fail_closed(self) -> None:
        self.assertIsNone(self.guard(tool_name="a2a_call", args={"agent_name": "alpha"}))
        self.assertIsNone(self.guard(tool_name="a2a_call", args={"name": "beta"}))
        result = self.guard(
            tool_name="a2a_call",
            args={"agent": "alpha", "agent_name": "beta", "message": "do not disclose"},
        )
        self.assertEqual(result["action"], "block")
        self.assertEqual(self.denials[-1]["peer"], "unknown")

    def test_untrusted_unknown_and_direct_url_calls_are_blocked(self) -> None:
        for args in (
            {"agent": "gamma", "message": "private"},
            {"agent": "https://user:secret@outside.example/path?token=secret", "message": "private"},
            {"agent": "gamma", "agent_name": "alpha"},
        ):
            result = self.guard(tool_name="a2a_call", args=args)
            self.assertEqual(result["action"], "block")
        self.assertTrue(all("message" not in row for row in self.denials))

    def test_discover_requires_exact_url_of_one_trusted_declared_peer(self) -> None:
        self.assertIsNone(
            self.guard(tool_name="a2a_discover", args={"url": "https://alpha.example/a2a"})
        )
        result = self.guard(
            tool_name="a2a_discover",
            args={"url": "https://alpha.example/a2a/"},
        )
        self.assertEqual(result["action"], "block")
        result = self.guard(
            tool_name="a2a_discover",
            args={"url": "https://outside.example/a2a"},
        )
        self.assertEqual(result["action"], "block")

    def test_discover_denial_never_records_url_credentials_or_query(self) -> None:
        self.guard(
            tool_name="a2a_discover",
            args={"url": "https://user:secret@outside.example/a2a?token=hidden#fragment"},
        )
        serialized = json.dumps(self.denials)
        for private in ("outside.example", "user", "secret", "token=hidden", "fragment"):
            self.assertNotIn(private, serialized)

    def test_discover_blocks_conflicting_aliases_even_when_url_matches(self) -> None:
        result = self.guard(
            tool_name="a2a_discover",
            args={
                "url": "https://alpha.example/a2a",
                "agent": "alpha",
                "name": "beta",
            },
        )
        self.assertEqual(result["action"], "block")
        self.assertEqual(self.denials[-1]["peer"], "unknown")

    def test_orchestrate_unknown_a2a_and_task_routes_are_blocked(self) -> None:
        for tool_name in ("a2a_orchestrate", "a2a_unknown_network", "tasks/get", "tasks/cancel"):
            result = self.guard(tool_name=tool_name, args={"agent": "alpha"})
            self.assertEqual(result["action"], "block", tool_name)

    def test_only_known_local_inventory_tools_bypass_remote_policy(self) -> None:
        self.assertIsNone(self.guard(tool_name="a2a_list", args={}))
        self.assertIsNone(self.guard(tool_name="a2a_history", args={}))

    def test_policy_read_failure_blocks_and_audit_failure_still_blocks(self) -> None:
        self.guard = make_pre_tool_call_guard(lambda: (_ for _ in ()).throw(RuntimeError("secret")), lambda **_: None)
        self.assertEqual(self.guard(tool_name="a2a_call", args={"agent": "alpha"})["action"], "block")

        self.guard = make_pre_tool_call_guard(
            lambda: self.state,
            lambda **_: (_ for _ in ()).throw(OSError("do not expose")),
        )
        self.assertEqual(self.guard(tool_name="a2a_call", args={"agent": "gamma"})["action"], "block")

    def test_denial_audit_records_only_unambiguous_root_declared_aliases(self) -> None:
        self.state["trusted_peers"] = {"alpha"}

        self.assertEqual(
            self.guard(tool_name="a2a_call", args={"agent": "beta"})["action"],
            "block",
        )
        self.assertEqual(self.denials[-1]["peer"], "beta")

        self.assertEqual(
            self.guard(tool_name="a2a_call", args={"agent": "caller-secret-987654"})["action"],
            "block",
        )
        self.assertEqual(self.denials[-1]["peer"], "unknown")
        self.assertNotIn("caller-secret-987654", str(self.denials[-1]))

        self.assertEqual(
            self.guard(
                tool_name="a2a_call",
                args={"agent": "alpha", "name": "beta"},
            )["action"],
            "block",
        )
        self.assertEqual(self.denials[-1]["peer"], "unknown")

    def test_audit_record_is_bounded_metadata_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            append_policy_denial(
                tmp,
                peer="alpha",
                method="a2a_call",
                task_id="task-0123456789abcdef",
            )
            path = Path(tmp) / "policy_denials.jsonl"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            record = json.loads(path.read_text())
            self.assertEqual(record["source"], "operator.policy_guard")
            self.assertEqual(record["direction"], "denied")
            self.assertEqual(record["peer"], "alpha")
            self.assertEqual(record["method"], "a2a_call")
            self.assertEqual(record["task_id"], "task-0123456789abcdef")
            self.assertEqual(record["status"], "blocked")
            self.assertNotIn("args", record)
            self.assertNotIn("message", record)

    def test_audit_refuses_symlink_destination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            target = Path(tmp) / "target"
            target.write_text("leave unchanged")
            (Path(tmp) / "policy_denials.jsonl").symlink_to(target)
            with self.assertRaises(OSError):
                append_policy_denial(tmp, peer="alpha", method="a2a_call")
            self.assertEqual(target.read_text(), "leave unchanged")

    def test_audit_omits_non_generated_task_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            append_policy_denial(
                tmp,
                peer="alpha",
                method="a2a_call",
                task_id="secret-or-user-supplied-text",
            )
            record = json.loads((Path(tmp) / "policy_denials.jsonl").read_text())
            self.assertNotIn("task_id", record)


if __name__ == "__main__":
    unittest.main()

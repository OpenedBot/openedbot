from __future__ import annotations

import json
import os
import socket
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from ohb_a2a_policy.snapshot import (
    A2APolicySnapshotServer,
    _peer_uid_allowed,
    build_snapshot,
)


def _metadata(**extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "peerTokens": {"raw-secret-token": "alpha", "other-secret-token": "beta"},
        "trustedPeers": {"alpha"},
        "peerTokensOverride": False,
        "trustedPeersOverride": False,
        "allowAllUsers": False,
        "localhostOnly": False,
        "policyGuard": True,
    }
    result.update(extra)
    return result


class SnapshotProjectionTests(unittest.TestCase):
    def test_snapshot_uses_peer_token_values_never_keys(self) -> None:
        encoded = json.dumps(build_snapshot(_metadata(), "generation-test"), sort_keys=True)
        self.assertIn('"alpha"', encoded)
        self.assertIn('"beta"', encoded)
        self.assertNotIn("raw-secret-token", encoded)
        self.assertNotIn("other-secret-token", encoded)

    def test_snapshot_has_exact_allowlisted_fields_and_required_localhost_flag(self) -> None:
        snapshot = build_snapshot(_metadata(unrecognized="must not escape"), "generation-test")
        self.assertEqual(
            set(snapshot),
            {
                "schema",
                "generation",
                "peerNames",
                "trustedPeers",
                "peerTokensOverride",
                "trustedPeersOverride",
                "allowAllUsers",
                "localhostOnly",
                "policyGuard",
            },
        )
        self.assertFalse(snapshot["localhostOnly"])

    def test_snapshot_rejects_unbounded_or_malformed_metadata(self) -> None:
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(peerTokens={"token": "x" * 129}), "generation-test")
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(peerTokens={str(index): f"peer{index}" for index in range(33)}), "generation-test")
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(peerTokens={"token": "UpperCase"}), "generation-test")
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(policyGuard=1), "generation-test")
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(peerTokens=["token"]), "generation-test")

    def test_trusted_ip_identities_are_allowed_with_bounded_aliases(self) -> None:
        snapshot = build_snapshot(_metadata(trustedPeers={"alpha", "ip:127.0.0.1"}), "generation-test")
        self.assertEqual(snapshot["trustedPeers"], ["alpha", "ip:127.0.0.1"])
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(trustedPeers={"ip:not-an-address"}), "generation-test")
        with self.assertRaises(ValueError):
            build_snapshot(_metadata(trustedPeers={f"peer{index}" for index in range(33)}), "generation-test")


class SnapshotSocketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.server = A2APolicySnapshotServer(self.tmp.name, _metadata, lambda: True)
        self.assertTrue(self.server.start())

    def tearDown(self) -> None:
        self.server.close()
        self.tmp.cleanup()

    def _request(self, request: bytes = b'{"schema":1,"op":"snapshot"}\n') -> bytes:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(1)
        chunks: list[bytes] = []
        try:
            client.connect(str(self.server.path))
            client.sendall(request)
            while True:
                try:
                    chunk = client.recv(4096)
                except ConnectionResetError:
                    # A rejected same-UID frame may be reset while unread
                    # request bytes remain in the local socket buffer.
                    break
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            client.close()
        return b"".join(chunks)

    def test_socket_is_private_same_uid_and_returns_one_metadata_object_then_eof(self) -> None:
        directory_stat = os.lstat(self.server.path.parent)
        socket_stat = os.lstat(self.server.path)
        self.assertEqual(stat.S_IMODE(directory_stat.st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(socket_stat.st_mode), 0o600)
        self.assertEqual(directory_stat.st_uid, os.geteuid())
        self.assertEqual(socket_stat.st_uid, os.geteuid())

        first = self._request()
        second = self._request()
        response = json.loads(first)
        self.assertEqual(response["schema"], 1)
        self.assertEqual(response["peerNames"], ["alpha", "beta"])
        self.assertTrue(response["policyGuard"])
        self.assertEqual(response["generation"], json.loads(second)["generation"])
        self.assertNotIn(b"raw-secret-token", first)
        self.assertLessEqual(len(first), 16 * 1024)

    def test_duplicate_unknown_malformed_and_trailing_requests_receive_nothing(self) -> None:
        bad_requests = (
            b'{"schema":1,"schema":1,"op":"snapshot"}\n',
            b'{"schema":1,"op":"snapshot","extra":true}\n',
            b'{"schema":1,"op":"snapshot"} trailing\n',
            b'{"schema":2,"op":"snapshot"}\n',
            b'{"schema":1,"op":"snapshot"}\n{}',
        )
        for request in bad_requests:
            with self.subTest(request=request):
                self.assertEqual(self._request(request), b"")

    def test_linux_allows_gateway_uid_and_root_operator_only(self) -> None:
        with (
            patch("ohb_a2a_policy.snapshot.sys.platform", "linux"),
            patch("ohb_a2a_policy.snapshot.os.geteuid", return_value=999),
        ):
            self.assertTrue(_peer_uid_allowed(999))
            self.assertTrue(_peer_uid_allowed(0))
            self.assertFalse(_peer_uid_allowed(1000))
            self.assertFalse(_peer_uid_allowed(None))

    def test_darwin_allows_only_gateway_uid(self) -> None:
        with (
            patch("ohb_a2a_policy.snapshot.sys.platform", "darwin"),
            patch("ohb_a2a_policy.snapshot.os.geteuid", return_value=999),
        ):
            self.assertTrue(_peer_uid_allowed(999))
            self.assertFalse(_peer_uid_allowed(0))
            self.assertFalse(_peer_uid_allowed(1000))

    def test_foreign_uid_is_rejected(self) -> None:
        with patch("ohb_a2a_policy.snapshot._peer_uid", return_value=os.geteuid() + 1):
            self.assertEqual(self._request(), b"")

    def test_provider_failure_closes_without_leaking_error_details(self) -> None:
        self.server.close()
        self.server = A2APolicySnapshotServer(
            self.tmp.name,
            lambda: (_ for _ in ()).throw(RuntimeError("private-token-value")),
            lambda: True,
        )
        self.server.start()
        self.assertEqual(self._request(), b"")

    def test_close_removes_only_its_socket(self) -> None:
        path = self.server.path
        self.server.close()
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()

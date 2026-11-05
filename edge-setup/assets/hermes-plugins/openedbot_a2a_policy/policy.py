"""Fail-closed outbound policy for the upstream A2A tools."""

from __future__ import annotations

import json
import os
import re
import stat
import time
from collections.abc import Mapping, Set
from pathlib import Path
from typing import Any, Callable


_ALIAS = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_TRUSTED_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
_TASK_ID = re.compile(r"^task-[a-f0-9]{16}$")
_TOOL = re.compile(r"^[a-z0-9_./-]{1,64}$")
_SAFE_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
_LOCAL_TOOLS = frozenset({"a2a_list", "a2a_history"})
_REMOTE_TOOLS = frozenset({"a2a_call", "a2a_discover"})
_PINNED_A2A_TOOLS = _LOCAL_TOOLS | _REMOTE_TOOLS
_DENIED_MESSAGE = "A2A peer access is blocked by host policy."
_ERROR_MESSAGE = "A2A policy is unavailable under host policy."
_MAX_AUDIT_BYTES = 1024 * 1024


def _clean_alias(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if _ALIAS.fullmatch(candidate) and ".." not in candidate else None


def _peer_alias(args: Mapping[str, Any]) -> tuple[str | None, bool]:
    """Mirror upstream alias precedence while rejecting ambiguous aliases."""
    supplied: list[str] = []
    for key in ("agent", "agent_name", "name"):
        value = args.get(key)
        if not value:
            continue
        if not isinstance(value, str):
            return None, False
        alias = value.strip()
        if alias:
            supplied.append(alias)

    if len(set(supplied)) > 1:
        return None, False
    if not supplied:
        return None, True
    return _clean_alias(supplied[0]), True


def _valid_peer_config(peers: Any) -> bool:
    if not isinstance(peers, Mapping):
        return False
    for name, peer in peers.items():
        if _clean_alias(name) is None or not isinstance(peer, Mapping):
            return False
        url = peer.get("url")
        if not isinstance(url, str) or not url.strip():
            return False
    return True


def _valid_trusted_set(trusted: Any) -> bool:
    return isinstance(trusted, Set) and all(
        isinstance(name, str) and _TRUSTED_IDENTITY.fullmatch(name) is not None for name in trusted
    )


def _safe_audit_task_id(args: Mapping[str, Any]) -> str | None:
    for key in ("task_id", "taskId"):
        candidate = args.get(key)
        if isinstance(candidate, str) and _TASK_ID.fullmatch(candidate):
            return candidate
    return None


def _audit_peer(args: Any, declared_peers: Mapping[str, Any] | None = None) -> str:
    if not isinstance(args, Mapping):
        return "unknown"
    alias, unambiguous = _peer_alias(args)
    if (
        not unambiguous
        or alias is None
        or not isinstance(declared_peers, Mapping)
        or alias not in declared_peers
    ):
        return "unknown"
    return alias


def _is_a2a_related_tool(tool_name: str) -> bool:
    return (
        tool_name.startswith(("a2a_", "a2a.", "a2a/"))
        or tool_name in {"tasks/get", "tasks/cancel", "tasks/cancelPeer"}
    )


def _audit_method(tool_name: Any) -> str:
    if isinstance(tool_name, str) and _TOOL.fullmatch(tool_name):
        return tool_name
    return "unknown"


def is_pinned_a2a_tool(tool_name: Any) -> bool:
    return isinstance(tool_name, str) and tool_name in _PINNED_A2A_TOOLS


def append_policy_denial(
    hermes_home: str | os.PathLike[str],
    *,
    peer: str,
    method: str,
    task_id: str | None = None,
) -> None:
    """Append one bounded metadata-only record to the fixed private journal."""
    home = Path(hermes_home)
    home_stat = os.lstat(home)
    if not stat.S_ISDIR(home_stat.st_mode) or home_stat.st_uid != os.geteuid():
        raise OSError("unsafe Hermes home")

    path = home / "policy_denials.jsonl"
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        file_stat = os.fstat(fd)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or file_stat.st_uid != os.geteuid()
            or file_stat.st_nlink != 1
            or file_stat.st_size > _MAX_AUDIT_BYTES
        ):
            raise OSError("unsafe policy journal")
        os.fchmod(fd, 0o600)

        safe_peer = peer if _clean_alias(peer) is not None or peer == "unknown" else "unknown"
        safe_method = method if _audit_method(method) != "unknown" else "unknown"
        record: dict[str, Any] = {
            "ts": time.time(),
            "source": "operator.policy_guard",
            "direction": "denied",
            "peer": safe_peer,
            "method": safe_method,
            "status": "blocked",
        }
        if task_id is not None and _TASK_ID.fullmatch(task_id):
            record["task_id"] = task_id
        line = (json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
        if len(line) > 512 or file_stat.st_size + len(line) > _MAX_AUDIT_BYTES:
            raise OSError("policy journal limit")
        written = os.write(fd, line)
        if written != len(line):
            raise OSError("short policy journal write")
    finally:
        os.close(fd)


def make_pre_tool_call_guard(
    state_reader: Callable[[], Mapping[str, Any]],
    denial_writer: Callable[..., None],
) -> Callable[..., Any]:
    """Build a public PluginContext pre_tool_call callback.

    Only the two pinned local inventory tools bypass policy reads. All other
    A2A-looking tools are denied unless explicitly handled below.
    """

    def block(
        tool_name: Any,
        args: Any,
        declared_peers: Mapping[str, Any] | None = None,
    ) -> dict[str, str]:
        safe_args = args if isinstance(args, Mapping) else {}
        try:
            denial_writer(
                peer=_audit_peer(safe_args, declared_peers),
                method=_audit_method(tool_name),
                task_id=_safe_audit_task_id(safe_args),
            )
        except Exception:
            # Audit availability must never turn a denied call into an allowed one.
            pass
        return {"action": "block", "message": _DENIED_MESSAGE}

    def guard(tool_name: Any = None, args: Any = None, **_: Any) -> Any:
        if not isinstance(tool_name, str):
            return block(tool_name, args)
        if tool_name in _LOCAL_TOOLS:
            return None

        if tool_name == "a2a_orchestrate":
            return block(tool_name, args)

        if tool_name not in {"a2a_call", "a2a_discover"}:
            return block(tool_name, args) if _is_a2a_related_tool(tool_name) else None

        if not isinstance(args, Mapping):
            return block(tool_name, args)

        try:
            state = state_reader()
            if not isinstance(state, Mapping):
                return block(tool_name, args)
            peers = state.get("a2a_agents")
            trusted = state.get("trusted_peers")
            if not _valid_peer_config(peers) or not _valid_trusted_set(trusted):
                return block(tool_name, args)

            if tool_name == "a2a_call":
                alias, unambiguous = _peer_alias(args)
                if (
                    not unambiguous
                    or alias is None
                    or alias not in peers
                    or alias not in trusted
                ):
                    return block(tool_name, args, peers)
                return None

            raw_url = args.get("url")
            if not isinstance(raw_url, str) or not raw_url:
                return block(tool_name, args)
            matches = [
                name
                for name, peer in peers.items()
                if name in trusted and peer.get("url") == raw_url
            ]
            if len(matches) != 1:
                return block(tool_name, args, peers)
            supplied_name, unambiguous = _peer_alias(args)
            if not unambiguous:
                return block(tool_name, args, peers)
            if supplied_name is not None and supplied_name != matches[0]:
                return block(tool_name, args, peers)
            return None
        except Exception:
            # Upstream pre-tool hook dispatch can fail open on raised errors.
            return block(tool_name, args)

    return guard


def make_tool_execution_middleware(
    guard: Callable[..., Any],
    root_home_scope: Callable[[], Any],
) -> Callable[..., Any]:
    """Run pinned A2A tools under the fixed root policy and native config."""

    def middleware(
        tool_name: Any = None,
        args: Any = None,
        next_call: Callable[[Any], Any] | None = None,
        **_: Any,
    ) -> Any:
        if not callable(next_call):
            return {"error": _ERROR_MESSAGE}
        if not isinstance(tool_name, str):
            return {"error": _DENIED_MESSAGE}
        if not is_pinned_a2a_tool(tool_name):
            if _is_a2a_related_tool(tool_name):
                return {"error": _DENIED_MESSAGE}
            return next_call(args)

        try:
            scope = root_home_scope()
            scope.__enter__()
        except Exception:
            return {"error": _ERROR_MESSAGE}

        try:
            try:
                decision = guard(tool_name=tool_name, args=args)
            except Exception:
                return {"error": _ERROR_MESSAGE}
            if isinstance(decision, Mapping) and decision.get("action") == "block":
                return {"error": _DENIED_MESSAGE}
            # Do not catch this call. The upstream middleware wraps and
            # re-raises downstream exceptions; the finally only restores scope.
            return next_call(args)
        finally:
            scope.__exit__(None, None, None)

    return middleware

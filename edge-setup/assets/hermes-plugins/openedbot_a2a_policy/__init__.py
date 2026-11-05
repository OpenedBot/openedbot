"""openedbot's fail-closed named-peer guard and private policy snapshot."""

from __future__ import annotations

import atexit
import os
from pathlib import Path
from typing import Any

from .policy import (
    append_policy_denial,
    make_pre_tool_call_guard,
    make_tool_execution_middleware,
)
from .runtime_scope import managed_profile_guards_ready, root_home_scope, resolve_runtime_home
from .snapshot import A2APolicySnapshotServer


_EVENT = "openedbot_a2a_policy:gateway_start"
_guard_registered = False
_registered_homes: set[str] = set()
_snapshot_server: A2APolicySnapshotServer | None = None
_snapshot_home: str | None = None
_atexit_registered = False


def _hermes_home() -> Path:
    from hermes_cli.config import get_config_path

    return Path(get_config_path()).parent


def _runtime_root(home: Path) -> Path:
    marker = home / "plugins" / "openedbot_a2a_policy" / "runtime-home"
    return resolve_runtime_home(home, marker)


def _policy_state(home: Path | None = None) -> dict[str, Any]:
    from hermes_cli.config import load_config
    from plugins.platforms.a2a import security

    active_home = home or _hermes_home()
    marker = active_home / "plugins" / "openedbot_a2a_policy" / "runtime-home"
    with root_home_scope(active_home, marker):
        config = load_config()
        if not isinstance(config, dict):
            raise ValueError("invalid Hermes configuration")
        peers = config.get("a2a_agents") or {}
        trusted = security.get_trusted_peers()
        if not isinstance(peers, dict) or not isinstance(trusted, set):
            raise ValueError("invalid A2A policy state")
        return {"a2a_agents": peers, "trusted_peers": trusted}


def _managed_env_value(home: Path, key: str) -> str | None:
    from hermes_cli.config import load_env

    # Use the same pinned dotenv semantics as the host writer. Missing runtime
    # dependencies fail closed instead of introducing another env-file parser.
    marker = home / "plugins" / "openedbot_a2a_policy" / "runtime-home"
    with root_home_scope(home, marker):
        values = load_env()
    if not isinstance(values, dict):
        raise ValueError("invalid managed environment")
    value = values.get(key)
    return value if isinstance(value, str) else None


def _startup_metadata(peer_tokens_override: bool) -> dict[str, Any]:
    from hermes_cli.config import load_config
    from plugins.platforms.a2a import security

    home = _hermes_home()
    config = load_config()
    if not isinstance(config, dict):
        raise ValueError("invalid Hermes configuration")
    peer_tokens = security.get_peer_tokens()
    trusted = security.get_trusted_peers()
    if not isinstance(peer_tokens, dict) or not isinstance(trusted, set):
        raise ValueError("invalid A2A security state")
    return {
        # The socket projector uses VALUES only. Token keys remain local and
        # are never copied to a response or log.
        "peerTokens": peer_tokens,
        "trustedPeers": trusted,
        "peerTokensOverride": peer_tokens_override,
        "trustedPeersOverride": bool(os.environ.get("A2A_TRUSTED_PEERS", "").strip()),
        "allowAllUsers": os.environ.get("A2A_ALLOW_ALL_USERS", "").strip().lower()
        in {"1", "true", "yes"},
        "localhostOnly": security.localhost_only(),
        "a2a_agents": config.get("a2a_agents") or {},
    }


def _metadata_provider(home: Path):
    # Freeze the known process-vs-managed-file mismatch for this gateway
    # generation. A later host-owned .env write must not masquerade as a
    # preloaded external override until the gateway has actually restarted.
    peer_tokens_override = os.environ.get("A2A_PEER_TOKENS", "") != (
        _managed_env_value(home, "A2A_PEER_TOKENS") or ""
    )

    def provide() -> dict[str, Any]:
        marker = home / "plugins" / "openedbot_a2a_policy" / "runtime-home"
        with root_home_scope(home, marker):
            return _startup_metadata(peer_tokens_override)

    return provide


def _close_snapshot() -> None:
    global _snapshot_server, _snapshot_home
    server = _snapshot_server
    _snapshot_server = None
    _snapshot_home = None
    if server is not None:
        server.close()


def _on_gateway_start(home: Path, home_key: str, *, gatewayStart: bool = False) -> bool:
    global _snapshot_server, _snapshot_home, _atexit_registered
    if gatewayStart is not True or home_key not in _registered_homes:
        return False
    try:
        runtime_root = _runtime_root(home)
    except Exception:
        if _snapshot_home == home_key:
            _close_snapshot()
        return False
    # The fixed snapshot endpoint belongs to the runtime root. Profile plugin
    # instances enforce the same root policy but never start another socket.
    if home.resolve(strict=True) != runtime_root:
        return False
    if _snapshot_server is not None:
        if _snapshot_home != home_key:
            return False
        try:
            return _snapshot_server.start() is True
        except Exception:
            _close_snapshot()
            return False
    try:
        server = A2APolicySnapshotServer(
            runtime_root,
            _metadata_provider(home),
            lambda: home_key in _registered_homes and managed_profile_guards_ready(runtime_root),
        )
        if server.start() is not True:
            return False
        _snapshot_server = server
        _snapshot_home = home_key
        if not _atexit_registered:
            atexit.register(_close_snapshot)
            _atexit_registered = True
        return True
    except Exception:
        _close_snapshot()
        return False


def _on_unload() -> None:
    _unload_home(None)


def _unload_home(home_key: str | None) -> None:
    global _guard_registered, _snapshot_home
    if home_key is None:
        _registered_homes.clear()
    else:
        _registered_homes.discard(home_key)
    _guard_registered = bool(_registered_homes)
    if _snapshot_home is not None and (home_key is None or _snapshot_home == home_key):
        _snapshot_home = None
        _close_snapshot()


def register(ctx: Any) -> None:
    """Register fail-closed policy hooks for this active Hermes home."""
    global _guard_registered
    home = _hermes_home()
    home_key = str(home.resolve(strict=False))
    if home_key in _registered_homes:
        return
    _registered_homes.add(home_key)
    _guard_registered = True

    marker = home / "plugins" / "openedbot_a2a_policy" / "runtime-home"

    def write_denial(*, peer: str, method: str, task_id: str | None = None) -> None:
        try:
            runtime_root = resolve_runtime_home(home, marker)
            append_policy_denial(runtime_root, peer=peer, method=method, task_id=task_id)
        except Exception:
            # Invalid marker state must not prevent the policy from blocking.
            return

    guard = make_pre_tool_call_guard(lambda: _policy_state(home), write_denial)
    middleware = make_tool_execution_middleware(
        guard,
        lambda: root_home_scope(home, marker),
    )

    def gateway_start(**kwargs: Any) -> bool:
        return _on_gateway_start(home, home_key, **kwargs)

    def unload() -> None:
        _unload_home(home_key)

    try:
        ctx.register_middleware("tool_execution", middleware)
        ctx.register_hook("pre_tool_call", guard)
        ctx.subscribe(_EVENT, gateway_start)
        ctx.on_unload(unload)
    except Exception:
        _unload_home(home_key)
        raise


__all__ = ["register"]

"""Private owner-checked Unix socket for bounded A2A policy metadata."""

from __future__ import annotations

import ctypes
import ipaddress
import json
import os
import secrets
import re
import select
import socket
import stat
import struct
import sys
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any


_REQUEST = b'{"schema":1,"op":"snapshot"}\n'
_MAX_REQUEST = 1024
_MAX_RESPONSE = 16 * 1024
_MAX_NAMES = 32
_MAX_NAME_CHARS = 64
_PEER_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def _identity_names(value: Any, *, allow_ip_identity: bool = False) -> list[str]:
    if not isinstance(value, (set, frozenset, list, tuple)):
        raise ValueError("invalid identity set")
    if len(value) > _MAX_NAMES:
        raise ValueError("too many identities")
    names: set[str] = set()
    for name in value:
        if (
            not isinstance(name, str)
            or not name
            or len(name) > _MAX_NAME_CHARS
        ):
            raise ValueError("invalid identity")
        if _PEER_NAME.fullmatch(name) is None or ".." in name:
            if not allow_ip_identity or not name.startswith("ip:"):
                raise ValueError("invalid identity")
            if name not in {"ip:local", "ip:unknown"}:
                try:
                    ipaddress.ip_address(name[3:])
                except ValueError as error:
                    raise ValueError("invalid identity") from error
        names.add(name)
    return sorted(names)


def build_snapshot(metadata: Mapping[str, Any], generation: str) -> dict[str, Any]:
    """Project only allowlisted values; peer token keys never leave this function."""
    peer_tokens = metadata.get("peerTokens")
    if not isinstance(peer_tokens, Mapping):
        raise ValueError("invalid peer-token map")
    result = {
        "schema": 1,
        "generation": generation,
        "peerNames": _identity_names(list(peer_tokens.values())),
        "trustedPeers": _identity_names(metadata.get("trustedPeers"), allow_ip_identity=True),
    }
    for field in (
        "peerTokensOverride",
        "trustedPeersOverride",
        "allowAllUsers",
        "localhostOnly",
        "policyGuard",
    ):
        value = metadata.get(field)
        if type(value) is not bool:
            raise ValueError("invalid policy flag")
        result[field] = value
    return result


def _peer_uid(connection: socket.socket) -> int | None:
    """Read the connected process UID on Linux or macOS."""
    if sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED"):
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
        return uid
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        getpeereid = getattr(libc, "getpeereid", None)
        if getpeereid is None:
            return None
        uid = ctypes.c_uint()
        gid = ctypes.c_uint()
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        getpeereid.restype = ctypes.c_int
        if getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            return None
        return int(uid.value)
    return None


def _peer_uid_allowed(peer_uid: int | None) -> bool:
    """Allow the gateway user, plus the Linux root operator that observes it."""
    if peer_uid is None:
        return False
    runtime_uid = os.geteuid()
    if peer_uid == runtime_uid:
        return True
    return sys.platform.startswith("linux") and peer_uid == 0


def _read_request(connection: socket.socket) -> bool:
    connection.settimeout(0.5)
    data = bytearray()
    try:
        while len(data) <= _MAX_REQUEST:
            chunk = connection.recv(min(256, _MAX_REQUEST + 1 - len(data)))
            if not chunk:
                return False
            data.extend(chunk)
            if b"\n" in chunk:
                if bytes(data) != _REQUEST:
                    return False
                # Reject extra bytes already sent in the same request. The
                # short bounded check preserves the newline protocol without
                # waiting for a client write-half-close.
                readable, _, _ = select.select([connection], [], [], 0.01)
                if readable:
                    try:
                        if connection.recv(_MAX_REQUEST + 1, socket.MSG_DONTWAIT):
                            return False
                    except BlockingIOError:
                        pass
                return True
    except (OSError, TimeoutError):
        return False
    return False


class A2APolicySnapshotServer:
    """Serve exact metadata requests from the runtime user or Linux root operator."""

    def __init__(
        self,
        hermes_home: str | os.PathLike[str],
        metadata_provider: Callable[[], Mapping[str, Any]],
        guard_registered: Callable[[], bool],
    ) -> None:
        self._home = Path(hermes_home)
        self._metadata_provider = metadata_provider
        self._guard_registered = guard_registered
        self._path = self._home / ".openedbot-a2a-policy" / "state.sock"
        self._generation = secrets.token_hex(16)
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._inode: tuple[int, int] | None = None
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    def start(self) -> bool:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return True
            self._prepare_directory()
            self._remove_owned_stale_socket()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                listener.bind(str(self._path))
                created_stat = os.lstat(self._path)
                self._inode = (created_stat.st_dev, created_stat.st_ino)
                os.chmod(self._path, 0o600, follow_symlinks=False)
                sock_stat = os.lstat(self._path)
                if (
                    not stat.S_ISSOCK(sock_stat.st_mode)
                    or sock_stat.st_uid != os.geteuid()
                    or stat.S_IMODE(sock_stat.st_mode) != 0o600
                ):
                    raise OSError("unsafe snapshot socket")
                listener.listen(8)
                listener.settimeout(0.2)
                self._listener = listener
                self._stop.clear()
                thread = threading.Thread(target=self._serve, name="openedbot-a2a-policy", daemon=True)
                self._thread = thread
                thread.start()
                return True
            except Exception:
                listener.close()
                self._unlink_owned_socket()
                self._listener = None
                self._thread = None
                raise

    def close(self) -> None:
        with self._lock:
            listener = self._listener
            thread = self._thread
            self._listener = None
            self._thread = None
            self._stop.set()
            if listener is not None:
                try:
                    listener.close()
                except OSError:
                    pass
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        self._unlink_owned_socket()
        try:
            self._path.parent.rmdir()
        except OSError:
            pass

    def _prepare_directory(self) -> None:
        home_stat = os.lstat(self._home)
        if not stat.S_ISDIR(home_stat.st_mode) or home_stat.st_uid != os.geteuid():
            raise OSError("unsafe Hermes home")
        directory = self._path.parent
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
        dir_stat = os.lstat(directory)
        if not stat.S_ISDIR(dir_stat.st_mode) or dir_stat.st_uid != os.geteuid():
            raise OSError("unsafe snapshot directory")
        os.chmod(directory, 0o700, follow_symlinks=False)
        verified = os.lstat(directory)
        if stat.S_IMODE(verified.st_mode) != 0o700 or verified.st_uid != os.geteuid():
            raise OSError("unsafe snapshot directory")

    def _remove_owned_stale_socket(self) -> None:
        try:
            before = os.lstat(self._path)
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(before.st_mode) or before.st_uid != os.geteuid():
            raise FileExistsError("snapshot path is occupied")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.1)
            probe.connect(str(self._path))
        except (ConnectionRefusedError, FileNotFoundError, TimeoutError):
            after = os.lstat(self._path)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise FileExistsError("snapshot path changed")
            os.unlink(self._path)
        else:
            raise FileExistsError("snapshot server already active")
        finally:
            probe.close()

    def _unlink_owned_socket(self) -> None:
        inode = self._inode
        if inode is None:
            return
        try:
            current = os.lstat(self._path)
            if (
                stat.S_ISSOCK(current.st_mode)
                and current.st_uid == os.geteuid()
                and (current.st_dev, current.st_ino) == inode
            ):
                os.unlink(self._path)
        except OSError:
            pass
        self._inode = None

    def _serve(self) -> None:
        listener = self._listener
        if listener is None:
            return
        while not self._stop.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with connection:
                try:
                    if not _peer_uid_allowed(_peer_uid(connection)):
                        continue
                    if not _read_request(connection):
                        continue
                    metadata = self._metadata_provider()
                    if not isinstance(metadata, Mapping):
                        continue
                    metadata = dict(metadata)
                    metadata["policyGuard"] = self._guard_registered() is True
                    result = build_snapshot(metadata, self._generation)
                    encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=True).encode("ascii")
                    if len(encoded) > _MAX_RESPONSE:
                        continue
                    connection.sendall(encoded)
                except Exception:
                    # No exception detail or config content crosses this boundary.
                    continue

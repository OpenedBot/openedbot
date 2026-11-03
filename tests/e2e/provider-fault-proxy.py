"""Owner-lab fixture: forward real Responses requests from one disposable profile."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

def emit(value):
    print(json.dumps(value), flush=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def restore_saved_files(saved):
    results = {}
    for path, backup in saved.items():
        operations = [lambda: path.unlink(missing_ok=True)] if backup is None else [
            lambda: path.write_bytes(backup[0]),
            lambda: os.chmod(path, backup[1]),
            lambda: os.chown(path, backup[2], backup[3]),
        ]
        operations_ok = True
        for operation in operations:
            try:
                operation()
            except Exception:
                operations_ok = False
        try:
            verified = not path.exists() if backup is None else (
                digest(path) == hashlib.sha256(backup[0]).hexdigest()
                and stat.S_IMODE(path.stat().st_mode) == backup[1]
                and (path.stat().st_uid, path.stat().st_gid) == backup[2:])
        except Exception:
            verified = False
        results[path.name] = operations_ok and verified
    return results


class OwnerInterrupted(Exception):
    pass


def owner_interrupted(_signum, _frame):
    raise OwnerInterrupted()


def main():
    import yaml

    profile, mode = sys.argv[1:]
    if not re.fullmatch(r"recette-ohb-119-[a-z0-9-]{1,100}", profile) or mode not in ("slow", "error_after_dispatch"):
        raise SystemExit(2)
    root = Path("/srv/hermes/data")
    profile_dir = root / "profiles" / profile
    if not profile_dir.is_dir() or profile_dir.is_symlink() or profile_dir.resolve().parent != (root / "profiles").resolve():
        raise SystemExit(2)
    config_path, auth_path = profile_dir / "config.yaml", profile_dir / "auth.json"
    if not config_path.is_file() or config_path.is_symlink() or auth_path.is_symlink():
        raise SystemExit(2)
    root_paths = [path for path in root.iterdir() if path.is_file() and not path.is_symlink()
                  and (path.name in (".env", "config.yaml", "auth.json", ".auth.json")
                       or "credential" in path.name or "pool" in path.name)]
    root_hashes = {path: digest(path) for path in root_paths}
    root_pool = json.loads((root / "auth.json").read_bytes()).get("credential_pool", {}).get("openai-api", [])
    if len(root_pool) != 1 or root_pool[0].get("auth_type") != "api_key" or str(root_pool[0].get("base_url", "")).rstrip("/") != "https://api.openai.com/v1":
        emit({"ready": False, "error": "owner_openai_pool_ambiguous"})
        raise SystemExit(2)
    key = root_pool[0].get("access_token")
    if not isinstance(key, str) or not key:
        emit({"ready": False, "error": "owner_openai_key_unavailable"})
        raise SystemExit(2)
    saved = {path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode), path.stat().st_uid, path.stat().st_gid) if path.exists() else None
             for path in (config_path, auth_path)}
    proof = {"mode": mode, "requests": 0, "forwardedPosts": 0, "upstreamStatuses": [],
             "dummyAuthorizationSeen": False, "delayMs": 0, "errorAfterRealDispatch": False}
    lock = threading.Lock()
    dummy = "ohb-owner-fault-" + uuid.uuid4().hex


    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def failure(self, status=503):
            body = b'{"error":{"message":"Owner recipe provider fault","type":"server_error","code":"ohb_owner_fault"}}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            if self.path != "/v1/responses" or not 0 < size <= 2_000_000:
                self.failure(400)
                return
            body = self.rfile.read(size)
            if self.headers.get("Authorization") != "Bearer " + dummy:
                proof["authorizationMismatch"] = True
                self.failure(401)
                return
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeError):
                self.failure(400)
                return
            if not isinstance(payload, dict) or payload.get("model") != "gpt-5.4-mini":
                proof["modelMismatch"] = True
                self.failure(400)
                return
            with lock:
                proof["requests"] += 1
                proof["dummyAuthorizationSeen"] |= self.headers.get("Authorization") == "Bearer " + dummy
                forward = proof["forwardedPosts"] == 0
                if forward:
                    proof["forwardedPosts"] += 1
                    proof["requestedModel"] = "gpt-5.4-mini"
                    proof["requestedStream"] = payload.get("stream") is True
            # SDK retries receive the fault without charging a second real response.
            if not forward:
                self.failure()
                return
            if mode == "slow":
                before = time.monotonic()
                time.sleep(3)
                proof["delayMs"] = round((time.monotonic() - before) * 1000)
            upstream_headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
            if self.headers.get("Accept"):
                upstream_headers["Accept"] = self.headers["Accept"]
            request = urllib.request.Request("https://api.openai.com/v1/responses", data=body, method="POST", headers=upstream_headers)
            try:
                with urllib.request.urlopen(request, timeout=45) as upstream:
                    proof["upstreamStatuses"].append(upstream.status)
                    content_type = upstream.headers.get_content_type()
                    proof["streamModePreserved"] = content_type == ("text/event-stream" if proof["requestedStream"] else "application/json")
                    first = upstream.read1(4096)
                    if mode == "error_after_dispatch":
                        proof["errorAfterRealDispatch"] = upstream.status == 200 and bool(first)
                        self.failure()
                        return
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", upstream.headers.get("Content-Type", "text/event-stream"))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(first)
                    self.wfile.flush()
                    while chunk := upstream.read1(4096):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    self.close_connection = True
            except urllib.error.HTTPError as error:
                proof["upstreamStatuses"].append(error.code)
                self.failure()
            except Exception:
                proof["transportError"] = True
                try:
                    self.failure()
                except Exception:
                    pass


    server = None
    server_started = False
    restored = False
    try:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, owner_interrupted)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        server_started = True
        config = yaml.safe_load(saved[config_path][0])
        if not isinstance(config, dict) or not isinstance(config.get("model"), dict):
            raise ValueError("profile_model_unavailable")
        config["model"]["provider"] = "openai-api"
        config["model"]["default"] = "gpt-5.4-mini"
        config["model"]["base_url"] = f"http://127.0.0.1:{server.server_port}/v1"
        config_path.write_text(yaml.safe_dump(config, allow_unicode=True))
        auth = json.loads(saved[auth_path][0]) if saved[auth_path] else {"providers": {}, "credential_pool": {}}
        if not isinstance(auth, dict) or not isinstance(auth.get("credential_pool", {}), dict):
            raise ValueError("profile_auth_unavailable")
        auth.setdefault("credential_pool", {})["openai-api"] = [{
            "id": str(uuid.uuid4()), "label": "Owner provider fault", "auth_type": "api_key", "priority": 0,
            "source": "manual:ohb-fault-proxy", "access_token": dummy, "base_url": "https://api.openai.com/v1",
        }]
        auth_path.write_text(json.dumps(auth))
        os.chmod(auth_path, 0o600)
        os.chown(auth_path, config_path.stat().st_uid, config_path.stat().st_gid)
        verified = yaml.safe_load(config_path.read_text())["model"]["base_url"] == config["model"]["base_url"]
        verified &= yaml.safe_load(config_path.read_text())["model"]["default"] == "gpt-5.4-mini"
        verified &= json.loads(auth_path.read_text())["credential_pool"]["openai-api"][0]["access_token"] == dummy
        if not verified:
            raise ValueError("profile_fixture_unverified")
        emit({"ready": True, "profile": profile, "mode": mode, "loopbackOnly": True, "model": "gpt-5.4-mini"})
        # The owner signals completion over stdin; timeout and SSH EOF also restore.
        if select.select([sys.stdin], [], [], 180)[0]:
            sys.stdin.readline()
    except Exception:
        proof["fixtureError"] = True
    finally:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        if server:
            for cleanup in ([server.shutdown] if server_started else []) + [server.server_close]:
                try:
                    cleanup()
                except Exception:
                    proof["cleanupError"] = True
        proof["restoredFiles"] = restore_saved_files(saved)
        restored = all(proof["restoredFiles"].values())
        try:
            proof["rootConfigurationUnchanged"] = all(digest(path) == value for path, value in root_hashes.items())
        except Exception:
            proof["rootConfigurationUnchanged"] = False
        emit({"restored": restored, **proof})


if __name__ == "__main__":
    main()

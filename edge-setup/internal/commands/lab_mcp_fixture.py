"""Fixed, local development MCP probe; never a generic command provisioner.

The root CLI owns the authorization receipt. This program runs as Hermes and
only patches one nonce-owned entry in one explicitly selected E2E profile.
Its challenge journal is independent of model output, not a security audit
against another process already controlling the Hermes operating-system user.
"""
import fcntl
import io
import json
import os
import re
import stat
import sys
import tempfile
import time

ROOT = "/srv/hermes/data"
PYTHON = "/usr/local/lib/hermes-agent/venv/bin/python"
SCRIPT = os.path.abspath(__file__)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
PROFILE = re.compile(r"^e2e-[a-z0-9][a-z0-9-]{0,58}$")
CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
MAX_CALLS = 128
MAX_BYTES = 32768


def require(value, message):
    if not value:
        raise ValueError(message)


def directory(path, create=False):
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid(), "fixture directory ownership is invalid")
    return path


def read_bytes(path, limit=MAX_BYTES):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_size <= limit, "fixture file ownership or size is invalid")
        data = handle.read(limit + 1)
        require(len(data) <= limit, "fixture file exceeded its bound")
        return data


def atomic(path, data):
    parent = directory(os.path.dirname(path))
    if os.path.lexists(path):
        info = os.lstat(path)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "fixture write target changed ownership")
    fd, temporary = tempfile.mkstemp(prefix=".lab-mcp-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def yaml_load(text):
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        from ruamel.yaml import YAML
        return YAML(typ="safe", pure=True).load(text)


def yaml_dump(value):
    try:
        import yaml
        return yaml.safe_dump(value, sort_keys=False, allow_unicode=True)
    except ImportError:
        from ruamel.yaml import YAML
        output = io.StringIO()
        writer = YAML(typ="safe", pure=True)
        writer.default_flow_style = False
        writer.dump(value, output)
        return output.getvalue()


def entry(nonce, script=SCRIPT):
    return {"command": PYTHON, "args": [script, "serve", nonce]}


def bound_entry(actual, expected):
    if not isinstance(actual, dict) or not isinstance(actual.get("enabled", True), bool):
        return False
    return {key: value for key, value in actual.items() if key != "enabled"} == expected


def paths(request, create=False):
    nonce, profile = request.get("nonce"), request.get("profile")
    require(isinstance(nonce, str) and UUID.fullmatch(nonce), "invalid fixture nonce")
    require(isinstance(profile, str) and PROFILE.fullmatch(profile), "invalid E2E profile")
    require(isinstance(request.get("runtimeId"), str) and UUID.fullmatch(request["runtimeId"]), "invalid fixture runtime")
    require(request.get("serverName") == "e2e_" + nonce.replace("-", ""), "invalid fixture server identity")
    directory(ROOT)
    directory(os.path.join(ROOT, "profiles"))
    profile_dir = directory(os.path.join(ROOT, "profiles", profile))
    parent = os.path.join(ROOT, "lab-mcp-fixtures")
    state_dir = os.path.join(parent, nonce)
    allowed_missing = ((request.get("state") == "preparing" and request.get("action") in ("receipts", "remove"))
                       or (request.get("state") == "removing" and request.get("action") == "cleanup"))
    if allowed_missing and not os.path.lexists(state_dir):
        if os.path.lexists(parent):
            directory(parent)
        return profile_dir, state_dir
    directory(parent, create)
    directory(state_dir, create)
    return profile_dir, state_dir


def load_state(state_dir, request):
    state = json.loads(read_bytes(os.path.join(state_dir, "state.json")))
    for field in ("nonce", "profile", "runtimeId", "serverName"):
        require(state.get(field) == request.get(field), "fixture state changed ownership")
    require(isinstance(state.get("online"), bool) and re.fullmatch(r"MCP_[0-9a-f]{32}", state.get("secret", "")), "fixture state is invalid")
    return state


def calls(state_dir):
    try:
        raw = read_bytes(os.path.join(state_dir, "calls.jsonl"))
    except FileNotFoundError:
        return []
    rows = [json.loads(line) for line in raw.splitlines()]
    require(len(rows) <= MAX_CALLS, "fixture call journal exceeded its bound")
    for row in rows:
        require(set(row) == {"challenge", "succeeded"} and isinstance(row["challenge"], str) and CHALLENGE.fullmatch(row["challenge"]) and isinstance(row["succeeded"], bool), "fixture call journal is invalid")
    return rows


def process_ticks(pid):
    try:
        # A PID alone can be reused. /proc start ticks bind the actual child.
        with open("/proc/%d/stat" % pid, encoding="utf-8") as handle:
            return handle.read().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        return None


def processes(state_dir):
    try:
        raw = read_bytes(os.path.join(state_dir, "starts.jsonl"))
    except FileNotFoundError:
        return []
    rows = [json.loads(line) for line in raw.splitlines()]
    require(len(rows) <= 32, "fixture start journal exceeded its bound")
    result = []
    for marker in rows:
        pid, ticks = marker.get("pid"), marker.get("startTicks")
        require(set(marker) == {"pid", "startTicks"} and isinstance(pid, int) and pid > 0 and isinstance(ticks, str) and ticks.isdigit(), "fixture child marker is invalid")
        result.append({"pid": pid, "startTicks": ticks, "running": process_ticks(pid) == ticks})
    return result


def snapshot(state_dir, installed, online, removed=False):
    children = processes(state_dir)
    return {"installed": installed, "online": online, "calls": calls(state_dir), "removed": removed, "processes": children, "starts": len(children)}


def cleanup(state_dir, request, existing):
    require(request.get("state") == "removing" and existing is None, "fixture entry is not durably removed")
    children = request["processes"]
    for child in children:
        require(process_ticks(child["pid"]) != child["startTicks"], "fixture child restarted; files retained")
    if os.path.lexists(state_dir):
        names = os.listdir(state_dir)
        require(all(name in ("state.json", "calls.jsonl", "starts.jsonl") for name in names), "foreign file in fixture state; cleanup refused")
        # The root receipt captured full histories before deletion. A retry may
        # see any subset of these files after an interrupted unlink sequence.
        if "state.json" in names:
            load_state(state_dir, request)
        if "calls.jsonl" in names:
            require(calls(state_dir) == request["calls"], "fixture calls changed after durable removal")
        if "starts.jsonl" in names:
            observed = processes(state_dir)
            require(observed == children, "fixture processes changed after durable removal")
        for filename in names:
            read_bytes(os.path.join(state_dir, filename))
        for filename in names:
            os.unlink(os.path.join(state_dir, filename))
        os.rmdir(state_dir)
    return {"installed": False, "online": False, "calls": request["calls"], "removed": True, "processes": children, "starts": len(children)}


def control(request):
    action = request.get("action")
    require(action in ("setup", "online", "offline", "receipts", "remove", "cleanup"), "invalid fixture action")
    profile_dir, state_dir = paths(request, action == "setup")
    config_path = os.path.join(profile_dir, "config.yaml")
    config = yaml_load(read_bytes(config_path, 1 << 20).decode("utf-8"))
    require(isinstance(config, dict), "profile config is not a mapping")
    servers = config.get("mcp_servers", {})
    require(isinstance(servers, dict), "profile MCP config is invalid")
    name = request["serverName"]
    existing = servers.get(name)
    expected = entry(request["nonce"], request.get("entryScriptPath", SCRIPT))
    require(existing is None or bound_entry(existing, expected), "profile fixture entry changed ownership")
    if action == "cleanup":
        return cleanup(state_dir, request, existing)
    if not os.path.lexists(state_dir):
        require(existing is None, "profile entry exists without owned fixture state")
        if action == "cleanup" and request.get("state") == "removing":
            return {"installed": False, "online": False, "calls": request["calls"], "removed": True, "processes": request["processes"], "starts": request["starts"]}
        require(request.get("state") == "preparing" and action in ("receipts", "remove"), "owned fixture state is missing")
        return {"installed": False, "online": False, "calls": [], "removed": False, "processes": [], "starts": 0}
    try:
        state = load_state(state_dir, request)
        present = True
    except FileNotFoundError:
        require(request.get("state") == "preparing" and action in ("setup", "receipts", "remove"), "owned fixture state is missing")
        state = {key: request[key] for key in ("nonce", "profile", "runtimeId", "serverName", "secret")}
        state["online"] = True
        present = False
    if action == "setup":
        require(re.fullmatch(r"MCP_[0-9a-f]{32}", request.get("secret", "")) and state["secret"] == request["secret"], "fixture secret changed ownership")
        require(existing is not None or request.get("state") == "preparing", "an installed fixture entry disappeared; cleanup is required")
        atomic(os.path.join(state_dir, "state.json"), json.dumps(state).encode())
        if existing is None:
            servers[name] = {**expected, "enabled": True}
            config["mcp_servers"] = servers
            platform = config.setdefault("platform_toolsets", {})
            require(isinstance(platform, dict), "profile toolsets are invalid")
            enabled = platform.get("api_server", [])
            require(isinstance(enabled, list) and all(isinstance(value, str) for value in enabled), "profile toolsets are invalid")
            platform["api_server"] = enabled + ([] if name in enabled else [name])
            atomic(config_path, yaml_dump(config).encode())
        return snapshot(state_dir, True, state["online"])
    if action in ("online", "offline"):
        require(existing is not None and present, "the owned fixture is not installed")
        state["online"] = action == "online"
        atomic(os.path.join(state_dir, "state.json"), json.dumps(state).encode())
    if action == "remove":
        if not present:
            require(existing is None, "profile entry exists without its owned state")
            return snapshot(state_dir, False, False)
        state["online"] = False
        atomic(os.path.join(state_dir, "state.json"), json.dumps(state).encode())
        if existing is not None:
            del servers[name]
            config["mcp_servers"] = servers
            platform = config.get("platform_toolsets", {})
            require(isinstance(platform, dict), "profile toolsets are invalid")
            enabled = platform.get("api_server", [])
            require(isinstance(enabled, list), "profile toolsets are invalid")
            platform["api_server"] = [value for value in enabled if value != name]
            atomic(config_path, yaml_dump(config).encode())
        deadline = time.monotonic() + 70
        while any(child["running"] for child in processes(state_dir)):
            require(time.monotonic() < deadline, "fixture stdio children did not stop after live reload; files retained")
            time.sleep(0.2)
        return snapshot(state_dir, False, False)
    return snapshot(state_dir, existing is not None, state["online"] if present else False)


def serve(nonce):
    require(UUID.fullmatch(nonce), "invalid fixture nonce")
    state_dir = directory(os.path.join(ROOT, "lab-mcp-fixtures", nonce))
    initial = json.loads(read_bytes(os.path.join(state_dir, "state.json")))
    require(initial.get("nonce") == nonce, "fixture nonce mismatch")
    from mcp.server import MCPServer
    from mcp.types import ToolAnnotations
    server = MCPServer("openedbot-owned-lab")

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
    def read_probe(challenge: str) -> str:
        """Read the private lab proof for this exact challenge."""
        require(isinstance(challenge, str) and CHALLENGE.fullmatch(challenge), "invalid fixture challenge")
        current = load_state(state_dir, initial)
        path = os.path.join(state_dir, "calls.jsonl")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            require(len(calls(state_dir)) < MAX_CALLS, "fixture call limit reached")
            handle.write((json.dumps({"challenge": challenge, "succeeded": current["online"]}) + "\n").encode())
            handle.flush()
            os.fsync(handle.fileno())
        require(current["online"], "E2E_FIXTURE_UNAVAILABLE")
        return current["secret"]

    pid = os.getpid()
    ticks = process_ticks(pid)
    require(ticks is not None, "fixture process identity is unavailable")
    descriptor = os.open(os.path.join(state_dir, "starts.jsonl"), os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        require(len(processes(state_dir)) < 32, "fixture start limit reached")
        handle.write((json.dumps({"pid": pid, "startTicks": ticks}) + "\n").encode())
        handle.flush()
        os.fsync(handle.fileno())
    server.run(transport="stdio")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "serve":
            serve(sys.argv[2])
        elif len(sys.argv) == 2 and sys.argv[1] == "control":
            data = sys.stdin.buffer.read(MAX_BYTES + 1)
            require(len(data) <= MAX_BYTES, "fixture request exceeded its bound")
            print(json.dumps(control(json.loads(data))))
        else:
            raise ValueError("unsupported fixture entry point")
    except Exception:
        # No config, credential, secret or arbitrary provider exception text
        # crosses the root CLI's evidence stream on failure.
        print("fixture operation failed; inspect the owned lab receipt", file=sys.stderr)
        sys.exit(1)
